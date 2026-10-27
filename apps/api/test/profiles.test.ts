import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import type { Auth } from 'firebase-admin/auth';
import { buildApp, createInMemoryDb, createMultiUserAuth, withInsertBarrier } from './support.js';
import type { Db } from 'mongodb';
import { graphemeLength, normalizeWhitespace } from '../src/modules/profiles/schema.js';
import { checkReadiness } from '../src/modules/profiles/readiness.js';
import { toPublicProfileDTO } from '../src/modules/profiles/dto.js';
import { calculateAge } from '../src/modules/auth/adult-gate.js';
import type { PromptAnswerDocument } from '../src/modules/profiles/schema.js';
import type { UserDocument } from '../src/modules/auth/account.js';
import type { ProfileDocument } from '../src/modules/profiles/schema.js';

async function bootstrapUser(app: ReturnType<typeof buildApp>) {
  await request(app)
    .post('/v1/me/bootstrap')
    .set('Authorization', 'Bearer valid-token');
}

// --- Tests ---

describe('graphemeLength', () => {
  it('counts ASCII characters', () => {
    expect(graphemeLength('hello')).toBe(5);
  });

  it('counts Ethiopic characters correctly', () => {
    // ሰላም (selam) = 3 grapheme clusters
    expect(graphemeLength('ሰላም')).toBe(3);
  });

  it('counts emoji as single graphemes', () => {
    expect(graphemeLength('👨‍👩‍👧‍👦')).toBe(1);
    expect(graphemeLength('🇪🇹')).toBe(1);
  });

  it('handles mixed content', () => {
    expect(graphemeLength('Hi ሰላም 👋')).toBe(8);
  });
});

describe('normalizeWhitespace', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeWhitespace('  hello   world  ')).toBe('hello world');
  });
});

describe('GET /v1/catalogs', () => {
  it('returns all catalog data', async () => {
    const app = buildApp();
    const res = await request(app).get('/v1/catalogs');

    expect(res.status).toBe(200);
    expect(res.body.data.states.length).toBeGreaterThan(0);
    expect(res.body.data.cities.length).toBeGreaterThan(0);
    expect(res.body.data.prompts.length).toBeGreaterThan(0);
    expect(res.body.data.intentions.length).toBeGreaterThan(0);
    expect(res.body.data.genderCategories.length).toBeGreaterThan(0);
  });

  it('only returns active prompts', async () => {
    const app = buildApp();
    const res = await request(app).get('/v1/catalogs');
    const prompts = res.body.data.prompts;
    expect(prompts.every((p: { active: boolean }) => p.active)).toBe(true);
  });

  it('cities have distinct IDs for same name in different states', async () => {
    const app = buildApp();
    const res = await request(app).get('/v1/catalogs');
    const ids = res.body.data.cities.map((c: { id: string }) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('PATCH /v1/me/profile', () => {
  it('sets displayName with Unicode support', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    const res = await request(app)
      .patch('/v1/me/profile')
      .set('Authorization', 'Bearer valid-token')
      .send({ expectedRevision: 1, displayName: 'ሰላም' });

    expect(res.status).toBe(200);
    expect(res.body.data.updated).toContain('displayName');
  });

  it('rejects displayName over 40 grapheme clusters', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    const longName = 'a'.repeat(41);
    const res = await request(app)
      .patch('/v1/me/profile')
      .set('Authorization', 'Bearer valid-token')
      .send({ expectedRevision: 1, displayName: longName });

    expect(res.status).toBe(422);
  });

  it('sets location from valid city ID', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    const res = await request(app)
      .patch('/v1/me/profile')
      .set('Authorization', 'Bearer valid-token')
      .send({ expectedRevision: 1, cityId: 'city-seattle-wa' });

    expect(res.status).toBe(200);
    expect(res.body.data.updated).toContain('cityId');
  });

  it('rejects unknown city ID', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    const res = await request(app)
      .patch('/v1/me/profile')
      .set('Authorization', 'Bearer valid-token')
      .send({ expectedRevision: 1, cityId: 'city-nonexistent' });

    expect(res.status).toBe(422);
  });

  it('rejects unknown gender identity', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    const res = await request(app)
      .patch('/v1/me/profile')
      .set('Authorization', 'Bearer valid-token')
      .send({ expectedRevision: 1, genderIdentity: 'invalid' });

    expect(res.status).toBe(422);
  });

  it('detects revision conflict', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    // First update
    await request(app)
      .patch('/v1/me/profile')
      .set('Authorization', 'Bearer valid-token')
      .send({ expectedRevision: 1, displayName: 'First' });

    // Stale revision
    const res = await request(app)
      .patch('/v1/me/profile')
      .set('Authorization', 'Bearer valid-token')
      .send({ displayName: 'Second', expectedRevision: 1 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REVISION_CONFLICT');
  });

  it('sets visibility to private for optional fields', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    const res = await request(app)
      .patch('/v1/me/profile')
      .set('Authorization', 'Bearer valid-token')
      .send({ expectedRevision: 1, religionDisplay: 'private' });

    expect(res.status).toBe(200);
  });

  it('rejects invalid visibility value', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    const res = await request(app)
      .patch('/v1/me/profile')
      .set('Authorization', 'Bearer valid-token')
      .send({ expectedRevision: 1, religionDisplay: 'maybe' });

    expect(res.status).toBe(422);
  });
});

describe('POST /v1/me/prompts', () => {
  it('adds a prompt answer', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    const res = await request(app)
      .post('/v1/me/prompts')
      .set('Authorization', 'Bearer valid-token')
      .send({ promptId: 'prompt-tradition', text: 'Ethiopian coffee ceremony' });

    expect(res.status).toBe(201);
    expect(res.body.data.promptId).toBe('prompt-tradition');
  });

  it('rejects duplicate prompt', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    await request(app)
      .post('/v1/me/prompts')
      .set('Authorization', 'Bearer valid-token')
      .send({ promptId: 'prompt-tradition', text: 'Answer 1' });

    const res = await request(app)
      .post('/v1/me/prompts')
      .set('Authorization', 'Bearer valid-token')
      .send({ promptId: 'prompt-tradition', text: 'Answer 2' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_PROMPT');
  });

  it('rejects more than 3 prompts', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    await request(app).post('/v1/me/prompts').set('Authorization', 'Bearer valid-token')
      .send({ promptId: 'prompt-tradition', text: 'A1' });
    await request(app).post('/v1/me/prompts').set('Authorization', 'Bearer valid-token')
      .send({ promptId: 'prompt-home', text: 'A2' });
    await request(app).post('/v1/me/prompts').set('Authorization', 'Bearer valid-token')
      .send({ promptId: 'prompt-sunday', text: 'A3' });

    const res = await request(app).post('/v1/me/prompts').set('Authorization', 'Bearer valid-token')
      .send({ promptId: 'prompt-song', text: 'A4' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PROMPT_LIMIT');
  });

  it('never exceeds 3 answers when different prompts are submitted concurrently', async () => {
    const prompts = ['prompt-tradition', 'prompt-home', 'prompt-sunday', 'prompt-song', 'prompt-travel', 'prompt-cooking'];
    const db = createInMemoryDb();
    const app = buildApp(undefined, withInsertBarrier(db, 'promptAnswers', prompts.length));
    await bootstrapUser(app);

    const results = await Promise.all(prompts.map(promptId =>
      request(app).post('/v1/me/prompts').set('Authorization', 'Bearer valid-token').send({ promptId, text: 'Answer' })));

    expect(results.filter(r => r.status === 201)).toHaveLength(3);
    expect(results.filter(r => r.status !== 201).every(r => r.body.error.code === 'PROMPT_LIMIT')).toBe(true);
    const user = await db.collection<UserDocument>('users').findOne({ firebaseUid: 'firebase-uid-1' });
    expect(await db.collection('promptAnswers').countDocuments({ ownerId: user!._id })).toBe(3);
  });

  it('accepts only one of several concurrent answers to the same prompt', async () => {
    const db = createInMemoryDb();
    const app = buildApp(undefined, withInsertBarrier(db, 'promptAnswers', 3));
    await bootstrapUser(app);

    const results = await Promise.all([1, 2, 3].map(n =>
      request(app).post('/v1/me/prompts').set('Authorization', 'Bearer valid-token')
        .send({ promptId: 'prompt-tradition', text: `Answer ${n}` })));

    expect(results.map(r => r.status).sort()).toEqual([201, 409, 409]);
    expect(results.filter(r => r.status === 409).every(r => r.body.error.code === 'DUPLICATE_PROMPT')).toBe(true);
  });

  it('frees a slot when an answer is deleted', async () => {
    const app = buildApp();
    await bootstrapUser(app);
    const post = (promptId: string) =>
      request(app).post('/v1/me/prompts').set('Authorization', 'Bearer valid-token').send({ promptId, text: 'Answer' });

    const first = await post('prompt-tradition');
    await post('prompt-home');
    await post('prompt-sunday');
    expect((await post('prompt-song')).status).toBe(422);

    await request(app).delete(`/v1/me/prompts/${first.body.data.id}`).set('Authorization', 'Bearer valid-token');
    expect((await post('prompt-song')).status).toBe(201);
    expect((await post('prompt-travel')).status).toBe(422);
  });

  it('counts an answer saved before slots existed toward the limit', async () => {
    const db = createInMemoryDb();
    const app = buildApp(undefined, db);
    await bootstrapUser(app);
    const user = await db.collection<UserDocument>('users').findOne({ firebaseUid: 'firebase-uid-1' });
    // Shape written before review-gated prompts: auto-approved text, no slot
    await db.collection('promptAnswers').insertOne({
      _id: 'legacy-1', ownerId: user!._id, promptId: 'prompt-tradition', text: 'Buna',
      state: 'approved', publishedRevision: 1, createdAt: new Date(), updatedAt: new Date(),
    });
    const post = (promptId: string) =>
      request(app).post('/v1/me/prompts').set('Authorization', 'Bearer valid-token').send({ promptId, text: 'Answer' });

    expect((await post('prompt-home')).status).toBe(201);
    expect((await post('prompt-sunday')).status).toBe(201);
    const fourth = await post('prompt-song');
    expect(fourth.status).toBe(422);
    expect(fourth.body.error.code).toBe('PROMPT_LIMIT');
  });

  it('rejects unknown prompt ID', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    const res = await request(app)
      .post('/v1/me/prompts')
      .set('Authorization', 'Bearer valid-token')
      .send({ promptId: 'prompt-fake', text: 'Answer' });

    expect(res.status).toBe(422);
  });

  it('rejects answer over 300 grapheme clusters', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    const res = await request(app)
      .post('/v1/me/prompts')
      .set('Authorization', 'Bearer valid-token')
      .send({ promptId: 'prompt-tradition', text: 'a'.repeat(301) });

    expect(res.status).toBe(422);
  });
});

describe('PATCH /v1/me/preferences', () => {
  it('updates age range', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    const res = await request(app)
      .patch('/v1/me/preferences')
      .set('Authorization', 'Bearer valid-token')
      .send({ expectedRevision: 1, minAge: 22, maxAge: 35 });

    expect(res.status).toBe(200);
    expect(res.body.data.updated).toContain('minAge');
    expect(res.body.data.updated).toContain('maxAge');
  });

  it('rejects minAge below 18', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    const res = await request(app)
      .patch('/v1/me/preferences')
      .set('Authorization', 'Bearer valid-token')
      .send({ expectedRevision: 1, minAge: 16 });

    expect(res.status).toBe(422);
  });

  it('rejects minAge > maxAge', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    const res = await request(app)
      .patch('/v1/me/preferences')
      .set('Authorization', 'Bearer valid-token')
      .send({ expectedRevision: 1, minAge: 40, maxAge: 25 });

    expect(res.status).toBe(422);
  });

  it('sets gender preferences', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    const res = await request(app)
      .patch('/v1/me/preferences')
      .set('Authorization', 'Bearer valid-token')
      .send({ expectedRevision: 1, acceptedGenderCategories: ['woman', 'nonbinary'] });

    expect(res.status).toBe(200);
  });

  it('rejects unknown gender in preferences', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    const res = await request(app)
      .patch('/v1/me/preferences')
      .set('Authorization', 'Bearer valid-token')
      .send({ expectedRevision: 1, acceptedGenderCategories: ['unicorn'] });

    expect(res.status).toBe(422);
  });

  it('sets location scope', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    const res = await request(app)
      .patch('/v1/me/preferences')
      .set('Authorization', 'Bearer valid-token')
      .send({ expectedRevision: 1, locationScope: 'nationwide' });

    expect(res.status).toBe(200);
  });

  it('rejects invalid location scope', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    const res = await request(app)
      .patch('/v1/me/preferences')
      .set('Authorization', 'Bearer valid-token')
      .send({ expectedRevision: 1, locationScope: 'global' });

    expect(res.status).toBe(422);
  });
});

describe('Public profile DTO', () => {
  it('excludes private fields from public view', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    // Set up a profile with private fields
    await request(app)
      .patch('/v1/me/profile')
      .set('Authorization', 'Bearer valid-token')
      .send({
        expectedRevision: 1,
        displayName: 'Tesfa',
        genderIdentity: 'man',
        cityId: 'city-seattle-wa',
        intention: 'serious',
        religion: 'Orthodox',
        religionDisplay: 'private',
      });

    // Owner view shows everything, including visibility settings
    const own = await request(app)
      .get('/v1/me/profile')
      .set('Authorization', 'Bearer valid-token');

    expect(own.status).toBe(200);
    expect(own.body.data.religion).toBe('Orthodox');
    expect(own.body.data.religionDisplay).toBe('private');

    // Preview is exactly what other people would see
    const preview = await request(app)
      .get('/v1/me/profile/preview')
      .set('Authorization', 'Bearer valid-token');

    expect(preview.status).toBe(200);
    expect(preview.body.data.displayName).toBe('Tesfa');
    expect(preview.body.data.religion).toBeNull();
    expect(preview.body.data).not.toHaveProperty('religionDisplay');
    expect(preview.body.data).not.toHaveProperty('revision');
    expect(JSON.stringify(preview.body.data)).not.toContain('Orthodox');
  });
});

describe('checkReadiness', () => {
  const baseUser: UserDocument = {
    _id: 'u1',
    firebaseUid: 'fuid1',
    accountStatus: 'active',
    emailVerified: true,
    birthDate: '1990-06-15',
    adultEligible: true,
    discoverPaused: false,
    profileReady: false,
    guardVersion: 1,
    agreements: { termsVersion: '1.0', acceptedAt: new Date() },
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const baseProfile: ProfileDocument = {
    _id: 'u1',
    userId: 'u1',
    displayName: 'Tesfa',
    genderIdentity: 'man',
    genderDisplay: 'public',
    cityId: 'city-seattle-wa',
    stateCode: 'WA',
    countryCode: 'US',
    intention: 'serious',
    bio: null,
    hometown: null,
    hometownDisplay: 'private',
    occupation: null,
    occupationDisplay: 'private',
    education: null,
    educationDisplay: 'private',
    height: null,
    heightDisplay: 'private',
    languages: [],
    languagesDisplay: 'public',
    religion: null,
    religionDisplay: 'private',
    revision: 1,
    publishedRevision: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('returns ready when all requirements are met', () => {
    const result = checkReadiness(baseUser, baseProfile, { interests: 1, approvedPhotos: 3, approvedAnswers: 3 });
    expect(result.ready).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('reports missing email verification', () => {
    const result = checkReadiness({ ...baseUser, emailVerified: false }, baseProfile, { interests: 1, approvedPhotos: 3, approvedAnswers: 3 });
    expect(result.ready).toBe(false);
    expect(result.missing).toContain('emailVerified');
  });

  it('reports missing photos', () => {
    const result = checkReadiness(baseUser, baseProfile, { interests: 1, approvedPhotos: 2, approvedAnswers: 3 });
    expect(result.ready).toBe(false);
    expect(result.missing).toContain('photos');
  });

  it('reports missing prompt answers', () => {
    const result = checkReadiness(baseUser, baseProfile, { interests: 1, approvedPhotos: 3, approvedAnswers: 1 });
    expect(result.ready).toBe(false);
    expect(result.missing).toContain('promptAnswers');
  });

  it('reports missing displayName', () => {
    const result = checkReadiness(baseUser, { ...baseProfile, displayName: null }, { interests: 1, approvedPhotos: 3, approvedAnswers: 3 });
    expect(result.ready).toBe(false);
    expect(result.missing).toContain('displayName');
  });

  it('reports suspended account', () => {
    const result = checkReadiness({ ...baseUser, accountStatus: 'suspended' as const }, baseProfile, { interests: 1, approvedPhotos: 3, approvedAnswers: 3 });
    expect(result.ready).toBe(false);
    expect(result.missing).toContain('accountSuspended');
  });

  it('reports all missing fields at once', () => {
    const result = checkReadiness(
      { ...baseUser, emailVerified: false, adultEligible: false },
      { ...baseProfile, displayName: null, cityId: null },
      { interests: 0, approvedPhotos: 0, approvedAnswers: 0 },
    );
    expect(result.ready).toBe(false);
    expect(result.missing.length).toBeGreaterThanOrEqual(4);
  });

  const counts = { interests: 1, approvedPhotos: 3, approvedAnswers: 3 };
  it.each([
    ['adultEligible', { ...baseUser, adultEligible: false }, baseProfile, counts],
    ['termsAccepted', { ...baseUser, agreements: { termsVersion: null, acceptedAt: null } }, baseProfile, counts],
    ['genderIdentity', baseUser, { ...baseProfile, genderIdentity: null }, counts],
    ['interests', baseUser, baseProfile, { ...counts, interests: 0 }],
    ['location', baseUser, { ...baseProfile, cityId: null }, counts],
    ['intention', baseUser, { ...baseProfile, intention: null }, counts],
  ] as const)('reports missing %s', (key, user, profile, c) => {
    const result = checkReadiness(user as UserDocument, profile as ProfileDocument, c);
    expect(result.ready).toBe(false);
    expect(result.missing).toEqual([key]);
  });
});

describe('Revision safety (two devices)', () => {
  it('requires expectedRevision on profile edits', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    const res = await request(app)
      .patch('/v1/me/profile')
      .set('Authorization', 'Bearer valid-token')
      .send({ displayName: 'NoRevision' });

    expect(res.status).toBe(422);
    expect(res.body.error.fieldErrors[0].field).toBe('expectedRevision');
  });

  it('lets the first device win and tells the second the current revision', async () => {
    const app = buildApp();
    await bootstrapUser(app);
    const edit = (body: Record<string, unknown>) =>
      request(app).patch('/v1/me/profile').set('Authorization', 'Bearer valid-token').send(body);

    // Both devices loaded revision 1
    const deviceA = await edit({ expectedRevision: 1, displayName: 'Phone' });
    const deviceB = await edit({ expectedRevision: 1, displayName: 'Tablet' });

    expect(deviceA.status).toBe(200);
    expect(deviceA.body.data.revision).toBe(2);
    expect(deviceB.status).toBe(409);
    expect(deviceB.body.error.currentRevision).toBe(2);

    // Device B refreshes and reapplies
    const retry = await edit({ expectedRevision: 2, displayName: 'Tablet' });
    expect(retry.status).toBe(200);

    const own = await request(app).get('/v1/me/profile').set('Authorization', 'Bearer valid-token');
    expect(own.body.data.displayName).toBe('Tablet');
    expect(own.body.data.revision).toBe(3);
  });

  it('requires expectedRevision and rejects stale preference edits', async () => {
    const app = buildApp();
    await bootstrapUser(app);
    const edit = (body: Record<string, unknown>) =>
      request(app).patch('/v1/me/preferences').set('Authorization', 'Bearer valid-token').send(body);

    expect((await edit({ minAge: 25 })).status).toBe(422);
    expect((await edit({ expectedRevision: 1, minAge: 25 })).status).toBe(200);

    const stale = await edit({ expectedRevision: 1, maxAge: 40 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.currentRevision).toBe(2);
  });

  it('returns revision 1 from the owner view before the first edit', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    const own = await request(app).get('/v1/me/profile').set('Authorization', 'Bearer valid-token');
    expect(own.status).toBe(200);
    expect(own.body.data.revision).toBe(1);
  });
});

describe('Server-owned fields', () => {
  const serverOwned = {
    profileReady: true,
    accountStatus: 'active',
    role: 'admin',
    revision: 99,
    publishedRevision: 5,
    state: 'approved',
    guardVersion: 42,
    userId: 'someone-else',
  };

  it('ignores readiness, status, role and revision fields on profile edits', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    const res = await request(app)
      .patch('/v1/me/profile')
      .set('Authorization', 'Bearer valid-token')
      .send({ expectedRevision: 1, ...serverOwned });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_UPDATES');

    const me = await request(app).get('/v1/me').set('Authorization', 'Bearer valid-token');
    expect(me.body.data.accountStatus).toBe('onboarding');
    expect(me.body.data.profileReady).toBe(false);

    const own = await request(app).get('/v1/me/profile').set('Authorization', 'Bearer valid-token');
    expect(own.body.data.revision).toBe(1);
  });

  it('ignores server-owned fields on preference edits', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    const res = await request(app)
      .patch('/v1/me/preferences')
      .set('Authorization', 'Bearer valid-token')
      .send({ expectedRevision: 1, ...serverOwned });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_UPDATES');
  });

  it('cannot set a prompt answer state or revision', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    const res = await request(app)
      .post('/v1/me/prompts')
      .set('Authorization', 'Bearer valid-token')
      .send({ promptId: 'prompt-tradition', text: 'Coffee', state: 'rejected', publishedRevision: 9, ownerId: 'x' });

    expect(res.status).toBe(201);
    expect(res.body.data.state).toBe('pending');
    expect(res.body.data.revision).toBe(1);
  });
});

describe('Own-resource authorization', () => {
  it('cannot delete another user\'s prompt answer', async () => {
    const app = buildApp(createMultiUserAuth());
    for (const t of ['token-alice', 'token-bob']) {
      await request(app).post('/v1/me/bootstrap').set('Authorization', `Bearer ${t}`);
    }

    const created = await request(app)
      .post('/v1/me/prompts')
      .set('Authorization', 'Bearer token-alice')
      .send({ promptId: 'prompt-tradition', text: 'Buna' });

    const res = await request(app)
      .delete(`/v1/me/prompts/${created.body.data.id}`)
      .set('Authorization', 'Bearer token-bob');
    expect(res.status).toBe(404);

    const own = await request(app).get('/v1/me/profile').set('Authorization', 'Bearer token-alice');
    expect(own.body.data.promptAnswers).toHaveLength(1);
  });

  it('blocks viewers who are not active and ready from viewing profiles', async () => {
    const app = buildApp(createMultiUserAuth());
    await request(app).post('/v1/me/bootstrap').set('Authorization', 'Bearer token-alice');

    const res = await request(app)
      .get('/v1/profiles/any-user-id')
      .set('Authorization', 'Bearer token-alice');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_NOT_ELIGIBLE');
  });
});

describe('Guard version', () => {
  async function guardVersion(db: Db): Promise<number> {
    const user = await db.collection('users').findOne({ firebaseUid: 'firebase-uid-1' });
    return user!['guardVersion'] as number;
  }

  it('increments when eligibility-affecting fields change', async () => {
    const db = createInMemoryDb();
    const app = buildApp(undefined, db);
    await bootstrapUser(app);
    const start = await guardVersion(db);

    await request(app).patch('/v1/me/profile').set('Authorization', 'Bearer valid-token')
      .send({ expectedRevision: 1, bio: 'Loves injera' });
    expect(await guardVersion(db)).toBe(start);

    await request(app).patch('/v1/me/profile').set('Authorization', 'Bearer valid-token')
      .send({ expectedRevision: 2, cityId: 'city-seattle-wa' });
    expect(await guardVersion(db)).toBe(start + 1);

    await request(app).patch('/v1/me/preferences').set('Authorization', 'Bearer valid-token')
      .send({ expectedRevision: 1, acceptedGenderCategories: ['woman'] });
    expect(await guardVersion(db)).toBe(start + 2);
  });
});

describe('toPublicProfileDTO', () => {
  const user: UserDocument = {
    _id: 'u1',
    firebaseUid: 'firebase-secret-uid',
    accountStatus: 'active',
    emailVerified: true,
    birthDate: '1990-06-15',
    adultEligible: true,
    discoverPaused: false,
    profileReady: true,
    guardVersion: 7,
    agreements: { termsVersion: '1.0', acceptedAt: new Date() },
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const profile: ProfileDocument = {
    _id: 'u1',
    userId: 'u1',
    displayName: 'Selam',
    genderIdentity: 'woman',
    genderDisplay: 'private',
    cityId: 'city-seattle-wa',
    stateCode: 'WA',
    countryCode: 'US',
    intention: 'serious',
    bio: 'Coffee first',
    hometown: 'Asmara',
    hometownDisplay: 'private',
    occupation: 'Nurse',
    occupationDisplay: 'public',
    education: 'BSN',
    educationDisplay: 'private',
    height: 165,
    heightDisplay: 'private',
    languages: ['tigrinya'],
    languagesDisplay: 'private',
    religion: 'Orthodox',
    religionDisplay: 'private',
    revision: 4,
    publishedRevision: 3,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const answers: PromptAnswerDocument[] = [
    { _id: 'a1', ownerId: 'u1', promptId: 'prompt-tradition', slot: 0, approvedText: 'Buna', pendingText: 'Pending replacement', state: 'pending', revision: 2, publishedRevision: 1, createdAt: new Date(), updatedAt: new Date() },
    { _id: 'a2', ownerId: 'u1', promptId: 'prompt-home', slot: 1, approvedText: null, pendingText: 'Pending answer', state: 'pending', revision: 1, publishedRevision: 0, createdAt: new Date(), updatedAt: new Date() },
  ];

  const dto = toPublicProfileDTO(profile, user, answers);
  const serialized = JSON.stringify(dto);

  it('omits DOB, email, Firebase UID, status and moderation data', () => {
    for (const key of ['birthDate', 'email', 'firebaseUid', 'accountStatus', 'guardVersion', 'agreements',
      'emailVerified', 'adultEligible', 'profileReady', 'revision', 'publishedRevision', 'state', 'ownerId']) {
      expect(dto).not.toHaveProperty(key);
    }
    expect(serialized).not.toContain('1990-06-15');
    expect(serialized).not.toContain('firebase-secret-uid');
  });

  it('exposes calculated age instead of birth date', () => {
    expect(dto.age).toBe(calculateAge(new Date('1990-06-15')));
  });

  it('hides fields whose visibility is private', () => {
    expect(dto.genderIdentity).toBeNull();
    expect(dto.hometown).toBeNull();
    expect(dto.education).toBeNull();
    expect(dto.height).toBeNull();
    expect(dto.religion).toBeNull();
    expect(dto.languages).toEqual([]);
    expect(serialized).not.toContain('Asmara');
    expect(serialized).not.toContain('Orthodox');
    expect(dto.occupation).toBe('Nurse');
  });

  it('only publishes approved prompt text, never pending replacements', () => {
    expect(dto.promptAnswers.map(a => a.id)).toEqual(['a1']);
    expect(dto.promptAnswers[0]!.text).toBe('Buna');
    expect(serialized).not.toContain('Pending answer');
    expect(serialized).not.toContain('Pending replacement');
    expect(serialized).not.toContain('pendingText');
  });
});

describe('Prompt answer review states', () => {
  const auth = (r: request.Test) => r.set('Authorization', 'Bearer valid-token');

  /** Stand-in for the Phase 05 review service: publish the pending text */
  async function approve(db: Db, answerId: string) {
    const answers = db.collection<PromptAnswerDocument>('promptAnswers');
    const answer = (await answers.findOne({ _id: answerId }))!;
    await answers.updateOne({ _id: answerId }, {
      $set: { approvedText: answer.pendingText, pendingText: null, state: 'approved', publishedRevision: answer.publishedRevision + 1 },
    });
  }

  it('holds a new answer as pending: visible to the owner, absent from the public preview', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    const created = await auth(request(app).post('/v1/me/prompts')).send({ promptId: 'prompt-tradition', text: 'Buna' });
    expect(created.status).toBe(201);
    expect(created.body.data.state).toBe('pending');

    const own = await auth(request(app).get('/v1/me/profile'));
    expect(own.body.data.promptAnswers).toEqual([
      expect.objectContaining({ id: created.body.data.id, approvedText: null, pendingText: 'Buna', state: 'pending', revision: 1 }),
    ]);

    const preview = await auth(request(app).get('/v1/me/profile/preview'));
    expect(preview.body.data.promptAnswers).toEqual([]);
  });

  it('keeps approved text published while an edit waits for review', async () => {
    const db = createInMemoryDb();
    const app = buildApp(undefined, db);
    await bootstrapUser(app);

    const created = await auth(request(app).post('/v1/me/prompts')).send({ promptId: 'prompt-tradition', text: 'Buna' });
    await approve(db, created.body.data.id);

    const edit = await auth(request(app).patch(`/v1/me/prompts/${created.body.data.id}`))
      .send({ expectedRevision: 1, text: '  Coffee   ceremony  ' });
    expect(edit.status).toBe(200);
    expect(edit.body.data).toEqual({ id: created.body.data.id, state: 'pending', revision: 2 });

    const preview = await auth(request(app).get('/v1/me/profile/preview'));
    expect(preview.body.data.promptAnswers.map((a: { text: string }) => a.text)).toEqual(['Buna']);

    const own = await auth(request(app).get('/v1/me/profile'));
    expect(own.body.data.promptAnswers[0]).toMatchObject({ approvedText: 'Buna', pendingText: 'Coffee ceremony', state: 'pending' });
  });

  it('requires expectedRevision on answer edits and rejects stale ones', async () => {
    const app = buildApp();
    await bootstrapUser(app);
    const created = await auth(request(app).post('/v1/me/prompts')).send({ promptId: 'prompt-tradition', text: 'Buna' });
    const edit = (body: Record<string, unknown>) =>
      auth(request(app).patch(`/v1/me/prompts/${created.body.data.id}`)).send(body);

    expect((await edit({ text: 'No revision' })).status).toBe(422);
    expect((await edit({ expectedRevision: 1, text: 'Phone' })).status).toBe(200);

    const stale = await edit({ expectedRevision: 1, text: 'Tablet' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('REVISION_CONFLICT');
    expect(stale.body.error.currentRevision).toBe(2);
  });

  it('validates edited answer text with the same grapheme limit', async () => {
    const app = buildApp();
    await bootstrapUser(app);
    const created = await auth(request(app).post('/v1/me/prompts')).send({ promptId: 'prompt-tradition', text: 'Buna' });
    const edit = (text: string) =>
      auth(request(app).patch(`/v1/me/prompts/${created.body.data.id}`)).send({ expectedRevision: 1, text });

    expect((await edit('   ')).status).toBe(422);
    expect((await edit('ሀ'.repeat(301))).status).toBe(422);
    expect((await edit('ሀ'.repeat(300))).status).toBe(200);
  });

  it('cannot edit another user\'s answer', async () => {
    const app = buildApp(createMultiUserAuth());
    for (const t of ['token-alice', 'token-bob']) {
      await request(app).post('/v1/me/bootstrap').set('Authorization', `Bearer ${t}`);
    }
    const created = await request(app).post('/v1/me/prompts').set('Authorization', 'Bearer token-alice')
      .send({ promptId: 'prompt-tradition', text: 'Buna' });

    const res = await request(app).patch(`/v1/me/prompts/${created.body.data.id}`).set('Authorization', 'Bearer token-bob')
      .send({ expectedRevision: 1, text: 'Hijacked' });
    expect(res.status).toBe(404);

    const own = await request(app).get('/v1/me/profile').set('Authorization', 'Bearer token-alice');
    expect(own.body.data.promptAnswers[0].pendingText).toBe('Buna');
  });

  it('counts only published answers toward readiness', async () => {
    const db = createInMemoryDb();
    const app = buildApp(undefined, db);
    await bootstrapUser(app);

    const ids: string[] = [];
    for (const promptId of ['prompt-tradition', 'prompt-home', 'prompt-sunday']) {
      const res = await auth(request(app).post('/v1/me/prompts')).send({ promptId, text: 'Answer' });
      ids.push(res.body.data.id);
    }
    let me = await auth(request(app).get('/v1/me'));
    expect(me.body.data.readiness.missing).toContain('promptAnswers');

    for (const id of ids) await approve(db, id);
    me = await auth(request(app).get('/v1/me'));
    expect(me.body.data.readiness.missing).not.toContain('promptAnswers');
  });
});

describe('Profile field validation', () => {
  const edit = (app: ReturnType<typeof buildApp>, body: Record<string, unknown>) =>
    request(app).patch('/v1/me/profile').set('Authorization', 'Bearer valid-token').send({ expectedRevision: 1, ...body });

  async function freshApp() {
    const app = buildApp();
    await bootstrapUser(app);
    return app;
  }

  it('accepts 40 grapheme clusters of Ethiopic or combining characters', async () => {
    expect((await edit(await freshApp(), { displayName: 'ሰ'.repeat(40) })).status).toBe(200);
    // "é" written as e + combining acute is one grapheme cluster
    expect((await edit(await freshApp(), { displayName: 'é'.repeat(40) })).status).toBe(200);
    expect((await edit(await freshApp(), { displayName: 'é'.repeat(41) })).status).toBe(422);
  });

  it('rejects whitespace-only and non-string names', async () => {
    expect((await edit(await freshApp(), { displayName: '   \t ' })).status).toBe(422);
    expect((await edit(await freshApp(), { displayName: 42 })).status).toBe(422);
    expect((await edit(await freshApp(), { displayName: null })).status).toBe(422);
  });

  it('stores normalized whitespace in names', async () => {
    const app = await freshApp();
    await edit(app, { displayName: '  Selam   Tesfaye ' });
    const own = await request(app).get('/v1/me/profile').set('Authorization', 'Bearer valid-token');
    expect(own.body.data.displayName).toBe('Selam Tesfaye');
  });

  it('rejects unknown intention IDs', async () => {
    const res = await edit(await freshApp(), { intention: 'casual-fling' });
    expect(res.status).toBe(422);
    expect(res.body.error.fieldErrors[0].field).toBe('intention');
  });

  it('sets languages from the catalog and de-duplicates them', async () => {
    const app = await freshApp();
    const res = await edit(app, { languages: ['amharic', 'tigrinya', 'amharic'] });
    expect(res.status).toBe(200);
    const own = await request(app).get('/v1/me/profile').set('Authorization', 'Bearer valid-token');
    expect(own.body.data.languages).toEqual(['amharic', 'tigrinya']);
  });

  it('rejects unknown or malformed languages', async () => {
    expect((await edit(await freshApp(), { languages: ['klingon'] })).status).toBe(422);
    expect((await edit(await freshApp(), { languages: 'amharic' })).status).toBe(422);
    expect((await edit(await freshApp(), { languages: [7] })).status).toBe(422);
  });

  it('limits optional free-text fields to 100 grapheme clusters', async () => {
    for (const field of ['hometown', 'occupation', 'education', 'religion']) {
      expect((await edit(await freshApp(), { [field]: 'ሀ'.repeat(100) })).status).toBe(200);
      const res = await edit(await freshApp(), { [field]: 'ሀ'.repeat(101) });
      expect(res.status).toBe(422);
      expect(res.body.error.fieldErrors[0].field).toBe(field);
    }
  });

  it('rejects non-integer and out-of-range heights', async () => {
    expect((await edit(await freshApp(), { height: 170.5 })).status).toBe(422);
    expect((await edit(await freshApp(), { height: '170' })).status).toBe(422);
    expect((await edit(await freshApp(), { height: 300 })).status).toBe(422);
  });
});

describe('Preference age range bounds', () => {
  const edit = async (body: Record<string, unknown>) => {
    const app = buildApp();
    await bootstrapUser(app);
    return request(app).patch('/v1/me/preferences').set('Authorization', 'Bearer valid-token').send({ expectedRevision: 1, ...body });
  };

  it('rejects maxAge above 99', async () => {
    expect((await edit({ maxAge: 100 })).status).toBe(422);
    expect((await edit({ maxAge: 99 })).status).toBe(200);
  });

  it('rejects non-integer ages', async () => {
    expect((await edit({ minAge: '25' })).status).toBe(422);
    expect((await edit({ minAge: 25.5 })).status).toBe(422);
  });

  it('rejects an empty interest selection', async () => {
    expect((await edit({ acceptedGenderCategories: [] })).status).toBe(422);
  });
});

describe('GET /v1/catalogs languages', () => {
  it('includes the languages catalog with stable IDs', async () => {
    const res = await request(buildApp()).get('/v1/catalogs');
    const ids = res.body.data.languages.map((l: { id: string }) => l.id);
    expect(ids).toEqual(expect.arrayContaining(['english', 'amharic', 'tigrinya']));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('Resumable onboarding (GET /v1/me readiness)', () => {
  const auth = (r: request.Test) => r.set('Authorization', 'Bearer valid-token');

  it('lists every missing requirement for a fresh account', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    const me = await auth(request(app).get('/v1/me'));
    expect(me.status).toBe(200);
    expect(me.body.data.readiness).toEqual({
      ready: false,
      missing: ['adultEligible', 'termsAccepted', 'displayName', 'genderIdentity', 'interests',
        'location', 'intention', 'photos', 'promptAnswers'],
    });
  });

  it('syncs email verification from the verified token at bootstrap', async () => {
    const db = createInMemoryDb();
    const app = buildApp(undefined, db);
    await bootstrapUser(app);

    const me = await auth(request(app).get('/v1/me'));
    expect(me.body.data.emailVerified).toBe(true);
    expect(me.body.data.readiness.missing).not.toContain('emailVerified');
  });

  it('reports an unverified email until the token says otherwise', async () => {
    const unverified = {
      verifyIdToken: vi.fn().mockResolvedValue({ uid: 'firebase-uid-1', email_verified: false }),
    } as unknown as Auth;
    const app = buildApp(unverified);
    await bootstrapUser(app);

    const me = await auth(request(app).get('/v1/me'));
    expect(me.body.data.emailVerified).toBe(false);
    expect(me.body.data.readiness.missing).toContain('emailVerified');
  });

  it('resumes from server state: completed steps drop out of the missing list', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    await auth(request(app).patch('/v1/me/onboarding')).send({ birthDate: '1995-03-10', termsAccepted: true });
    await auth(request(app).patch('/v1/me/profile')).send({
      expectedRevision: 1, displayName: 'Selam', genderIdentity: 'woman', cityId: 'city-dallas-tx', intention: 'serious',
    });
    await auth(request(app).patch('/v1/me/preferences')).send({ expectedRevision: 1, acceptedGenderCategories: ['man'] });

    // A second device signing in sees the same server-side progress
    const me = await auth(request(app).get('/v1/me'));
    expect(me.body.data.readiness.missing).toEqual(['photos', 'promptAnswers']);
  });

  it('re-evaluates readiness after onboarding steps and bumps the guard on birth date', async () => {
    const db = createInMemoryDb();
    const app = buildApp(undefined, db);
    await bootstrapUser(app);
    const users = db.collection<UserDocument>('users');
    const before = (await users.findOne({ firebaseUid: 'firebase-uid-1' }))!.guardVersion;

    await auth(request(app).patch('/v1/me/onboarding')).send({ birthDate: '1995-03-10' });
    // A birth date change affects who can be shown to whom
    expect((await users.findOne({ firebaseUid: 'firebase-uid-1' }))!.guardVersion).toBe(before + 1);
  });
});
