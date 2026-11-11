import { Router, type Request, type Response } from 'express';
import type { Db } from 'mongodb';
import type { Auth } from 'firebase-admin/auth';
import type { Env } from '../../config.js';
import { createAuthMiddleware, type AuthenticatedRequest } from '../auth/middleware.js';
import { canAuthenticate, canInteract, type UserDocument } from '../auth/account.js';
import { toIncomingLikeDTOs, toOutgoingLikeDTO, toQuotaDTO } from './dto.js';
import { noopPairGuard, type PairGuard } from './pair-guard.js';
import { getQuotaStatus, QUOTAS_COLLECTION, type QuotaDocument, type QuotaPolicy } from './quota.js';
import {
  declineLike, findIncomingLike, LikeError, listIncoming, sendLike, type LikeServiceDeps,
} from './service.js';
import { decodeCursor, encodeCursor, IDEMPOTENCY_KEY_PATTERN, parseLimit, parseSendLike } from './validation.js';

export type LikesRoutesConfig = Pick<Env, 'LIKES_PER_UTC_DAY'>;

export interface LikesRoutesOptions {
  /** Server clock; injectable for UTC-boundary tests */
  now?: () => Date;
  /** Block/pair checks; no-op until Phases 09 and 12 */
  pairGuard?: PairGuard;
}

/** Bump when the allowance policy changes meaning, not just its number */
const QUOTA_POLICY_VERSION = 1;

export function createLikesRoutes(db: Db, auth: Auth, config: LikesRoutesConfig, options: LikesRoutesOptions = {}) {
  const router = Router();
  const requireAuth = createAuthMiddleware(auth);
  const users = db.collection<UserDocument>('users');
  const quotas = db.collection<QuotaDocument>(QUOTAS_COLLECTION);
  const policy: QuotaPolicy = { dailyLikes: config.LIKES_PER_UTC_DAY, policyVersion: QUOTA_POLICY_VERSION };
  const deps: LikeServiceDeps = {
    db,
    policy,
    pairGuard: options.pairGuard ?? noopPairGuard,
    now: options.now ?? (() => new Date()),
  };

  function sendError(
    req: Request,
    res: Response,
    status: number,
    code: string,
    message: string,
    extra: Record<string, unknown> = {},
    retryable = false,
  ) {
    res.status(status).json({ error: { code, message, ...extra, retryable }, requestId: req.requestId });
  }

  function sendLikeError(req: Request, res: Response, err: LikeError) {
    if (err.code === 'QUOTA_EXHAUSTED') {
      const resetAt = err.details['resetAt'] as Date;
      const seconds = Math.max(1, Math.ceil((resetAt.getTime() - deps.now().getTime()) / 1000));
      res.setHeader('Retry-After', String(seconds));
    }
    sendError(req, res, err.status, err.code, err.message, err.details);
  }

  /** Run a handler, mapping LikeError to its response; anything else is a 500 */
  async function handle(req: Request, res: Response, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (err) {
      if (err instanceof LikeError) sendLikeError(req, res, err);
      else throw err;
    }
  }

  /** Resolve the caller's account, or respond and return null */
  async function loadAccount(req: Request, res: Response): Promise<UserDocument | null> {
    const { uid } = req as AuthenticatedRequest;
    const user = await users.findOne({ firebaseUid: uid });
    if (!user) {
      sendError(req, res, 404, 'NOT_FOUND', 'Account not found');
      return null;
    }
    if (!canAuthenticate(user.accountStatus)) {
      sendError(req, res, 403, 'ACCOUNT_RESTRICTED', 'This account is not available');
      return null;
    }
    return user;
  }

  /**
   * POST /v1/likes
   * Like one photo or prompt answer at a specific content version.
   */
  router.post('/v1/likes', requireAuth, async (req: Request, res: Response) => {
    const idempotencyKey = req.get('Idempotency-Key');
    if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      sendError(req, res, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'An Idempotency-Key header (8-128 letters, digits, "-" or "_") is required.');
      return;
    }

    const parsed = parseSendLike(req.body);
    if (!parsed.ok) {
      sendError(req, res, 422, 'VALIDATION_ERROR', 'Invalid fields', { fieldErrors: parsed.fieldErrors });
      return;
    }

    const sender = await loadAccount(req, res);
    if (!sender) return;

    await handle(req, res, async () => {
      const outcome = await sendLike(deps, sender, parsed.value, idempotencyKey);
      res.status(outcome.created ? 201 : 200).json({
        data: { like: toOutgoingLikeDTO(outcome.like), quota: toQuotaDTO(outcome.quota) },
        meta: { requestId: req.requestId },
      });
    });
  });

  /**
   * GET /v1/likes/quota
   * Remaining allowance for the composer; resets at UTC midnight.
   */
  router.get('/v1/likes/quota', requireAuth, async (req: Request, res: Response) => {
    const user = await loadAccount(req, res);
    if (!user) return;
    const status = await getQuotaStatus(quotas, user._id, deps.now(), policy);
    res.json({ data: toQuotaDTO(status), meta: { requestId: req.requestId } });
  });

  /**
   * GET /v1/likes/incoming?cursor=&limit=
   * Pending likes from currently available senders, newest first.
   */
  router.get('/v1/likes/incoming', requireAuth, async (req: Request, res: Response) => {
    const limit = parseLimit(req.query['limit']);
    if (limit === null) {
      sendError(req, res, 422, 'VALIDATION_ERROR', 'Invalid fields', {
        fieldErrors: [{ field: 'limit', message: 'Must be an integer from 1 to 50' }],
      });
      return;
    }
    const rawCursor = req.query['cursor'];
    const cursor = rawCursor === undefined ? null : typeof rawCursor === 'string' ? decodeCursor(rawCursor) : null;
    if (rawCursor !== undefined && cursor === null) {
      sendError(req, res, 400, 'INVALID_CURSOR', 'This list position is not valid. Reload the list.');
      return;
    }

    const recipient = await loadAccount(req, res);
    if (!recipient) return;
    // Same rule as viewing any profile (R-AUTH-08); a paused recipient can still review likes
    if (!canInteract(recipient.accountStatus) || !recipient.profileReady) {
      sendError(req, res, 403, 'ACCOUNT_NOT_ELIGIBLE', 'Complete your profile to see your likes');
      return;
    }

    const now = deps.now();
    const page = await listIncoming(deps, recipient, cursor, limit);
    res.json({
      data: { likes: await toIncomingLikeDTOs(db, recipient._id, page.items, now) },
      meta: { requestId: req.requestId, nextCursor: page.next ? encodeCursor(page.next) : null },
    });
  });

  /**
   * POST /v1/likes/:id/decline
   * Recipient only; idempotent; terminal for that direction. Charges nothing.
   */
  router.post('/v1/likes/:id/decline', requireAuth, async (req: Request, res: Response) => {
    const recipient = await loadAccount(req, res);
    if (!recipient) return;
    await handle(req, res, async () => {
      const like = await declineLike(deps, recipient, String(req.params['id']));
      res.json({
        data: { id: like._id, state: like.state, decidedAt: like.decidedAt },
        meta: { requestId: req.requestId },
      });
    });
  });

  /**
   * POST /v1/likes/:id/accept
   * Matching ships in Phase 09; until then this answers clearly instead of pretending.
   */
  router.post('/v1/likes/:id/accept', requireAuth, async (req: Request, res: Response) => {
    const recipient = await loadAccount(req, res);
    if (!recipient) return;
    await handle(req, res, async () => {
      await findIncomingLike(deps, recipient, String(req.params['id']));
      sendError(req, res, 501, 'ACCEPT_NOT_AVAILABLE', 'Accepting likes is not available yet.');
    });
  });

  return router;
}
