/**
 * Staff API under /v1/admin. Every route verifies the Firebase ID token (with
 * revocation checks) and then the `staffRole` custom claim for the route's
 * permission. Account actions also require a recent sign-in.
 *
 * There is no admin UI in the mobile app (D-03); reviewers use this API
 * through scripts/admin-review.ts until an internal interface is approved.
 */

import { pipeline } from 'node:stream/promises';
import { Router, type NextFunction, type Request, type Response } from 'express';
import type { Auth } from 'firebase-admin/auth';
import type { Db, MongoClient } from 'mongodb';
import { z } from 'zod';
import type { Env } from '../../config.js';
import { LocalMediaStorage } from '../../adapters/media/local.js';
import type { MediaStorage } from '../../adapters/media/storage.js';
import { createAuthMiddleware } from '../auth/middleware.js';
import { VARIANT_CONTENT_TYPE } from '../media/processing.js';
import { PHOTO_VARIANTS, type PhotoVariant } from '../media/schema.js';
import { listAuditEntries, type AdminAuditEntry } from './audit.js';
import { decodeQueueCursor, type QueueCursor } from './cursor.js';
import { requireStaff, type StaffRequest } from './middleware.js';
import { NOTE_MAX_LENGTH, reasonCatalog, RESTORE_REASON_CODES, SUSPENSION_REASON_CODES } from './reasons.js';
import { permissionsFor } from './roles.js';
import { AdminError, createAdminService, type AdminServiceDeps } from './service.js';

export type AdminRoutesConfig = Pick<Env, 'MEDIA_LOCAL_DIR' | 'ADMIN_RECENT_AUTH_MAX_AGE_SECONDS'>;

export interface AdminRouteDeps extends AdminServiceDeps {
  storage?: MediaStorage;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

const note = z.string().trim().max(NOTE_MAX_LENGTH).nullish().transform((v) => (v ? v : null));

const decisionBody = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().nullish().transform((v) => v ?? null),
  note,
}).strict().superRefine((body, ctx) => {
  if (body.decision === 'reject' && !body.reason) {
    ctx.addIssue({ code: 'custom', path: ['reason'], message: 'A rejection needs a reason from the catalog' });
  }
  if (body.decision === 'approve' && body.reason) {
    ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Reasons apply to rejections only; use note for comments' });
  }
});

const promptDecisionBody = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().nullish().transform((v) => v ?? null),
  note,
  expectedRevision: z.number().int().min(1),
}).strict().superRefine((body, ctx) => {
  if (body.decision === 'reject' && !body.reason) {
    ctx.addIssue({ code: 'custom', path: ['reason'], message: 'A rejection needs a reason from the catalog' });
  }
  if (body.decision === 'approve' && body.reason) {
    ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Reasons apply to rejections only; use note for comments' });
  }
});

const suspendBody = z.object({ reason: z.enum(SUSPENSION_REASON_CODES), note }).strict();
const restoreBody = z.object({ reason: z.enum(RESTORE_REASON_CODES), note }).strict();

const auditQuery = z.object({
  targetType: z.enum(['photo', 'promptAnswer', 'user']),
  targetId: z.string().min(1).max(128),
});

function toAuditDTO(entry: AdminAuditEntry) {
  return {
    id: entry._id,
    actorUid: entry.actorUid,
    actorRole: entry.actorRole,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    targetOwnerId: entry.targetOwnerId,
    reason: entry.reason,
    note: entry.note,
    before: entry.before,
    after: entry.after,
    requestId: entry.requestId,
    createdAt: entry.createdAt,
  };
}

export function createAdminRoutes(
  db: Db,
  client: MongoClient,
  auth: Auth,
  config: AdminRoutesConfig,
  deps: AdminRouteDeps = {},
) {
  const router = Router();
  const storage = deps.storage ?? new LocalMediaStorage(config.MEDIA_LOCAL_DIR);
  const service = createAdminService(db, client, { now: deps.now, afterAuditWrite: deps.afterAuditWrite });

  const requireAuth = createAuthMiddleware(auth);
  const guard = (permission: Parameters<typeof requireStaff>[0], recentAuth = false) => [
    requireAuth,
    requireStaff(permission, {
      now: deps.now,
      recentAuthMaxAgeSeconds: recentAuth ? config.ADMIN_RECENT_AUTH_MAX_AGE_SECONDS : undefined,
    }),
  ];

  function sendError(req: Request, res: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}, retryable = false) {
    res.status(status).json({ error: { code, message, ...extra, retryable }, requestId: req.requestId });
  }

  function sendValidation(req: Request, res: Response, error: z.ZodError) {
    sendError(req, res, 422, 'VALIDATION_ERROR', 'Invalid fields', {
      fieldErrors: error.issues.map((i) => ({ field: i.path.join('.') || '(body)', message: i.message })),
    });
  }

  /** Wrap a handler: AdminError becomes its response; anything else goes to the app error handler. */
  const handle = (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) => {
      fn(req, res).catch((err: unknown) => {
        if (err instanceof AdminError) {
          sendError(req, res, err.status, err.code, err.message, err.extra, err.retryable);
          return;
        }
        next(err);
      });
    };

  /** Parse ?cursor&limit, or respond and return null. */
  function readPage(req: Request, res: Response): { cursor: QueueCursor | null; limit: number } | null {
    const rawLimit = req.query['limit'];
    let limit = DEFAULT_PAGE_SIZE;
    if (rawLimit !== undefined) {
      limit = Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
        sendError(req, res, 422, 'VALIDATION_ERROR', 'Invalid fields', {
          fieldErrors: [{ field: 'limit', message: `Integer from 1 to ${MAX_PAGE_SIZE}` }],
        });
        return null;
      }
    }
    const rawCursor = req.query['cursor'];
    if (rawCursor === undefined) return { cursor: null, limit };
    const cursor = typeof rawCursor === 'string' ? decodeQueueCursor(rawCursor) : null;
    if (!cursor) {
      sendError(req, res, 400, 'INVALID_CURSOR', 'This page link is not valid. Start from the first page.');
      return null;
    }
    return { cursor, limit };
  }

  const param = (req: Request, name: string) => String(req.params[name]);

  /** GET /v1/admin/me — the caller's verified staff role and permissions */
  router.get('/v1/admin/me', ...guard('content.review'), (req: Request, res: Response) => {
    const { staff } = req as StaffRequest;
    res.json({ data: { role: staff.role, permissions: permissionsFor(staff.role) }, meta: { requestId: req.requestId } });
  });

  /** GET /v1/admin/reasons — fixed reason catalogs for decisions */
  router.get('/v1/admin/reasons', ...guard('content.review'), (req: Request, res: Response) => {
    res.json({ data: reasonCatalog(), meta: { requestId: req.requestId } });
  });

  // --- Photos ---

  router.get('/v1/admin/content/photos', ...guard('content.review'), handle(async (req, res) => {
    const page = readPage(req, res);
    if (!page) return;
    const { items, nextCursor } = await service.listPendingPhotos(page.cursor, page.limit);
    res.json({ data: items, meta: { requestId: req.requestId, nextCursor } });
  }));

  router.get('/v1/admin/content/photos/:id', ...guard('content.review'), handle(async (req, res) => {
    const photo = await service.getPhoto(param(req, 'id'));
    if (!photo) {
      sendError(req, res, 404, 'NOT_FOUND', 'Photo not found');
      return;
    }
    res.json({ data: photo, meta: { requestId: req.requestId } });
  }));

  /** Streams a variant of any reviewable photo, pending ones included. Staff only; never cached. */
  router.get('/v1/admin/content/photos/:id/media/:variant', ...guard('content.review'), handle(async (req, res) => {
    const variant = param(req, 'variant') as PhotoVariant;
    const photo = PHOTO_VARIANTS.includes(variant) ? await service.findViewablePhoto(param(req, 'id')) : null;
    if (!photo) {
      sendError(req, res, 404, 'MEDIA_UNAVAILABLE', 'This photo is not available');
      return;
    }
    let stream;
    try {
      stream = await storage.getObjectStream(photo.variantKeys[variant]);
    } catch (err) {
      console.error(`[${req.requestId}] Admin media read failed: ${(err as Error).message}`);
      sendError(req, res, 503, 'STORAGE_UNAVAILABLE', 'This photo could not be loaded. Try again.', {}, true);
      return;
    }
    if (!stream) {
      sendError(req, res, 404, 'MEDIA_UNAVAILABLE', 'This photo is not available');
      return;
    }
    res.status(200);
    res.setHeader('Content-Type', VARIANT_CONTENT_TYPE);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      await pipeline(stream, res);
    } catch (err) {
      console.error(`[${req.requestId}] Admin media stream interrupted: ${(err as Error).message}`);
    }
  }));

  router.post('/v1/admin/content/photos/:id/review', ...guard('content.review'), handle(async (req, res) => {
    const parsed = decisionBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidation(req, res, parsed.error);
      return;
    }
    const { staff } = req as StaffRequest;
    const result = await service.decidePhoto(staff, param(req, 'id'), parsed.data, req.requestId);
    res.json({ data: result, meta: { requestId: req.requestId } });
  }));

  // --- Prompt answers ---

  router.get('/v1/admin/content/prompt-answers', ...guard('content.review'), handle(async (req, res) => {
    const page = readPage(req, res);
    if (!page) return;
    const { items, nextCursor } = await service.listPendingPromptAnswers(page.cursor, page.limit);
    res.json({ data: items, meta: { requestId: req.requestId, nextCursor } });
  }));

  router.get('/v1/admin/content/prompt-answers/:id', ...guard('content.review'), handle(async (req, res) => {
    const answer = await service.getPromptAnswer(param(req, 'id'));
    if (!answer) {
      sendError(req, res, 404, 'NOT_FOUND', 'Prompt answer not found');
      return;
    }
    res.json({ data: answer, meta: { requestId: req.requestId } });
  }));

  router.post('/v1/admin/content/prompt-answers/:id/review', ...guard('content.review'), handle(async (req, res) => {
    const parsed = promptDecisionBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidation(req, res, parsed.error);
      return;
    }
    const { staff } = req as StaffRequest;
    const result = await service.decidePromptAnswer(staff, param(req, 'id'), parsed.data, req.requestId);
    res.json({ data: result, meta: { requestId: req.requestId } });
  }));

  // --- Accounts (administrators; recent sign-in) ---

  router.get('/v1/admin/users/:id', ...guard('account.manage'), handle(async (req, res) => {
    const account = await service.getAccount(param(req, 'id'));
    if (!account) {
      sendError(req, res, 404, 'NOT_FOUND', 'Account not found');
      return;
    }
    res.json({ data: account, meta: { requestId: req.requestId } });
  }));

  router.post('/v1/admin/users/:id/suspend', ...guard('account.manage', true), handle(async (req, res) => {
    const parsed = suspendBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidation(req, res, parsed.error);
      return;
    }
    const { staff } = req as StaffRequest;
    const result = await service.suspendAccount(staff, param(req, 'id'), parsed.data, req.requestId);
    res.json({ data: result, meta: { requestId: req.requestId } });
  }));

  router.post('/v1/admin/users/:id/restore', ...guard('account.manage', true), handle(async (req, res) => {
    const parsed = restoreBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidation(req, res, parsed.error);
      return;
    }
    const { staff } = req as StaffRequest;
    const result = await service.restoreAccount(staff, param(req, 'id'), parsed.data, req.requestId);
    res.json({ data: result, meta: { requestId: req.requestId } });
  }));

  // --- Audit log (administrators; one target at a time, no bulk export) ---

  router.get('/v1/admin/audit-log', ...guard('audit.read'), handle(async (req, res) => {
    const parsed = auditQuery.safeParse(req.query);
    if (!parsed.success) {
      sendValidation(req, res, parsed.error);
      return;
    }
    const entries = await listAuditEntries(db, parsed.data.targetType, parsed.data.targetId, 100);
    res.json({ data: entries.map(toAuditDTO), meta: { requestId: req.requestId } });
  }));

  return router;
}
