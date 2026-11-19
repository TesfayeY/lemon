import type { Request, Response, NextFunction } from 'express';
import type { Auth, DecodedIdToken } from 'firebase-admin/auth';
import { sendRateLimited } from '../rate-limit/http.js';
import { getRequestRateLimiter, type RequestRateLimiter } from '../rate-limit/token-bucket.js';

export interface AuthenticatedRequest extends Request {
  uid: string;
  token: DecodedIdToken;
}

export interface AuthMiddlewareOptions {
  /**
   * Per-account request limit, checked once the token is verified. Defaults to
   * the process-wide limiter that src/index.ts installs from config
   * (`installRequestRateLimit`); when none is installed (tests, scripts) there
   * is no generic limit. Pass null to opt out.
   */
  requestLimiter?: RequestRateLimiter | null;
}

/**
 * Verifies Firebase ID token from the Authorization header.
 * Attaches uid and decoded token to the request.
 * Never trusts a UID sent in the request body.
 * Then spends one request from the account's generic rate limit (429 RATE_LIMITED).
 */
export function createAuthMiddleware(auth: Auth, options: AuthMiddlewareOptions = {}) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.headers.authorization;

    if (!header || !header.startsWith('Bearer ')) {
      res.status(401).json({
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Missing or invalid Authorization header',
          retryable: false,
        },
        requestId: req.requestId,
      });
      return;
    }

    const idToken = header.slice(7);

    let decoded: DecodedIdToken;
    try {
      // checkRevoked: true also rejects revoked sessions (auth/id-token-revoked) and
      // disabled Firebase users (auth/user-disabled). App suspension is not visible
      // here: each module checks the loaded account's status (canAuthenticate/canInteract).
      decoded = await auth.verifyIdToken(idToken, true);
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === 'auth/id-token-revoked') {
        res.status(401).json({
          error: {
            code: 'TOKEN_REVOKED',
            message: 'Your session has expired. Please sign in again.',
            retryable: false,
          },
          requestId: req.requestId,
        });
        return;
      }

      res.status(401).json({
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Invalid or expired token',
          retryable: false,
        },
        requestId: req.requestId,
      });
      return;
    }

    (req as AuthenticatedRequest).uid = decoded.uid;
    (req as AuthenticatedRequest).token = decoded;

    // Coarse per-process safety net (rate-limit/token-bucket.ts), keyed by the verified UID
    const limiter = options.requestLimiter === undefined ? getRequestRateLimiter() : options.requestLimiter;
    const decision = limiter?.take(decoded.uid);
    if (decision && !decision.ok) {
      sendRateLimited(req, res, decision.retryAfterSeconds);
      return;
    }

    next();
  };
}
