/**
 * Server-managed staff roles (R-ADMIN-01, spec §4.9).
 *
 * A staff member is identified only by the `staffRole` custom claim inside a
 * Firebase ID token that the Admin SDK has verified (signature, expiry,
 * revocation). Claims can only be set with Admin SDK credentials
 * (scripts/admin-claims.ts against the emulator locally); no client, request
 * body, header or email allowlist can grant a role.
 *
 * Moderator and administrator permissions are separate: moderators review
 * content; administrators can also act on accounts and read the audit log.
 */

import type { DecodedIdToken } from 'firebase-admin/auth';

export const STAFF_ROLE_CLAIM = 'staffRole';

export const STAFF_ROLES = ['moderator', 'admin'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const PERMISSIONS = ['content.review', 'account.manage', 'audit.read'] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<StaffRole, readonly Permission[]> = {
  moderator: ['content.review'],
  admin: ['content.review', 'account.manage', 'audit.read'],
};

export function isStaffRole(value: unknown): value is StaffRole {
  return typeof value === 'string' && (STAFF_ROLES as readonly string[]).includes(value);
}

/** The verified role in a decoded token, or null. Anything but an exact known role string is ignored. */
export function staffRoleFromToken(token: DecodedIdToken): StaffRole | null {
  const claim: unknown = token[STAFF_ROLE_CLAIM];
  return isStaffRole(claim) ? claim : null;
}

export function permissionsFor(role: StaffRole): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function hasPermission(role: StaffRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
