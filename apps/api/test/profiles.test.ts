import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createProfileRoutes } from '../src/modules/profiles/routes.js';
import { createCatalogRoutes } from '../src/modules/catalogs/routes.js';
import { createPreferencesRoutes } from '../src/modules/preferences/routes.js';
import { createAuthRoutes } from '../src/modules/auth/routes.js';
import type { Auth, DecodedIdToken } from 'firebase-admin/auth';
import type { Db } from 'mongodb';
import { graphemeLength, normalizeWhitespace } from '../src/modules/profiles/schema.js';
import { checkReadiness } from '../src/modules/profiles/readiness.js';
import { toPublicProfileDTO } from '../src/modules/profiles/dto.js';
import { calculateAge } from '../src/modules/auth/adult-gate.js';
import type { PromptAnswerDocument } from '../src/modules/profiles/schema.js';
import type { UserDocument } from '../src/modules/auth/account.js';
import type { ProfileDocument } from '../src/modules/profiles/schema.js';

// --- Helpers ---

function createMockAuth(): Auth {
  return {
    verifyIdToken: vi.fn().mockResolvedValue({
      uid: 'firebase-uid-1',
      email: 'test@example.com',
      email_verified: true,
    } as Partial<DecodedIdToken>),
  } as unknown as Auth;
}

// Mirrors src/indexes.ts so duplicate-key paths behave like MongoDB
const UNIQUE_KEYS: Record<string, string[][]> = {
  users: [['firebaseUid']],
  profiles: [['userId']],
  preferences: [['userId']],
  promptAnswers: [['ownerId', 'promptId']],
};

function createInMemoryDb() {
  const collections = new Map<string, Map<string, Record<string, unknown>>>();

  function getCol(name: string) {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name)!;
  }

  return {
    collection: (name: string) => {
      const store = getCol(name);
      return {
        findOne: vi.fn(async (filter: Record<string, unknown>) => {
          for (const doc of store.values()) {
            const match = Object.entries(filter).every(([k, v]) => doc[k] === v);
            if (match) return doc;
          }
          return null;
        }),
        find: vi.fn((filter: Record<string, unknown>) => ({
          toArray: vi.fn(async () => {
            const results: Record<string, unknown>[] = [];
            for (const doc of store.values()) {
              const match = Object.entries(filter).every(([k, v]) => doc[k] === v);
              if (match) results.push(doc);
            }
            return results;
          }),
        })),
        insertOne: vi.fn(async (doc: Record<string, unknown>) => {
          const uniqueKeys = [['_id'], ...(UNIQUE_KEYS[name] ?? [])];
          for (const existing of store.values()) {
            if (uniqueKeys.some(keys => keys.every(k => existing[k] === doc[k]))) {
              const err = new Error('duplicate key') as Error & { code: number };
              err.code = 11000;
              throw err;
            }
          }
          store.set(doc['_id'] as string, { ...doc });
          return { insertedId: doc['_id'] };
        }),
        updateOne: vi.fn(async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
          for (const [id, doc] of store.entries()) {
            const match = Object.entries(filter).every(([k, v]) => doc[k] === v);
            if (match) {
              const { $set = {}, $inc = {} } = update as {
                $set?: Record<string, unknown>;
                $inc?: Record<string, number>;
              };
              Object.assign(doc, $set);
              for (const [k, by] of Object.entries($inc)) doc[k] = ((doc[k] as number) ?? 0) + by;
              store.set(id, doc);
              return { matchedCount: 1, modifiedCount: 1 };
            }
          }
          return { matchedCount: 0, modifiedCount: 0 };
        }),
        deleteOne: vi.fn(async (filter: Record<string, unknown>) => {
          for (const [id, doc] of store.entries()) {
            const match = Object.entries(filter).every(([k, v]) => doc[k] === v);
            if (match) {
              store.delete(id);
              return { deletedCount: 1 };
            }
          }
          return { deletedCount: 0 };
        }),
        countDocuments: vi.fn(async (filter: Record<string, unknown>) => {
          let count = 0;
          for (const doc of store.values()) {
            const match = Object.entries(filter).every(([k, v]) => doc[k] === v);
            if (match) count++;
          }
          return count;
        }),
      };
    },
  } as unknown as Db;
}

/** Token "token-<name>" authenticates as Firebase UID "uid-<name>" */
function createMultiUserAuth(): Auth {
  return {
    verifyIdToken: vi.fn(async (token: string) => ({
      uid: `uid-${token.replace('token-', '')}`,
      email: `${token}@example.com`,
      email_verified: true,
    })),
  } as unknown as Auth;
}

function buildApp(auth?: Auth, db?: Db) {
  const a = auth ?? createMockAuth();
  const d = db ?? createInMemoryDb();
  return createApp({
    mongoCheck: async () => true,
    firebaseCheck: async () => true,
    routes: [
      createAuthRoutes(d, a),
      createProfileRoutes(d, a),
      createCatalogRoutes(),
      createPreferencesRoutes(d, a),
    ],
  });
}

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

    // Get self preview (shows everything)
    const preview = await request(app)
      .get('/v1/me/profile/preview')
      .set('Authorization', 'Bearer valid-token');

    expect(preview.status).toBe(200);
    expect(preview.body.data.religion).toBe('Orthodox');

    // NOTE: Public view test would need a second user and active status
    // For now we verify the DTO logic via the self preview which includes
    // visibility fields that the public DTO respects
    expect(preview.body.data.religionDisplay).toBe('private');
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

    const preview = await request(app).get('/v1/me/profile/preview').set('Authorization', 'Bearer valid-token');
    expect(preview.body.data.displayName).toBe('Tablet');
    expect(preview.body.data.revision).toBe(3);
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

  it('returns revision 1 from preview before the first edit', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    const preview = await request(app).get('/v1/me/profile/preview').set('Authorization', 'Bearer valid-token');
    expect(preview.status).toBe(200);
    expect(preview.body.data.revision).toBe(1);
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

    const preview = await request(app).get('/v1/me/profile/preview').set('Authorization', 'Bearer valid-token');
    expect(preview.body.data.revision).toBe(1);
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
    expect(res.body.data.state).toBe('approved');
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

    const preview = await request(app).get('/v1/me/profile/preview').set('Authorization', 'Bearer token-alice');
    expect(preview.body.data.promptAnswers).toHaveLength(1);
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
    { _id: 'a1', ownerId: 'u1', promptId: 'prompt-tradition', text: 'Buna', state: 'approved', publishedRevision: 1, createdAt: new Date(), updatedAt: new Date() },
    { _id: 'a2', ownerId: 'u1', promptId: 'prompt-home', text: 'Pending answer', state: 'pending', publishedRevision: 0, createdAt: new Date(), updatedAt: new Date() },
  ] as PromptAnswerDocument[];

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

  it('only publishes approved prompt answers', () => {
    expect(dto.promptAnswers.map(a => a.id)).toEqual(['a1']);
    expect(serialized).not.toContain('Pending answer');
  });
});
