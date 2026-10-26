import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createAuthRoutes } from '../src/modules/auth/routes.js';
import type { Auth, DecodedIdToken } from 'firebase-admin/auth';
import type { Db, Collection } from 'mongodb';

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
          const setFields = (update as { $set?: Record<string, unknown> }).$set ?? {};
          Object.assign(doc, setFields);
          store.set(id, doc);
          return { modifiedCount: 1 };
        }
      }
      return { modifiedCount: 0 };
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
