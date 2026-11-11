import { describe, expect, it } from 'vitest';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { hasPermission, permissionsFor, staffRoleFromToken } from '../src/modules/admin/roles.js';
import { decodeQueueCursor, encodeQueueCursor } from '../src/modules/admin/cursor.js';
import { describePromptRejection, isPromptRejectionReason, PROMPT_REJECTION_REASONS } from '../src/modules/profiles/prompt-review.js';
import { toSelfProfileDTO, toPublicProfileDTO } from '../src/modules/profiles/dto.js';
import { createEmptyProfile, type PromptAnswerDocument } from '../src/modules/profiles/schema.js';
import type { UserDocument } from '../src/modules/auth/account.js';

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

describe('prompt rejection reasons', () => {
  it('describes catalog codes with a localization key and a replace action', () => {
    expect(describePromptRejection('promotional')).toEqual({
      code: 'promotional',
      messageKey: 'promptRejection.promotional',
      message: PROMPT_REJECTION_REASONS.promotional.message,
      action: 'replace',
    });
    expect(describePromptRejection('made_up').code).toBe('community_guidelines');
    expect(describePromptRejection(undefined).code).toBe('community_guidelines');
    expect(isPromptRejectionReason('toString')).toBe(false);
  });

  it('appear only in the owner DTO, never the public one', () => {
    const now = new Date();
    const user = { _id: 'u1', birthDate: '1994-05-12', profileReady: true } as UserDocument;
    const answer: PromptAnswerDocument = {
      _id: 'a1', ownerId: 'u1', promptId: 'prompt-home', slot: 0, approvedText: 'Published', pendingText: 'Has my number',
      state: 'rejected', revision: 2, publishedRevision: 1, rejectionReason: 'contact_details', createdAt: now, updatedAt: now,
    };
    const owner = toSelfProfileDTO(createEmptyProfile('u1'), user, [answer]);
    expect(owner.promptAnswers[0]!.rejectionReason).toMatchObject({ code: 'contact_details', action: 'replace' });
    expect(toSelfProfileDTO(createEmptyProfile('u1'), user, [{ ...answer, state: 'pending' }]).promptAnswers[0]!.rejectionReason).toBeNull();

    const publicView = JSON.stringify(toPublicProfileDTO(createEmptyProfile('u1'), user, [answer], []));
    expect(publicView).toContain('Published');
    for (const leak of ['rejection', 'contact_details', 'Has my number']) expect(publicView).not.toContain(leak);
  });
});
