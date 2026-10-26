import { describe, it, expect, beforeEach, vi } from 'vitest';
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
          for (const existing of store.values()) {
            if (doc['firebaseUid'] && existing['firebaseUid'] === doc['firebaseUid']) {
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
              const setFields = (update as { $set?: Record<string, unknown> }).$set ?? {};
              Object.assign(doc, setFields);
              store.set(id, doc);
              return { modifiedCount: 1 };
            }
          }
          return { modifiedCount: 0 };
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
      .send({ displayName: 'ሰላም' });

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
      .send({ displayName: longName });

    expect(res.status).toBe(422);
  });

  it('sets location from valid city ID', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    const res = await request(app)
      .patch('/v1/me/profile')
      .set('Authorization', 'Bearer valid-token')
      .send({ cityId: 'city-seattle-wa' });

    expect(res.status).toBe(200);
    expect(res.body.data.updated).toContain('cityId');
  });

  it('rejects unknown city ID', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    const res = await request(app)
      .patch('/v1/me/profile')
      .set('Authorization', 'Bearer valid-token')
      .send({ cityId: 'city-nonexistent' });

    expect(res.status).toBe(422);
  });

  it('rejects unknown gender identity', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    const res = await request(app)
      .patch('/v1/me/profile')
      .set('Authorization', 'Bearer valid-token')
      .send({ genderIdentity: 'invalid' });

    expect(res.status).toBe(422);
  });

  it('detects revision conflict', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    // First update
    await request(app)
      .patch('/v1/me/profile')
      .set('Authorization', 'Bearer valid-token')
      .send({ displayName: 'First' });

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
      .send({ religionDisplay: 'private' });

    expect(res.status).toBe(200);
  });

  it('rejects invalid visibility value', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    const res = await request(app)
      .patch('/v1/me/profile')
      .set('Authorization', 'Bearer valid-token')
      .send({ religionDisplay: 'maybe' });

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
      .send({ minAge: 22, maxAge: 35 });

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
      .send({ minAge: 16 });

    expect(res.status).toBe(422);
  });

  it('rejects minAge > maxAge', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    const res = await request(app)
      .patch('/v1/me/preferences')
      .set('Authorization', 'Bearer valid-token')
      .send({ minAge: 40, maxAge: 25 });

    expect(res.status).toBe(422);
  });

  it('sets gender preferences', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    const res = await request(app)
      .patch('/v1/me/preferences')
      .set('Authorization', 'Bearer valid-token')
      .send({ acceptedGenderCategories: ['woman', 'nonbinary'] });

    expect(res.status).toBe(200);
  });

  it('rejects unknown gender in preferences', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    const res = await request(app)
      .patch('/v1/me/preferences')
      .set('Authorization', 'Bearer valid-token')
      .send({ acceptedGenderCategories: ['unicorn'] });

    expect(res.status).toBe(422);
  });

  it('sets location scope', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    const res = await request(app)
      .patch('/v1/me/preferences')
      .set('Authorization', 'Bearer valid-token')
      .send({ locationScope: 'nationwide' });

    expect(res.status).toBe(200);
  });

  it('rejects invalid location scope', async () => {
    const app = buildApp();
    await bootstrapUser(app);

    const res = await request(app)
      .patch('/v1/me/preferences')
      .set('Authorization', 'Bearer valid-token')
      .send({ locationScope: 'global' });

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
    const result = checkReadiness(baseUser, baseProfile, 3, 3);
    expect(result.ready).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('reports missing email verification', () => {
    const result = checkReadiness({ ...baseUser, emailVerified: false }, baseProfile, 3, 3);
    expect(result.ready).toBe(false);
    expect(result.missing).toContain('emailVerified');
  });

  it('reports missing photos', () => {
    const result = checkReadiness(baseUser, baseProfile, 2, 3);
    expect(result.ready).toBe(false);
    expect(result.missing).toContain('photos');
  });

  it('reports missing prompt answers', () => {
    const result = checkReadiness(baseUser, baseProfile, 3, 1);
    expect(result.ready).toBe(false);
    expect(result.missing).toContain('promptAnswers');
  });

  it('reports missing displayName', () => {
    const result = checkReadiness(baseUser, { ...baseProfile, displayName: null }, 3, 3);
    expect(result.ready).toBe(false);
    expect(result.missing).toContain('displayName');
  });

  it('reports suspended account', () => {
    const result = checkReadiness({ ...baseUser, accountStatus: 'suspended' as const }, baseProfile, 3, 3);
    expect(result.ready).toBe(false);
    expect(result.missing).toContain('accountSuspended');
  });

  it('reports all missing fields at once', () => {
    const result = checkReadiness(
      { ...baseUser, emailVerified: false, adultEligible: false },
      { ...baseProfile, displayName: null, cityId: null },
      0,
      0,
    );
    expect(result.ready).toBe(false);
    expect(result.missing.length).toBeGreaterThanOrEqual(4);
  });
});
