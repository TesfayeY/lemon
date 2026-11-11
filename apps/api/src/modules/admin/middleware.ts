import type { NextFunction, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import { hasPermission, staffRoleFromToken, type Permission, type StaffRole } from './roles.js';

export interface StaffActor {
  uid: string; // verified Firebase UID; internal to the audit log, never returned to app users
  role: StaffRole;
}

export interface StaffRequest extends AuthenticatedRequest {
  staff: StaffActor;
}

export interface StaffGuardOptions {
  /** Require a sign-in within this many seconds (destructive actions, spec §4.9). */
  recentAuthMaxAgeSeconds?: number;
  now?: () => Date;
}

function deny(req: Request, res: Response, status: number, code: string, message: string) {
  res.status(status).json({ error: { code, message, retryable: false }, requestId: req.requestId });
}

/**
 * Runs after createAuthMiddleware (token verified with revocation checks).
 * Authorizes from the verified token alone; request bodies and headers are
 * never consulted for identity or role.
 */
export function requireStaff(permission: Permission, options: StaffGuardOptions = {}) {
  const now = options.now ?? (() => new Date());
  return (req: Request, res: Response, next: NextFunction): void => {
    const { uid, token } = req as AuthenticatedRequest;
    const role = token ? staffRoleFromToken(token) : null;
    if (!uid || !role) {
      deny(req, res, 403, 'STAFF_ONLY', 'This action is limited to staff');
      return;
    }
    if (token.email_verified !== true) {
      deny(req, res, 403, 'STAFF_EMAIL_UNVERIFIED', 'Verify your staff email address first');
      return;
    }
    if (!hasPermission(role, permission)) {
      deny(req, res, 403, 'INSUFFICIENT_ROLE', 'Your staff role does not allow this action');
      return;
    }
    if (options.recentAuthMaxAgeSeconds !== undefined) {
      const authTime = typeof token.auth_time === 'number' ? token.auth_time : 0;
      const ageSeconds = now().getTime() / 1000 - authTime;
      if (ageSeconds > options.recentAuthMaxAgeSeconds) {
        deny(req, res, 403, 'RECENT_AUTH_REQUIRED', 'Sign in again to continue');
        return;
      }
    }
    (req as StaffRequest).staff = { uid, role };
    next();
  };
}
