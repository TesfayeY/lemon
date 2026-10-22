import type { Request, Response, NextFunction } from 'express';
import type { Auth, DecodedIdToken } from 'firebase-admin/auth';

export interface AuthenticatedRequest extends Request {
  uid: string;
  token: DecodedIdToken;
}

/**
 * Verifies Firebase ID token from the Authorization header.
 * Attaches uid and decoded token to the request.
 * Never trusts a UID sent in the request body.
 */
export function createAuthMiddleware(auth: Auth) {
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

    try {
      // checkRevoked: true ensures suspended/disabled tokens are caught
      const decoded = await auth.verifyIdToken(idToken, true);
      (req as AuthenticatedRequest).uid = decoded.uid;
      (req as AuthenticatedRequest).token = decoded;
      next();
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
    }
  };
}
