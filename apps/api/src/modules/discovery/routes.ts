import { Router, type Request, type Response } from 'express';
import type { Db } from 'mongodb';
import type { Auth } from 'firebase-admin/auth';
import { z } from 'zod';
import { createAuthMiddleware, type AuthenticatedRequest } from '../auth/middleware.js';
import type { UserDocument } from '../auth/account.js';
import type { Env } from '../../config.js';
import { resolveCursorSecret } from './cursor.js';
import { createDiscoveryService, DiscoveryError, type DiscoveryOptions } from './service.js';

export type DiscoveryRoutesConfig = Pick<Env, 'NODE_ENV' | 'DISCOVERY_CURSOR_SECRET' | 'PASS_COOLDOWN_DAYS'>;

/** Test seams (clock, seed, exclusions, catalog, sizes); production uses the defaults. */
export type DiscoveryRouteOverrides = Omit<DiscoveryOptions, 'cursorSecret' | 'passCooldownDays'>;

const passBody = z.object({ candidateId: z.string().min(1).max(128) }).strict();

export function createDiscoveryRoutes(
  db: Db,
  auth: Auth,
  config: DiscoveryRoutesConfig,
  overrides: DiscoveryRouteOverrides = {},
) {
  const router = Router();
  const requireAuth = createAuthMiddleware(auth);
  const users = db.collection<UserDocument>('users');
  const service = createDiscoveryService(db, {
    ...overrides,
    cursorSecret: resolveCursorSecret(config.DISCOVERY_CURSOR_SECRET, config.NODE_ENV),
    passCooldownDays: config.PASS_COOLDOWN_DAYS,
  });

  function sendError(req: Request, res: Response, err: DiscoveryError) {
    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        retryable: err.retryable,
        ...(err.fieldErrors ? { fieldErrors: err.fieldErrors } : {}),
      },
      requestId: req.requestId,
    });
  }

  async function loadUser(req: Request, res: Response): Promise<UserDocument | null> {
    const { uid } = req as AuthenticatedRequest;
    const user = await users.findOne({ firebaseUid: uid });
    if (!user) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Account not found', retryable: false },
        requestId: req.requestId,
      });
    }
    return user;
  }

  /**
   * GET /v1/discovery[?cursor=...]
   * Without a cursor: start a new session. With one: continue it.
   */
  router.get('/v1/discovery', requireAuth, async (req: Request, res: Response) => {
    const user = await loadUser(req, res);
    if (!user) return;

    const raw = req.query['cursor'];
    if (raw !== undefined && typeof raw !== 'string') {
      sendError(req, res, new DiscoveryError(400, 'INVALID_CURSOR', 'This page link is not valid. Refresh Discover.'));
      return;
    }

    try {
      const page = await service.getPage(user, raw);
      res.json({
        data: { items: page.items, status: page.status, preferencesRevision: page.preferencesRevision },
        meta: { requestId: req.requestId, nextCursor: page.nextCursor },
      });
    } catch (err) {
      if (err instanceof DiscoveryError) sendError(req, res, err);
      else throw err;
    }
  });

  /**
   * POST /v1/passes { candidateId }
   * Hide a candidate from the viewer's Discover for the cooldown. Idempotent.
   */
  router.post('/v1/passes', requireAuth, async (req: Request, res: Response) => {
    const user = await loadUser(req, res);
    if (!user) return;

    const parsed = passBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(req, res, new DiscoveryError(422, 'VALIDATION_ERROR', 'Invalid fields', false,
        parsed.error.issues.map((i) => ({ field: i.path.join('.') || 'body', message: i.message }))));
      return;
    }

    try {
      const result = await service.pass(user, parsed.data.candidateId);
      res.json({
        data: {
          candidateId: result.candidateId,
          passedAt: result.passedAt.toISOString(),
          expiresAt: result.expiresAt.toISOString(),
        },
        meta: { requestId: req.requestId },
      });
    } catch (err) {
      if (err instanceof DiscoveryError) sendError(req, res, err);
      else throw err;
    }
  });

  return router;
}
