import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createAuthRoutes } from '../src/modules/auth/routes.js';
import type { Auth, DecodedIdToken } from 'firebase-admin/auth';
import type { Db } from 'mongodb';

// Mock Firebase Auth
function createMockAuth(overrides: Partial<Auth> = {}): Auth {
  return {
    verifyIdToken: vi.fn().mockResolvedValue({
      uid: 'firebase-uid-1',
      email: 'test@example.com',
      email_verified: true,
    } as Partial<DecodedIdToken>),
    ...overrides,
  } as unknown as Auth;
}

// In-memory collection mock for unit tests
function createMockCollection() {
  const store = new Map<string, Record<string, unknown>>();

  return {
    store,
    findOne: vi.fn(async (filter: Record<string, unknown>) => {
      for (const doc of store.values()) {
        const match = Object.entries(filter).every(([k, v]) => doc[k] === v);
        if (match) return doc;
      }
      return null;
    }),
    insertOne: vi.fn(async (doc: Record<string, unknown>) => {
      // Check unique firebaseUid
      for (const existing of store.values()) {
        if (existing['firebaseUid'] === doc['firebaseUid']) {
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
          const { $set = {}, $inc = {} } = update as { $set?: Record<string, unknown>; $inc?: Record<string, number> };
          Object.assign(doc, $set);
          for (const [k, by] of Object.entries($inc)) doc[k] = ((doc[k] as number) ?? 0) + by;
          store.set(id, doc);
          return { matchedCount: 1, modifiedCount: 1 };
        }
      }
      return { matchedCount: 0, modifiedCount: 0 };
    }),
    // Readiness counts published prompt answers; none exist in these tests
    countDocuments: vi.fn(async () => 0),
  };
}

function createMockDb(collection: ReturnType<typeof createMockCollection>): Db {
  return {
    collection: () => collection,
  } as unknown as Db;
}

function buildApp(auth: Auth, db: Db) {
  const routes = createAuthRoutes(db, auth);
  return createApp({
    mongoCheck: async () => true,
    firebaseCheck: async () => true,
    routes: [routes],
  });
}

describe('Auth: token verification', () => {
  it('rejects requests without Authorization header', async () => {
    const app = buildApp(createMockAuth(), createMockDb(createMockCollection()));
    const res = await request(app).post('/v1/me/bootstrap');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects requests with invalid Bearer token', async () => {
    const auth = createMockAuth({
      verifyIdToken: vi.fn().mockRejectedValue(new Error('invalid token')),
    });
    const app = buildApp(auth, createMockDb(createMockCollection()));

    const res = await request(app)
      .post('/v1/me/bootstrap')
      .set('Authorization', 'Bearer invalid-token');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects revoked tokens', async () => {
    const err = new Error('revoked') as Error & { code: string };
    err.code = 'auth/id-token-revoked';
    const auth = createMockAuth({
      verifyIdToken: vi.fn().mockRejectedValue(err),
    });
    const app = buildApp(auth, createMockDb(createMockCollection()));

    const res = await request(app)
      .post('/v1/me/bootstrap')
      .set('Authorization', 'Bearer revoked-token');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_REVOKED');
  });

  it('rejects requests with non-Bearer auth', async () => {
    const app = buildApp(createMockAuth(), createMockDb(createMockCollection()));
    const res = await request(app)
      .post('/v1/me/bootstrap')
      .set('Authorization', 'Basic dXNlcjpwYXNz');
    expect(res.status).toBe(401);
  });
});

describe('POST /v1/me/bootstrap', () => {
  let col: ReturnType<typeof createMockCollection>;
  let db: Db;
  let auth: Auth;

  beforeEach(() => {
    col = createMockCollection();
    db = createMockDb(col);
    auth = createMockAuth();
  });

  it('creates a new user on first bootstrap', async () => {
    const app = buildApp(auth, db);
    const res = await request(app)
      .post('/v1/me/bootstrap')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(201);
    expect(res.body.data.accountStatus).toBe('onboarding');
    expect(res.body.data.userId).toBeDefined();
  });

  it('returns existing user on duplicate bootstrap', async () => {
    const app = buildApp(auth, db);

    const first = await request(app)
      .post('/v1/me/bootstrap')
      .set('Authorization', 'Bearer valid-token');

    const second = await request(app)
      .post('/v1/me/bootstrap')
      .set('Authorization', 'Bearer valid-token');

    expect(second.status).toBe(200);
    expect(second.body.data.userId).toBe(first.body.data.userId);
  });

  it('rejects suspended accounts', async () => {
    const app = buildApp(auth, db);

    // Create user, then suspend them
    await request(app)
      .post('/v1/me/bootstrap')
      .set('Authorization', 'Bearer valid-token');

    const doc = [...col.store.values()][0]!;
    doc['accountStatus'] = 'suspended';

    const res = await request(app)
      .post('/v1/me/bootstrap')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_RESTRICTED');
  });

  it('never trusts a UID from the request body', async () => {
    const app = buildApp(auth, db);
    const res = await request(app)
      .post('/v1/me/bootstrap')
      .set('Authorization', 'Bearer valid-token')
      .send({ uid: 'spoofed-uid' });

    expect(res.status).toBe(201);
    // The stored user should have firebase-uid-1, not spoofed-uid
    const storedUser = [...col.store.values()][0]!;
    expect(storedUser['firebaseUid']).toBe('firebase-uid-1');
  });
});

describe('GET /v1/me', () => {
  it('returns account data for authenticated user', async () => {
    const col = createMockCollection();
    const db = createMockDb(col);
    const auth = createMockAuth();
    const app = buildApp(auth, db);

    await request(app)
      .post('/v1/me/bootstrap')
      .set('Authorization', 'Bearer valid-token');

    const res = await request(app)
      .get('/v1/me')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);
    expect(res.body.data.accountStatus).toBe('onboarding');
    expect(res.body.data.adultEligible).toBe(false);
  });

  it('rejects without auth', async () => {
    const app = buildApp(createMockAuth(), createMockDb(createMockCollection()));
    const res = await request(app).get('/v1/me');
    expect(res.status).toBe(401);
  });

  it('answers 404 NOT_FOUND before bootstrap, like every other own-resource route', async () => {
    const app = buildApp(createMockAuth(), createMockDb(createMockCollection()));
    const res = await request(app).get('/v1/me').set('Authorization', 'Bearer valid-token');
    expect(res.status).toBe(404);
    expect(res.body.error).toEqual({ code: 'NOT_FOUND', message: 'Account not found', retryable: false });
  });

  it('answers 403 ACCOUNT_RESTRICTED for a suspended account', async () => {
    const col = createMockCollection();
    const app = buildApp(createMockAuth(), createMockDb(col));
    await request(app).post('/v1/me/bootstrap').set('Authorization', 'Bearer valid-token');
    [...col.store.values()][0]!['accountStatus'] = 'suspended';

    const res = await request(app).get('/v1/me').set('Authorization', 'Bearer valid-token');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_RESTRICTED');
  });
});

describe('PATCH /v1/me/onboarding', () => {
  let col: ReturnType<typeof createMockCollection>;
  let db: Db;
  let auth: Auth;
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    col = createMockCollection();
    db = createMockDb(col);
    auth = createMockAuth();
    app = buildApp(auth, db);
    // Bootstrap the user first
    await request(app)
      .post('/v1/me/bootstrap')
      .set('Authorization', 'Bearer valid-token');
  });

  it('accepts a valid adult birth date', async () => {
    const res = await request(app)
      .patch('/v1/me/onboarding')
      .set('Authorization', 'Bearer valid-token')
      .send({ birthDate: '1990-06-15' });

    expect(res.status).toBe(200);
    expect(res.body.data.updated).toContain('birthDate');
  });

  it('rejects underage birth date', async () => {
    const res = await request(app)
      .patch('/v1/me/onboarding')
      .set('Authorization', 'Bearer valid-token')
      .send({ birthDate: '2015-06-15' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('AGE_INELIGIBLE');
  });

  it('rejects invalid date format', async () => {
    const res = await request(app)
      .patch('/v1/me/onboarding')
      .set('Authorization', 'Bearer valid-token')
      .send({ birthDate: 'not-a-date' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects future birth date', async () => {
    const res = await request(app)
      .patch('/v1/me/onboarding')
      .set('Authorization', 'Bearer valid-token')
      .send({ birthDate: '2099-01-01' });

    expect(res.status).toBe(422);
  });

  it('rejects empty body', async () => {
    const res = await request(app)
      .patch('/v1/me/onboarding')
      .set('Authorization', 'Bearer valid-token')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_UPDATES');
  });

  describe('age gate lock', () => {
    const submit = (body: Record<string, unknown>) =>
      request(app).patch('/v1/me/onboarding').set('Authorization', 'Bearer valid-token').send(body);
    const userDoc = () => [...col.store.values()][0]!;

    it('records a refused under-18 date without the date, then refuses every later birth date the same way', async () => {
      const first = await submit({ birthDate: '2015-06-15' });
      expect(first.status).toBe(422);
      expect(first.body.error).toEqual({ code: 'AGE_INELIGIBLE', message: 'You must be at least 18 years old to use Lemon', retryable: false });

      expect(userDoc()['ageGate']).toEqual({ blockedAt: expect.any(Date) });
      expect(userDoc()).toMatchObject({ birthDate: null, adultEligible: false });
      expect(JSON.stringify(userDoc())).not.toContain('2015');

      // Earlier years and even malformed dates: same answer, nothing saved
      for (const birthDate of ['1990-06-15', '2000-01-01', 'not-a-date', 12345]) {
        const retry = await submit({ birthDate });
        expect(retry.status, `${birthDate}`).toBe(422);
        expect(retry.body.error).toEqual(first.body.error);
      }
      expect(userDoc()).toMatchObject({ birthDate: null, adultEligible: false, ageGate: { blockedAt: expect.any(Date) } });
    });

    it('saves no terms acceptance from a request whose birth date is refused', async () => {
      expect((await submit({ birthDate: '2015-06-15', termsAccepted: true })).status).toBe(422);
      expect((userDoc()['agreements'] as { termsVersion: string | null }).termsVersion).toBeNull();

      expect((await submit({ birthDate: '1990-06-15', termsAccepted: true })).status).toBe(422);
      expect((userDoc()['agreements'] as { termsVersion: string | null }).termsVersion).toBeNull();
      expect(userDoc()['birthDate']).toBeNull();
    });

    it('clears an adult date saved earlier, so the account is no longer adult-eligible', async () => {
      expect((await submit({ birthDate: '1990-06-15' })).status).toBe(200);
      expect(userDoc()).toMatchObject({ birthDate: '1990-06-15', adultEligible: true });

      expect((await submit({ birthDate: '2015-06-15' })).status).toBe(422);
      expect(userDoc()).toMatchObject({ birthDate: null, adultEligible: false, ageGate: { blockedAt: expect.any(Date) } });
      expect((await submit({ birthDate: '1990-06-15' })).body.error.code).toBe('AGE_INELIGIBLE');
    });

    it('does not save an adult date when an under-18 submission locked the gate after this request read the account', async () => {
      const save = col.updateOne.getMockImplementation()!;
      col.updateOne.mockImplementationOnce(async (filter, update) => {
        // A concurrent request with an under-18 date commits its lock first
        Object.assign(userDoc(), { ageGate: { blockedAt: new Date() }, birthDate: null, adultEligible: false });
        return save(filter, update);
      });

      const res = await submit({ birthDate: '1990-06-15', termsAccepted: true });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('AGE_INELIGIBLE');
      expect(userDoc()).toMatchObject({ birthDate: null, adultEligible: false });
      expect((userDoc()['agreements'] as { termsVersion: string | null }).termsVersion).toBeNull();
    });

    it('still accepts terms on their own, and never shows the lock in the account snapshot', async () => {
      await submit({ birthDate: '2015-06-15' });
      const terms = await submit({ termsAccepted: true });
      expect(terms.status).toBe(200);
      expect(terms.body.data.updated).toEqual(['agreements']);

      const me = await request(app).get('/v1/me').set('Authorization', 'Bearer valid-token');
      expect(me.status).toBe(200);
      expect(me.body.data).not.toHaveProperty('ageGate');
      expect(JSON.stringify(me.body)).not.toContain('blockedAt');
      expect(me.body.data).toMatchObject({ birthDate: null, adultEligible: false });
      expect(me.body.data.readiness.missing).toContain('adultEligible');
    });
  });

  it('rejects if account is not in onboarding state', async () => {
    // Change status to active
    const doc = [...col.store.values()][0]!;
    doc['accountStatus'] = 'active';

    const res = await request(app)
      .patch('/v1/me/onboarding')
      .set('Authorization', 'Bearer valid-token')
      .send({ birthDate: '1990-06-15' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE');
  });
});
