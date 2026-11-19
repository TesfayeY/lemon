import type { Request, Response } from 'express';
import type { Collection } from 'mongodb';
import type { AuthenticatedRequest } from './middleware.js';
import { canAuthenticate, type UserDocument } from './account.js';

/**
 * Load the caller's own account for an own-resource route, or answer and
 * return null:
 * - 404 `NOT_FOUND` when the verified identity has no app account yet;
 * - 403 `ACCOUNT_RESTRICTED` when the account may not sign in (suspended,
 *   being deleted or deleted).
 *
 * MongoDB status is authoritative: a suspended person whose Firebase session
 * has not ended yet still gets 403 here.
 */
export async function loadOwnAccount(
  users: Collection<UserDocument>,
  req: Request,
  res: Response,
): Promise<UserDocument | null> {
  const { uid } = req as AuthenticatedRequest;
  const user = await users.findOne({ firebaseUid: uid });
  if (!user) {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'Account not found', retryable: false },
      requestId: req.requestId,
    });
    return null;
  }
  if (!canAuthenticate(user.accountStatus)) {
    res.status(403).json({
      error: { code: 'ACCOUNT_RESTRICTED', message: 'This account is not available', retryable: false },
      requestId: req.requestId,
    });
    return null;
  }
  return user;
}
