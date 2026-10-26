import { describe, it, expect } from 'vitest';
import { buildSeedDocuments } from '../src/dev/seed-data.js';
import {
  validateDisplayName, validateGenderIdentity, validateIntention, validateCity,
  validateBio, validateLanguages, validateOptionalText, validatePromptId, validatePromptAnswer,
} from '../src/modules/profiles/validation.js';
import { isValidGenderId } from '../src/modules/catalogs/data.js';
import { parseBirthDate, isAdultEligible } from '../src/modules/auth/adult-gate.js';
import { MIN_AGE, MAX_AGE } from '../src/modules/preferences/schema.js';

const docs = buildSeedDocuments();

describe('Fictional seed profiles', () => {
  it('pass the same validation real edits do', () => {
    for (const p of docs.profiles) {
      expect([
        validateDisplayName(p.displayName), validateGenderIdentity(p.genderIdentity),
        validateIntention(p.intention), validateCity(p.cityId), validateBio(p.bio),
        validateLanguages(p.languages), validateOptionalText(p.occupation, 'occupation'),
      ].filter(Boolean), p.userId).toEqual([]);
    }
  });

  it('are all adults with valid birth dates', () => {
    for (const u of docs.users) {
      const parsed = parseBirthDate(u.birthDate!);
      expect(parsed.valid, u._id).toBe(true);
      if (parsed.valid) expect(isAdultEligible(parsed.date), u._id).toBe(true);
    }
  });

  it('have valid preferences', () => {
    for (const p of docs.preferences) {
      expect(p.acceptedGenderCategories.length).toBeGreaterThan(0);
      expect(p.acceptedGenderCategories.every(isValidGenderId)).toBe(true);
      expect(p.minAge).toBeGreaterThanOrEqual(MIN_AGE);
      expect(p.maxAge).toBeLessThanOrEqual(MAX_AGE);
      expect(p.minAge).toBeLessThanOrEqual(p.maxAge);
    }
  });

  it('have exactly three distinct valid prompt answers each', () => {
    for (const u of docs.users) {
      const answers = docs.promptAnswers.filter(a => a.ownerId === u._id);
      expect(answers).toHaveLength(3);
      expect(new Set(answers.map(a => a.promptId)).size).toBe(3);
      expect(answers.map(a => a.slot).sort()).toEqual([0, 1, 2]);
      for (const a of answers) {
        expect(validatePromptId(a.promptId)).toBeNull();
        expect(validatePromptAnswer(a.approvedText)).toBeNull();
      }
    }
  });

  it('use stable, clearly fictional IDs that never collide', () => {
    for (const list of Object.values(docs)) {
      const ids = list.map((d: { _id: string }) => d._id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.every((id: string) => id.startsWith('seed-'))).toBe(true);
    }
    expect(docs.users.every(u => u.firebaseUid.startsWith('seed-'))).toBe(true);
  });

  it('are not marked ready or active: readiness stays server-computed', () => {
    expect(docs.users.every(u => !u.profileReady && u.accountStatus === 'onboarding')).toBe(true);
  });
});
