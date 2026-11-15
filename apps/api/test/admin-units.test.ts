import { describe, expect, it } from 'vitest';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { hasPermission, permissionsFor, staffRoleFromToken } from '../src/modules/admin/roles.js';
import { decodeQueueCursor, encodeQueueCursor } from '../src/modules/admin/cursor.js';

const token = (claims: Record<string, unknown>) => ({ uid: 'u', ...claims }) as unknown as DecodedIdToken;

describe('staff role claim', () => {
  it('accepts only an exact known staffRole string', () => {
    expect(staffRoleFromToken(token({ staffRole: 'moderator' }))).toBe('moderator');
    expect(staffRoleFromToken(token({ staffRole: 'admin' }))).toBe('admin');
    for (const claims of [{}, { admin: true }, { role: 'admin' }, { staffRole: 'Admin' }, { staffRole: ['admin'] },
      { staffRole: { admin: true } }, { staffRole: 'owner' }, { staffRole: '' }, { staffRole: true }]) {
      expect(staffRoleFromToken(token(claims))).toBeNull();
    }
  });

  it('keeps moderator permissions separate from administrator permissions', () => {
    expect(permissionsFor('moderator')).toEqual(['content.review']);
    expect(hasPermission('moderator', 'account.manage')).toBe(false);
    expect(hasPermission('moderator', 'audit.read')).toBe(false);
    expect(hasPermission('admin', 'account.manage')).toBe(true);
  });
});

describe('queue cursor', () => {
  it('round-trips a position', () => {
    const at = new Date('2026-11-01T00:00:05.123Z');
    expect(decodeQueueCursor(encodeQueueCursor({ at, id: 'abc' }))).toEqual({ at, id: 'abc' });
  });

  it('rejects malformed input', () => {
    for (const raw of ['', 'zzz', Buffer.from('{}').toString('base64url'), Buffer.from('["x","id"]').toString('base64url'),
      Buffer.from('[1,""]').toString('base64url'), Buffer.from(`[1,"${'a'.repeat(129)}"]`).toString('base64url')]) {
      expect(decodeQueueCursor(raw)).toBeNull();
    }
  });
});
