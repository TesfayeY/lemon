import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import request from 'supertest';
import { parse } from 'yaml';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { v4 as uuidv4 } from 'uuid';
import { MongoClient, type Db } from 'mongodb';
import type { Auth, DecodedIdToken } from 'firebase-admin/auth';
import { createApp } from '../src/app.js';
import { ensureIndexes } from '../src/indexes.js';
import { createAuthRoutes } from '../src/modules/auth/routes.js';
import { createProfileRoutes } from '../src/modules/profiles/routes.js';
import { createMediaRoutes } from '../src/modules/media/routes.js';
import { createAdminRoutes } from '../src/modules/admin/routes.js';
import { ADMIN_AUDIT_COLLECTION, ensureAdminIndexes, type AdminAuditEntry } from '../src/modules/admin/audit.js';
import { InMemoryMediaStorage } from '../src/adapters/media/in-memory.js';
import { createEmptyProfile, type PromptAnswerDocument } from '../src/modules/profiles/schema.js';
import { createDefaultPreferences } from '../src/modules/preferences/schema.js';
import { photoObjectKeys, type PhotoDocument, type PhotoStateType } from '../src/modules/media/schema.js';
import type { AccountStatusType, UserDocument } from '../src/modules/auth/account.js';

// --- Contract validation (same approach as contract.test.ts) ---

const contractsDir = fileURLToPath(new URL('../../../contracts/', import.meta.url));
const spec = parse(readFileSync(path.join(contractsDir, 'openapi.yaml'), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema(spec, 'openapi');

function expectContract(res: request.Response, apiPath: string, method: string) {
  const response = spec.paths[apiPath]?.[method]?.responses?.[String(res.status)];
  if (!response) throw new Error(`No contract for ${method.toUpperCase()} ${apiPath} ${res.status}`);
  const base = response.$ref
    ? (response.$ref as string).slice(1)
    : `/paths/${apiPath.replace(/~/g, '~0').replace(/\//g, '~1')}/${method}/responses/${res.status}`;
  const validate = ajv.getSchema(`openapi#${base}/content/application~1json/schema`)!;
  validate(JSON.parse(JSON.stringify(res.body)));
  expect(validate.errors ?? [], `${method.toUpperCase()} ${apiPath} ${res.status}`).toEqual([]);
}

// --- Real local replica set, isolated database per run ---

const uri = process.env['MONGO_URI']!;
const dbName = `lemon_test_admin_${process.pid}_${Date.now()}`;
const clock = { now: new Date('2026-11-10T12:00:00Z') };
const nowSeconds = () => Math.floor(clock.now.getTime() / 1000);

let client: MongoClient;
let db: Db;
let storage: InMemoryMediaStorage;
let app: ReturnType<typeof createApp>;

/**
 * Stand-in for Admin SDK verifyIdToken. Real verification (signature, expiry,
 * revocation) happens in Firebase; these tokens model what a verified token can
 * carry. Custom claims can only appear through the Admin SDK, never the client.
 */
const TOKENS: Record<string, () => Partial<DecodedIdToken>> = {
  'token-mod': () => ({ uid: 'staff-mod', email_verified: true, auth_time: nowSeconds() - 60, staffRole: 'moderator' }),
  'token-mod2': () => ({ uid: 'staff-mod2', email_verified: true, auth_time: nowSeconds() - 60, staffRole: 'moderator' }),
  'token-admin': () => ({ uid: 'staff-admin', email_verified: true, auth_time: nowSeconds() - 60, staffRole: 'admin' }),
  'token-admin2': () => ({ uid: 'staff-admin2', email_verified: true, auth_time: nowSeconds() - 60, staffRole: 'admin' }),
  'token-admin-stale': () => ({ uid: 'staff-admin', email_verified: true, auth_time: nowSeconds() - 3600, staffRole: 'admin' }),
  'token-admin-unverified': () => ({ uid: 'staff-new', email_verified: false, auth_time: nowSeconds() - 60, staffRole: 'admin' }),
  // A staff member who is also a member (alice)
  'token-staff-alice': () => ({ uid: 'uid-alice', email_verified: true, auth_time: nowSeconds() - 60, staffRole: 'admin' }),
  // Look-alike claims that must not grant anything
  'token-claim-admin-bool': () => ({ uid: 'uid-mallory', email_verified: true, auth_time: nowSeconds(), admin: true }),
  'token-claim-unknown-role': () => ({ uid: 'uid-mallory', email_verified: true, auth_time: nowSeconds(), staffRole: 'superadmin' }),
  'token-claim-role-array': () => ({ uid: 'uid-mallory', email_verified: true, auth_time: nowSeconds(), staffRole: ['admin'] }),
  'token-claim-role-case': () => ({ uid: 'uid-mallory', email_verified: true, auth_time: nowSeconds(), staffRole: 'Admin' }),
  'token-claim-roles-field': () => ({ uid: 'uid-mallory', email_verified: true, auth_time: nowSeconds(), role: 'admin', roles: ['admin'] }),
};

const auth = {
  verifyIdToken: vi.fn(async (token: string) => {
    if (token === 'token-revoked') throw Object.assign(new Error('revoked'), { code: 'auth/id-token-revoked' });
    if (token === 'token-forged') throw Object.assign(new Error('bad signature'), { code: 'auth/argument-error' });
    const staff = TOKENS[token];
    if (staff) return staff();
    if (token.startsWith('token-')) {
      return { uid: `uid-${token.slice('token-'.length)}`, email_verified: true, auth_time: nowSeconds() - 60 };
    }
    throw Object.assign(new Error('invalid'), { code: 'auth/argument-error' });
  }),
} as unknown as Auth;

const bearer = (name: string) => `Bearer token-${name}`;

beforeAll(async () => {
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(`Admin integration tests need MongoDB at ${uri} (run the local replica set)`, { cause: err });
  }
  db = client.db(dbName);
  await ensureIndexes(db);
});

afterAll(async () => {
  await db?.dropDatabase();
  await client?.close();
});

beforeEach(async () => {
  for (const name of ['users', 'profiles', 'preferences', 'promptAnswers', 'photos', 'photoSets', ADMIN_AUDIT_COLLECTION, 'auditLog']) {
    await db.collection(name).deleteMany({});
  }
  storage = new InMemoryMediaStorage();
  app = createApp({
    mongoCheck: async () => true,
    firebaseCheck: async () => true,
    routes: [
      createAuthRoutes(db, auth),
      createProfileRoutes(db, auth),
      createMediaRoutes(db, auth, { MEDIA_MAX_BYTES: 10 * 1024 * 1024, MEDIA_LOCAL_DIR: 'unused' }, storage),
      createAdminRoutes(db, client, auth, { MEDIA_LOCAL_DIR: 'unused', ADMIN_RECENT_AUTH_MAX_AGE_SECONDS: 900 }, {
        storage,
        now: () => clock.now,
      }),
    ],
  });
});

// --- Seed helpers (fictional members) ---

let seq = 0;
const nextTime = () => new Date(Date.UTC(2026, 10, 1) + ++seq * 1000);
const PROMPTS = ['prompt-tradition', 'prompt-home', 'prompt-sunday', 'prompt-song', 'prompt-cooking'];

type AnswerSpec = 'approved' | 'pending' | 'edit-pending' | 'rejected';

interface MemberSpec {
  status?: AccountStatusType;
  ready?: boolean;
  photos?: PhotoStateType[];
  answers?: AnswerSpec[];
}

interface Member {
  userId: string;
  photoIds: string[];
  answerIds: string[];
}

const userIdOf = (name: string) => `user-${name}`;

async function seedMember(name: string, s: MemberSpec = {}): Promise<Member> {
  const userId = userIdOf(name);
  const now = new Date();
  const user: UserDocument = {
    _id: userId,
    firebaseUid: `uid-${name}`,
    accountStatus: s.status ?? 'onboarding',
    emailVerified: true,
    birthDate: '1994-05-12',
    adultEligible: true,
    discoverPaused: false,
    profileReady: s.ready ?? false,
    guardVersion: 1,
    agreements: { termsVersion: '1.0', acceptedAt: now },
    createdAt: now,
    updatedAt: now,
  };
  await db.collection<UserDocument>('users').insertOne(user);
  await db.collection('profiles').insertOne({
    ...createEmptyProfile(userId),
    displayName: name,
    genderIdentity: 'woman',
    cityId: 'city-seattle-wa',
    stateCode: 'WA',
    intention: 'serious',
  });
  await db.collection('preferences').insertOne({ ...createDefaultPreferences(userId), acceptedGenderCategories: ['man'] });

  const photoIds: string[] = [];
  for (const [order, state] of (s.photos ?? []).entries()) {
    const id = uuidv4();
    const at = nextTime();
    const photo: PhotoDocument = {
      _id: id,
      ownerId: userId,
      state,
      ...photoObjectKeys(userId, id),
      width: 1080,
      height: 1350,
      order,
      contentVersion: 1,
      moderationReason: state === 'rejected' ? 'low_quality' : null,
      requestHash: 'fixture',
      reviewedAt: null,
      deletedAt: state === 'deleted' ? at : null,
      objectsPurgedAt: null,
      createdAt: at,
      updatedAt: at,
    };
    await db.collection<PhotoDocument>('photos').insertOne(photo);
    if (state !== 'deleted') {
      await storage.putObject(photo.originalPrivateKey, Buffer.from(`master-${id}`), { contentType: 'image/jpeg' });
      await storage.putObject(photo.variantKeys.thumb, Buffer.from(`thumb-${id}`), { contentType: 'image/webp' });
      await storage.putObject(photo.variantKeys.display, Buffer.from(`display-${id}`), { contentType: 'image/webp' });
    }
    photoIds.push(id);
  }
  await db.collection('photoSets').insertOne({ _id: userId, ownerId: userId, revision: 1, createdAt: now, updatedAt: now });

  const answerIds: string[] = [];
  for (const [slot, kind] of (s.answers ?? []).entries()) {
    const id = uuidv4();
    const at = nextTime();
    const published = kind === 'approved' || kind === 'edit-pending';
    const answer: PromptAnswerDocument = {
      _id: id,
      ownerId: userId,
      promptId: PROMPTS[slot]!,
      slot,
      approvedText: published ? `${name} published answer ${slot}` : null,
      pendingText: kind === 'approved' ? null : `${name} submitted answer ${slot}`,
      state: kind === 'edit-pending' ? 'pending' : kind,
      revision: kind === 'edit-pending' ? 2 : 1,
      publishedRevision: published ? 1 : 0,
      ...(kind === 'rejected' ? { rejectionReason: 'contact_details' } : {}),
      createdAt: at,
      updatedAt: at,
    };
    await db.collection<PromptAnswerDocument>('promptAnswers').insertOne(answer);
    answerIds.push(id);
  }
  return { userId, photoIds, answerIds };
}

/** A member everyone can see: active, ready, three approved photos and answers. */
const seedVisibleMember = (name: string) =>
  seedMember(name, { status: 'active', ready: true, photos: ['approved', 'approved', 'approved'], answers: ['approved', 'approved', 'approved'] });

const audits = () => db.collection<AdminAuditEntry>(ADMIN_AUDIT_COLLECTION);
const getUser = (name: string) => db.collection<UserDocument>('users').findOne({ _id: userIdOf(name) });
const getPhoto = (id: string) => db.collection<PhotoDocument>('photos').findOne({ _id: id });
const getAnswer = (id: string) => db.collection<PromptAnswerDocument>('promptAnswers').findOne({ _id: id });

const reviewPhoto = (as: string, id: string, body: Record<string, unknown>) =>
  request(app).post(`/v1/admin/content/photos/${id}/review`).set('Authorization', bearer(as)).send(body);
const reviewAnswer = (as: string, id: string, body: Record<string, unknown>) =>
  request(app).post(`/v1/admin/content/prompt-answers/${id}/review`).set('Authorization', bearer(as)).send(body);

/** Every admin route with a body that would succeed for an authorized caller. */
function adminRoutes(ids: { photo: string; answer: string; user: string }) {
  return [
    { method: 'get', url: '/v1/admin/me' },
    { method: 'get', url: '/v1/admin/reasons' },
    { method: 'get', url: '/v1/admin/content/photos' },
    { method: 'get', url: `/v1/admin/content/photos/${ids.photo}` },
    { method: 'get', url: `/v1/admin/content/photos/${ids.photo}/media/display` },
    { method: 'post', url: `/v1/admin/content/photos/${ids.photo}/review`, body: { decision: 'approve' } },
    { method: 'get', url: '/v1/admin/content/prompt-answers' },
    { method: 'get', url: `/v1/admin/content/prompt-answers/${ids.answer}` },
    { method: 'post', url: `/v1/admin/content/prompt-answers/${ids.answer}/review`, body: { decision: 'approve', expectedRevision: 1 } },
    { method: 'get', url: `/v1/admin/users/${ids.user}` },
    { method: 'post', url: `/v1/admin/users/${ids.user}/suspend`, body: { reason: 'harassment' } },
    { method: 'post', url: `/v1/admin/users/${ids.user}/restore`, body: { reason: 'appeal_upheld' } },
    { method: 'get', url: `/v1/admin/audit-log?targetType=user&targetId=${ids.user}` },
  ] as const;
}

function send(route: { method: 'get' | 'post'; url: string; body?: Record<string, unknown> }, authorization?: string) {
  let req = route.method === 'get' ? request(app).get(route.url) : request(app).post(route.url).send(route.body ?? {});
  if (authorization) req = req.set('Authorization', authorization);
  return req;
}

// --- Tests ---

describe('admin authorization', () => {
  it('rejects missing, forged, revoked and member tokens on every admin route, and spoofed role hints', async () => {
    const m = await seedMember('alice', { photos: ['pending'], answers: ['pending'] });
    const routes = adminRoutes({ photo: m.photoIds[0]!, answer: m.answerIds[0]!, user: m.userId });

    for (const route of routes) {
      expect((await send(route)).status, `${route.url} without a token`).toBe(401);
      expect((await send(route, 'Bearer token-forged')).status, `${route.url} forged`).toBe(401);
      expect((await send(route, 'Bearer token-revoked')).body.error.code).toBe('TOKEN_REVOKED');
      expect((await send(route, 'Basic token-admin')).status).toBe(401);

      const member = await send(route, bearer('bob'));
      expect(member.status, `${route.url} as member`).toBe(403);
      expect(member.body.error.code).toBe('STAFF_ONLY');

      for (const token of ['claim-admin-bool', 'claim-unknown-role', 'claim-role-array', 'claim-role-case', 'claim-roles-field']) {
        const res = await send(route, bearer(token));
        expect(res.status, `${route.url} with ${token}`).toBe(403);
        expect(res.body.error.code).toBe('STAFF_ONLY');
      }

      // Role hints in headers or the body are never read
      let spoofed = route.method === 'get'
        ? request(app).get(`${route.url}${route.url.includes('?') ? '&' : '?'}staffRole=admin`)
        : request(app).post(route.url).send({ ...(route.body ?? {}), staffRole: 'admin', uid: 'staff-admin' });
      spoofed = spoofed.set('Authorization', bearer('bob')).set('X-Staff-Role', 'admin').set('X-User-Id', 'staff-admin');
      expect((await spoofed).status, `${route.url} spoofed`).toBe(403);
    }

    // Nothing was decided or audited by any of those requests
    expect((await getPhoto(m.photoIds[0]!))!.state).toBe('pending');
    expect((await getAnswer(m.answerIds[0]!))!.state).toBe('pending');
    expect((await getUser('alice'))!.accountStatus).toBe('onboarding');
    expect(await audits().countDocuments()).toBe(0);
  });

  it('keeps moderators to content review and lets administrators manage accounts', async () => {
    const m = await seedMember('alice', { status: 'active', photos: ['pending'], answers: ['pending'] });

    const me = await request(app).get('/v1/admin/me').set('Authorization', bearer('mod'));
    expect(me.status).toBe(200);
    expect(me.body.data).toEqual({ role: 'moderator', permissions: ['content.review'] });
    expectContract(me, '/v1/admin/me', 'get');

    for (const url of ['/v1/admin/reasons', '/v1/admin/content/photos', '/v1/admin/content/prompt-answers',
      `/v1/admin/content/photos/${m.photoIds[0]}`, `/v1/admin/content/prompt-answers/${m.answerIds[0]}`]) {
      expect((await request(app).get(url).set('Authorization', bearer('mod'))).status, `${url}`).toBe(200);
    }
    for (const route of [
      { method: 'get' as const, url: `/v1/admin/users/${m.userId}` },
      { method: 'post' as const, url: `/v1/admin/users/${m.userId}/suspend`, body: { reason: 'harassment' } },
      { method: 'post' as const, url: `/v1/admin/users/${m.userId}/restore`, body: { reason: 'appeal_upheld' } },
      { method: 'get' as const, url: `/v1/admin/audit-log?targetType=user&targetId=${m.userId}` },
    ]) {
      const res = await send(route, bearer('mod'));
      expect(res.status, `${route.url}`).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_ROLE');
    }
    expect((await getUser('alice'))!.accountStatus).toBe('active');

    const adminMe = await request(app).get('/v1/admin/me').set('Authorization', bearer('admin'));
    expect(adminMe.body.data).toEqual({ role: 'admin', permissions: ['content.review', 'account.manage', 'audit.read'] });
    expect((await request(app).get(`/v1/admin/users/${m.userId}`).set('Authorization', bearer('admin'))).status).toBe(200);
  });

  it('requires a recent sign-in for account actions only', async () => {
    const m = await seedMember('alice', { status: 'active', photos: ['pending'] });
    const res = await request(app).post(`/v1/admin/users/${m.userId}/suspend`).set('Authorization', bearer('admin-stale'))
      .send({ reason: 'harassment' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('RECENT_AUTH_REQUIRED');
    expect((await getUser('alice'))!.accountStatus).toBe('active');
    expect(await audits().countDocuments()).toBe(0);

    expect((await reviewPhoto('admin-stale', m.photoIds[0]!, { decision: 'approve' })).status).toBe(200);
  });

  it('rejects staff tokens without a verified email', async () => {
    const res = await request(app).get('/v1/admin/me').set('Authorization', bearer('admin-unverified'));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('STAFF_EMAIL_UNVERIFIED');
  });

  it('never lets staff decide on their own content or account', async () => {
    const m = await seedMember('alice', { status: 'active', photos: ['pending'], answers: ['pending'] });
    for (const res of [
      await reviewPhoto('staff-alice', m.photoIds[0]!, { decision: 'approve' }),
      await reviewAnswer('staff-alice', m.answerIds[0]!, { decision: 'approve', expectedRevision: 1 }),
      await request(app).post(`/v1/admin/users/${m.userId}/restore`).set('Authorization', bearer('staff-alice')).send({ reason: 'appeal_upheld' }),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('SELF_ACTION_FORBIDDEN');
    }
    expect(await audits().countDocuments()).toBe(0);
  });
});

describe('review queues', () => {
  it('lists only pending photos, oldest first, with stable keyset pages', async () => {
    const alice = await seedMember('alice', { photos: ['pending', 'approved', 'pending', 'rejected'] });
    const bob = await seedMember('bob', { photos: ['pending', 'deleted', 'processing', 'pending', 'failed'] });
    const carol = await seedMember('carol', { photos: ['pending'] });
    const expected = [alice.photoIds[0], alice.photoIds[2], bob.photoIds[0], bob.photoIds[3], carol.photoIds[0]];

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    let decidedMidway = 0;
    do {
      const res: request.Response = await request(app).get('/v1/admin/content/photos')
        .query({ limit: 2, ...(cursor ? { cursor } : {}) }).set('Authorization', bearer('mod'));
      expect(res.status).toBe(200);
      expectContract(res, '/v1/admin/content/photos', 'get');
      seen.push(...res.body.data.map((p: { id: string }) => p.id));
      cursor = res.body.meta.nextCursor;
      pages++;
      // Deciding an item already listed must not shift later pages
      if (pages === 1) decidedMidway = (await reviewPhoto('mod', res.body.data[0].id, { decision: 'approve' })).status;
    } while (cursor);

    expect(decidedMidway).toBe(200);

    expect(seen).toEqual(expected);
    expect(pages).toBe(3);

    const first = await request(app).get('/v1/admin/content/photos').set('Authorization', bearer('mod'));
    expect(first.body.data[0]).toEqual({
      id: alice.photoIds[2],
      ownerId: alice.userId,
      width: 1080,
      height: 1350,
      submittedAt: expect.any(String),
      media: {
        thumb: `/v1/admin/content/photos/${alice.photoIds[2]}/media/thumb`,
        display: `/v1/admin/content/photos/${alice.photoIds[2]}/media/display`,
      },
    });
    expect(first.body.meta.nextCursor).toBeNull();
  });

  it('lists only pending prompt answers, oldest submission first', async () => {
    const alice = await seedMember('alice', { answers: ['pending', 'approved', 'edit-pending'] });
    const bob = await seedMember('bob', { answers: ['rejected', 'pending'] });

    const page1 = await request(app).get('/v1/admin/content/prompt-answers?limit=2').set('Authorization', bearer('mod'));
    expect(page1.status).toBe(200);
    expectContract(page1, '/v1/admin/content/prompt-answers', 'get');
    const page2 = await request(app).get('/v1/admin/content/prompt-answers')
      .query({ limit: 2, cursor: page1.body.meta.nextCursor }).set('Authorization', bearer('mod'));
    expect(page2.body.meta.nextCursor).toBeNull();

    const items = [...page1.body.data, ...page2.body.data];
    expect(items.map((a: { id: string }) => a.id)).toEqual([alice.answerIds[0], alice.answerIds[2], bob.answerIds[1]]);
    expect(items[1]).toEqual({
      id: alice.answerIds[2],
      ownerId: alice.userId,
      promptId: 'prompt-sunday',
      promptText: 'My ideal Sunday looks like…',
      pendingText: 'alice submitted answer 2',
      hasPublishedText: true,
      revision: 2,
      submittedAt: expect.any(String),
    });

    // An owner edit is a new submission: it moves to the back of the queue
    const edit = await request(app).patch(`/v1/me/prompts/${alice.answerIds[0]}`).set('Authorization', bearer('alice'))
      .send({ expectedRevision: 1, text: 'A fresh take' });
    expect(edit.status).toBe(200);
    const after = await request(app).get('/v1/admin/content/prompt-answers').set('Authorization', bearer('mod'));
    expect(after.body.data.map((a: { id: string }) => a.id)).toEqual([alice.answerIds[2], bob.answerIds[1], alice.answerIds[0]]);
  });

  it('rejects malformed cursors and page sizes', async () => {
    for (const query of [{ cursor: 'not-a-cursor' }, { cursor: Buffer.from('[1,2,3]').toString('base64url') }]) {
      const res = await request(app).get('/v1/admin/content/photos').query(query).set('Authorization', bearer('mod'));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_CURSOR');
    }
    for (const limit of ['0', '51', 'abc', '2.5']) {
      const res = await request(app).get('/v1/admin/content/prompt-answers').query({ limit }).set('Authorization', bearer('mod'));
      expect(res.status, `limit=${limit}`).toBe(422);
      expectContract(res, '/v1/admin/content/prompt-answers', 'get');
    }
  });
});

describe('photo review', () => {
  it('approving the third photo publishes it, makes the profile ready and audits the decision', async () => {
    const m = await seedMember('alice', { photos: ['approved', 'approved', 'pending'], answers: ['approved', 'approved', 'approved'] });
    await seedVisibleMember('bob');
    const photoId = m.photoIds[2]!;
    expect((await request(app).get(`/v1/media/${photoId}/display`).set('Authorization', bearer('bob'))).status).toBe(404);
    const guardBefore = (await getUser('alice'))!.guardVersion;

    const res = await request(app).post(`/v1/admin/content/photos/${photoId}/review`)
      .set('Authorization', bearer('mod')).set('X-Request-Id', 'req-approve-1')
      .send({ decision: 'approve', note: 'Clear, friendly photo' });
    expect(res.status).toBe(200);
    expectContract(res, '/v1/admin/content/photos/{id}/review', 'post');
    expect(res.body.data).toEqual({ id: photoId, state: 'approved', rejectionReason: null, auditId: expect.any(String) });

    expect((await getPhoto(photoId))!.state).toBe('approved');
    const alice = (await getUser('alice'))!;
    expect(alice.profileReady).toBe(true);
    expect(alice.accountStatus).toBe('active');
    expect(alice.guardVersion).toBeGreaterThan(guardBefore);

    const entries = await audits().find().toArray();
    expect(entries).toEqual([{
      _id: res.body.data.auditId,
      actorUid: 'staff-mod',
      actorRole: 'moderator',
      action: 'photo.approve',
      targetType: 'photo',
      targetId: photoId,
      targetOwnerId: m.userId,
      reason: null,
      note: 'Clear, friendly photo',
      before: { state: 'pending', moderationReason: null },
      after: { state: 'approved', moderationReason: null },
      requestId: 'req-approve-1',
      createdAt: clock.now,
    }]);

    const served = await request(app).get(`/v1/media/${photoId}/display`).set('Authorization', bearer('bob'));
    expect(served.status).toBe(200);
  });

  it('rejecting stores the catalog reason the owner sees, leaves the orderable set and audits', async () => {
    const m = await seedMember('alice', { photos: ['approved', 'pending'] });
    const res = await reviewPhoto('mod', m.photoIds[1]!, { decision: 'reject', reason: 'contact_details' });
    expect(res.status).toBe(200);
    expect(res.body.data.rejectionReason.code).toBe('contact_details');

    const own = await request(app).get('/v1/me/photos').set('Authorization', bearer('alice'));
    expect(own.body.data.revision).toBe(2);
    const rejected = own.body.data.photos.find((p: { id: string }) => p.id === m.photoIds[1]);
    expect(rejected).toMatchObject({ state: 'rejected', rejectionReason: { code: 'contact_details', message: expect.any(String) } });

    const [entry] = await audits().find().toArray();
    expect(entry).toMatchObject({
      action: 'photo.reject',
      reason: 'contact_details',
      note: null,
      before: { state: 'pending', moderationReason: null },
      after: { state: 'rejected', moderationReason: 'contact_details' },
    });
  });

  it('validates the decision and writes nothing on invalid input', async () => {
    const m = await seedMember('alice', { photos: ['pending'] });
    const id = m.photoIds[0]!;
    for (const body of [
      {},
      { decision: 'reject' },
      { decision: 'reject', reason: 'ugly' },
      { decision: 'approve', reason: 'low_quality' },
      { decision: 'maybe' },
      { decision: 'approve', note: 'x'.repeat(501) },
      { decision: 'approve', state: 'approved' },
    ]) {
      const res = await reviewPhoto('mod', id, body);
      expect(res.status, `${JSON.stringify(body)}`).toBe(422);
      expectContract(res, '/v1/admin/content/photos/{id}/review', 'post');
    }
    expect((await getPhoto(id))!.state).toBe('pending');
    expect(await audits().countDocuments()).toBe(0);

    const missing = await reviewPhoto('mod', 'no-such-photo', { decision: 'approve' });
    expect(missing.status).toBe(404);
  });

  it('a second decision on the same photo conflicts and is not audited', async () => {
    const m = await seedMember('alice', { photos: ['pending'] });
    expect((await reviewPhoto('mod', m.photoIds[0]!, { decision: 'approve' })).status).toBe(200);
    const again = await reviewPhoto('mod2', m.photoIds[0]!, { decision: 'reject', reason: 'low_quality' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('REVIEW_CONFLICT');
    expectContract(again, '/v1/admin/content/photos/{id}/review', 'post');
    expect((await getPhoto(m.photoIds[0]!))!.state).toBe('approved');
    expect(await audits().countDocuments()).toBe(1);
  });

  it('shows a reviewer the photo with minimal owner context and no private account fields', async () => {
    const m = await seedMember('alice', { photos: ['approved', 'pending', 'deleted', 'rejected'] });
    const res = await request(app).get(`/v1/admin/content/photos/${m.photoIds[1]}`).set('Authorization', bearer('mod'));
    expect(res.status).toBe(200);
    expectContract(res, '/v1/admin/content/photos/{id}', 'get');
    expect(res.body.data).toMatchObject({
      id: m.photoIds[1],
      state: 'pending',
      owner: { userId: m.userId, displayName: 'alice', accountStatus: 'onboarding' },
    });
    expect(res.body.data.ownerPhotos.map((p: { id: string }) => p.id)).toEqual([m.photoIds[0], m.photoIds[3]]);
    const raw = JSON.stringify(res.body);
    for (const secret of ['1994-05-12', 'uid-alice', 'firebaseUid', 'birthDate', 'email', 'quarantine/', 'public-variants/']) {
      expect(raw).not.toContain(secret);
    }

    expect((await request(app).get(`/v1/admin/content/photos/${m.photoIds[2]}`).set('Authorization', bearer('mod'))).status).toBe(404);
  });
});

describe('quarantine media', () => {
  it('is streamed to staff only, never cached, and never as the private master', async () => {
    const m = await seedMember('alice', { photos: ['pending', 'deleted'] });
    await seedVisibleMember('bob');
    const id = m.photoIds[0]!;

    const res = await request(app).get(`/v1/admin/content/photos/${id}/media/display`).set('Authorization', bearer('mod'))
      .buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect((res.body as Buffer).toString()).toBe(`display-${id}`);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['content-type']).toBe('image/webp');

    for (const variant of ['original', 'master', '..', 'quarantine']) {
      expect((await request(app).get(`/v1/admin/content/photos/${id}/media/${variant}`).set('Authorization', bearer('mod'))).status).toBe(404);
    }
    expect((await request(app).get(`/v1/admin/content/photos/${m.photoIds[1]}/media/display`).set('Authorization', bearer('mod'))).status).toBe(404);

    // Members: not through the admin route, and pending photos stay hidden on the public route
    expect((await request(app).get(`/v1/admin/content/photos/${id}/media/display`).set('Authorization', bearer('bob'))).status).toBe(403);
    expect((await request(app).get(`/v1/admin/content/photos/${id}/media/display`).set('Authorization', bearer('alice'))).status).toBe(403);
    expect((await request(app).get(`/v1/media/${id}/display`).set('Authorization', bearer('bob'))).status).toBe(404);
  });
});

describe('prompt answer review', () => {
  it('approving publishes the pending text, bumps publishedRevision and recomputes readiness', async () => {
    const m = await seedMember('alice', { photos: ['approved', 'approved', 'approved'], answers: ['approved', 'approved', 'pending'] });
    await seedVisibleMember('bob');
    const id = m.answerIds[2]!;

    const detail = await request(app).get(`/v1/admin/content/prompt-answers/${id}`).set('Authorization', bearer('mod'));
    expect(detail.status).toBe(200);
    expectContract(detail, '/v1/admin/content/prompt-answers/{id}', 'get');
    expect(detail.body.data).toMatchObject({ state: 'pending', pendingText: 'alice submitted answer 2', approvedText: null, revision: 1 });

    const res = await reviewAnswer('mod', id, { decision: 'approve', expectedRevision: detail.body.data.revision });
    expect(res.status).toBe(200);
    expectContract(res, '/v1/admin/content/prompt-answers/{id}/review', 'post');
    expect(res.body.data).toEqual({ id, state: 'approved', publishedRevision: 1, rejectionReason: null, auditId: expect.any(String) });

    const answer = (await getAnswer(id))!;
    expect(answer).toMatchObject({ approvedText: 'alice submitted answer 2', pendingText: null, state: 'approved', publishedRevision: 1, revision: 1, rejectionReason: null });
    expect((await getUser('alice'))!).toMatchObject({ profileReady: true, accountStatus: 'active' });

    const profile = await request(app).get(`/v1/profiles/${m.userId}`).set('Authorization', bearer('bob'));
    expect(profile.status).toBe(200);
    expect(profile.body.data.promptAnswers.map((a: { text: string }) => a.text)).toContain('alice submitted answer 2');

    const [entry] = await audits().find().toArray();
    expect(entry).toMatchObject({
      action: 'prompt_answer.approve',
      targetType: 'promptAnswer',
      targetId: id,
      before: { state: 'pending', revision: 1, publishedRevision: 0, rejectionReason: null, pendingTextSha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      after: { state: 'approved', revision: 1, publishedRevision: 1, rejectionReason: null },
    });
    // Audit entries never carry the answer text itself
    expect(JSON.stringify(entry)).not.toContain('alice submitted answer 2');
  });

  it('approving an edit replaces the published text and bumps the content version', async () => {
    const m = await seedMember('alice', { answers: ['edit-pending'] });
    const res = await reviewAnswer('mod', m.answerIds[0]!, { decision: 'approve', expectedRevision: 2 });
    expect(res.body.data.publishedRevision).toBe(2);
    expect((await getAnswer(m.answerIds[0]!))!.approvedText).toBe('alice submitted answer 0');
  });

  it('rejecting an edit keeps the published text live, shows the owner the reason and never the public', async () => {
    const m = await seedMember('alice', { status: 'active', ready: true, photos: ['approved', 'approved', 'approved'], answers: ['approved', 'approved', 'edit-pending'] });
    await seedVisibleMember('bob');
    const id = m.answerIds[2]!;

    const res = await reviewAnswer('mod', id, { decision: 'reject', reason: 'contact_details', note: 'Instagram handle in text', expectedRevision: 2 });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ state: 'rejected', publishedRevision: 1, rejectionReason: { code: 'contact_details', action: 'replace' } });
    expect((await getAnswer(id))!).toMatchObject({
      approvedText: 'alice published answer 2', pendingText: 'alice submitted answer 2', state: 'rejected', rejectionReason: 'contact_details', publishedRevision: 1,
    });
    expect((await getUser('alice'))!.profileReady).toBe(true);

    // Owner: the reason, a localization key and the replace action
    const own = await request(app).get('/v1/me/profile').set('Authorization', bearer('alice'));
    expectContract(own, '/v1/me/profile', 'get');
    const ownAnswer = own.body.data.promptAnswers.find((a: { id: string }) => a.id === id);
    expect(ownAnswer).toMatchObject({
      state: 'rejected',
      approvedText: 'alice published answer 2',
      pendingText: 'alice submitted answer 2',
      rejectionReason: {
        code: 'contact_details',
        messageKey: 'promptRejection.contactDetails',
        message: expect.any(String),
        action: 'replace',
      },
    });
    for (const a of own.body.data.promptAnswers.filter((x: { id: string }) => x.id !== id)) expect(a.rejectionReason).toBeNull();

    // Public: the previously approved text, no rejection or pending data anywhere
    for (const res2 of [
      await request(app).get(`/v1/profiles/${m.userId}`).set('Authorization', bearer('bob')),
      await request(app).get('/v1/me/profile/preview').set('Authorization', bearer('alice')),
    ]) {
      expect(res2.status).toBe(200);
      expect(res2.body.data.promptAnswers.map((a: { text: string }) => a.text)).toContain('alice published answer 2');
      const raw = JSON.stringify(res2.body);
      for (const leak of ['rejection', 'contact_details', 'promptRejection', 'alice submitted answer 2', 'moderation', 'pending']) {
        expect(raw).not.toContain(leak);
      }
    }

    // Replacing the text resubmits it; the old reason is no longer shown
    const replace = await request(app).patch(`/v1/me/prompts/${id}`).set('Authorization', bearer('alice'))
      .send({ expectedRevision: 2, text: 'Coffee ceremony with my grandmother' });
    expect(replace.status).toBe(200);
    const after = await request(app).get('/v1/me/profile').set('Authorization', bearer('alice'));
    expect(after.body.data.promptAnswers.find((a: { id: string }) => a.id === id)).toMatchObject({ state: 'pending', rejectionReason: null });
    const queue = await request(app).get('/v1/admin/content/prompt-answers').set('Authorization', bearer('mod'));
    expect(queue.body.data.map((a: { id: string }) => a.id)).toEqual([id]);
  });

  it('a decision based on a stale revision conflicts with the current revision and writes nothing', async () => {
    const m = await seedMember('alice', { answers: ['pending'] });
    const id = m.answerIds[0]!;
    // Owner edits after the reviewer loaded revision 1
    await request(app).patch(`/v1/me/prompts/${id}`).set('Authorization', bearer('alice')).send({ expectedRevision: 1, text: 'Changed my mind' });

    const res = await reviewAnswer('mod', id, { decision: 'approve', expectedRevision: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'REVIEW_CONFLICT', currentRevision: 2 });
    expectContract(res, '/v1/admin/content/prompt-answers/{id}/review', 'post');
    expect((await getAnswer(id))!).toMatchObject({ state: 'pending', approvedText: null, pendingText: 'Changed my mind' });
    expect(await audits().countDocuments()).toBe(0);

    // Reviewing what is actually there works
    expect((await reviewAnswer('mod', id, { decision: 'approve', expectedRevision: 2 })).status).toBe(200);
    expect((await getAnswer(id))!.approvedText).toBe('Changed my mind');
  });

  it('validates the decision body', async () => {
    const m = await seedMember('alice', { answers: ['pending', 'approved'] });
    for (const body of [
      { decision: 'approve' },
      { decision: 'approve', expectedRevision: '1' },
      { decision: 'reject', expectedRevision: 1 },
      { decision: 'reject', reason: 'low_quality', expectedRevision: 1 }, // a photo reason
      { decision: 'approve', expectedRevision: 1, pendingText: 'sneaky' },
    ]) {
      expect((await reviewAnswer('mod', m.answerIds[0]!, body)).status, `${JSON.stringify(body)}`).toBe(422);
    }
    expect((await reviewAnswer('mod', m.answerIds[1]!, { decision: 'approve', expectedRevision: 1 })).status).toBe(409);
    expect((await reviewAnswer('mod', 'nope', { decision: 'approve', expectedRevision: 1 })).status).toBe(404);
    expect(await audits().countDocuments()).toBe(0);
  });
});

describe('concurrent decisions', () => {
  it.each([1, 2, 3, 4, 5])('exactly one of several racing photo decisions wins (round %i)', async (round) => {
    const m = await seedMember(`racer${round}`, { photos: ['approved', 'approved', 'pending'], answers: ['approved', 'approved', 'approved'] });
    const id = m.photoIds[2]!;
    const reviewers = ['mod', 'mod2', 'admin', 'admin2', 'mod', 'admin'];
    const results = await Promise.all(reviewers.map((as, i) =>
      reviewPhoto(as, id, i % 2 === 0 ? { decision: 'approve' } : { decision: 'reject', reason: 'low_quality' })));

    const winners = results.filter((r) => r.status === 200);
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(reviewers.length - 1);

    const entries = await audits().find({ targetId: id }).toArray();
    expect(entries).toHaveLength(1);
    expect(entries[0]!._id).toBe(winners[0]!.body.data.auditId);
    const photo = (await getPhoto(id))!;
    expect(photo.state).toBe(winners[0]!.body.data.state);
    expect(entries[0]!.after).toEqual({ state: photo.state, moderationReason: photo.moderationReason });
    expect((await getUser(`racer${round}`))!.profileReady).toBe(photo.state === 'approved');
  });

  it.each([1, 2, 3, 4, 5])('exactly one of several racing prompt decisions wins (round %i)', async (round) => {
    const m = await seedMember(`racer${round}`, { answers: ['pending'] });
    const id = m.answerIds[0]!;
    const results = await Promise.all(['mod', 'mod2', 'admin', 'admin2', 'mod2'].map((as, i) =>
      reviewAnswer(as, id, i % 2 === 0
        ? { decision: 'approve', expectedRevision: 1 }
        : { decision: 'reject', reason: 'promotional', expectedRevision: 1 })));

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    expect(await audits().countDocuments({ targetId: id })).toBe(1);
    const answer = (await getAnswer(id))!;
    expect(answer.publishedRevision).toBe(answer.state === 'approved' ? 1 : 0);
  });

  it('an owner edit racing a review never publishes text the reviewer did not see', async () => {
    for (let round = 0; round < 5; round++) {
      const m = await seedMember(`editor${round}`, { answers: ['pending'] });
      const id = m.answerIds[0]!;
      const [review, edit] = await Promise.all([
        reviewAnswer('mod', id, { decision: 'approve', expectedRevision: 1 }),
        request(app).patch(`/v1/me/prompts/${id}`).set('Authorization', bearer(`editor${round}`)).send({ expectedRevision: 1, text: `unseen ${round}` }),
      ]);
      const answer = (await getAnswer(id))!;
      const audited = await audits().countDocuments({ targetId: id });
      expect(answer.approvedText).not.toBe(`unseen ${round}`);
      // Either the review won (the edit then landed as a new submission or lost its
      // revision race), or the edit won and the review conflicted without writing
      const reviewWon = review.status === 200;
      expect({
        review: review.status,
        edit: [200, 409].includes(edit.status),
        approvedText: answer.approvedText,
        pendingText: reviewWon ? 'n/a' : answer.pendingText,
        audited,
      }).toEqual(reviewWon
        ? { review: 200, edit: true, approvedText: `editor${round} submitted answer 0`, pendingText: 'n/a', audited: 1 }
        : { review: 409, edit: true, approvedText: null, pendingText: `unseen ${round}`, audited: 0 });
    }
  });

  it('exactly one of several racing suspensions wins', async () => {
    const m = await seedVisibleMember('alice');
    const results = await Promise.all(['admin', 'admin2', 'admin', 'admin2'].map((as) =>
      request(app).post(`/v1/admin/users/${m.userId}/suspend`).set('Authorization', bearer(as)).send({ reason: 'scam_or_spam' })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.error.code === 'ACCOUNT_STATE_CONFLICT')).toBe(true);
    expect(await audits().countDocuments({ targetId: m.userId })).toBe(1);
  });
});

describe('audit atomicity', () => {
  /** Make every audit insert fail at the database, so the decision's transaction must roll back. */
  async function breakAuditLog() {
    await db.collection(ADMIN_AUDIT_COLLECTION).drop().catch(() => undefined);
    await db.createCollection(ADMIN_AUDIT_COLLECTION, { validator: { $jsonSchema: { required: ['fieldThatNeverExists'] } } });
  }
  async function repairAuditLog() {
    await db.collection(ADMIN_AUDIT_COLLECTION).drop();
    await ensureAdminIndexes(db);
  }

  it('rolls back photo, prompt and account decisions when the audit entry cannot be written', async () => {
    const m = await seedMember('alice', { status: 'active', ready: true, photos: ['approved', 'approved', 'approved', 'pending'], answers: ['approved', 'approved', 'approved', 'pending'] });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await breakAuditLog();
    try {
      expect((await reviewPhoto('mod', m.photoIds[3]!, { decision: 'reject', reason: 'low_quality' })).status).toBe(500);
      expect((await reviewAnswer('mod', m.answerIds[3]!, { decision: 'approve', expectedRevision: 1 })).status).toBe(500);
      expect((await request(app).post(`/v1/admin/users/${m.userId}/suspend`).set('Authorization', bearer('admin'))
        .send({ reason: 'harassment' })).status).toBe(500);
    } finally {
      await repairAuditLog();
      errors.mockRestore();
    }

    expect((await getPhoto(m.photoIds[3]!))!).toMatchObject({ state: 'pending', moderationReason: null, reviewedAt: null });
    expect((await getAnswer(m.answerIds[3]!))!).toMatchObject({ state: 'pending', approvedText: null, publishedRevision: 0 });
    expect((await getUser('alice'))!).toMatchObject({ accountStatus: 'active', guardVersion: 1, profileReady: true });
    expect(await audits().countDocuments()).toBe(0);
    const set = await db.collection('photoSets').findOne({ _id: m.userId });
    expect(set!['revision']).toBe(1);

    // Once the log is writable again the same decisions go through with their entries
    expect((await reviewPhoto('mod', m.photoIds[3]!, { decision: 'reject', reason: 'low_quality' })).status).toBe(200);
    expect(await audits().countDocuments()).toBe(1);
  });

  it('leaves no audit entry and no decision when the transaction aborts after the entry was written', async () => {
    const m = await seedMember('alice', { status: 'active', ready: true, photos: ['approved', 'approved', 'approved', 'pending'], answers: ['approved', 'approved', 'approved', 'pending'] });
    const written: string[] = [];
    const failing = createApp({
      mongoCheck: async () => true,
      firebaseCheck: async () => true,
      routes: [createAdminRoutes(db, client, auth, { MEDIA_LOCAL_DIR: 'unused', ADMIN_RECENT_AUTH_MAX_AGE_SECONDS: 900 }, {
        storage,
        now: () => clock.now,
        afterAuditWrite: async (entry) => {
          written.push(entry.action);
          throw new Error('crash after audit write');
        },
      })],
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect((await request(failing).post(`/v1/admin/content/photos/${m.photoIds[3]}/review`).set('Authorization', bearer('mod'))
        .send({ decision: 'approve' })).status).toBe(500);
      expect((await request(failing).post(`/v1/admin/content/prompt-answers/${m.answerIds[3]}/review`).set('Authorization', bearer('mod'))
        .send({ decision: 'reject', reason: 'promotional', expectedRevision: 1 })).status).toBe(500);
      expect((await request(failing).post(`/v1/admin/users/${m.userId}/suspend`).set('Authorization', bearer('admin'))
        .send({ reason: 'harassment' })).status).toBe(500);
    } finally {
      errors.mockRestore();
    }

    expect(written).toEqual(['photo.approve', 'prompt_answer.reject', 'account.suspend']);
    expect(await audits().countDocuments()).toBe(0);
    expect((await getPhoto(m.photoIds[3]!))!.state).toBe('pending');
    expect((await getAnswer(m.answerIds[3]!))!).toMatchObject({ state: 'pending', publishedRevision: 0 });
    expect((await getAnswer(m.answerIds[3]!))!.rejectionReason ?? null).toBeNull();
    expect((await getUser('alice'))!).toMatchObject({ accountStatus: 'active', guardVersion: 1 });
  });

  it('server logs never contain tokens, answer text or account details', async () => {
    const m = await seedMember('alice', { answers: ['pending'] });
    const lines: string[] = [];
    const capture = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    const spies = (['log', 'info', 'warn', 'error'] as const).map((level) => vi.spyOn(console, level).mockImplementation(capture));
    await breakAuditLog();
    try {
      await reviewAnswer('mod', m.answerIds[0]!, { decision: 'approve', expectedRevision: 1, note: 'private staff note' });
    } finally {
      await repairAuditLog();
      spies.forEach((s) => s.mockRestore());
    }
    await reviewAnswer('mod', m.answerIds[0]!, { decision: 'approve', expectedRevision: 1 });
    const output = lines.join('\n');
    for (const secret of ['token-mod', 'alice submitted answer 0', 'private staff note', '1994-05-12', 'uid-alice', 'staff-mod']) {
      expect(output).not.toContain(secret);
    }
  });
});

describe('account suspension and restore', () => {
  it('suspends immediately for new actions and restores without auto-reopening anything else', async () => {
    const m = await seedVisibleMember('alice');
    await seedVisibleMember('bob');
    const before = (await getUser('alice'))!;

    const res = await request(app).post(`/v1/admin/users/${m.userId}/suspend`).set('Authorization', bearer('admin'))
      .set('X-Request-Id', 'req-suspend-1').send({ reason: 'harassment', note: 'Reported in pilot test' });
    expect(res.status).toBe(200);
    expectContract(res, '/v1/admin/users/{id}/suspend', 'post');
    expect(res.body.data.account).toMatchObject({
      userId: m.userId, accountStatus: 'suspended', profileReady: false, suspension: { reason: 'harassment', suspendedAt: clock.now.toISOString() },
    });

    const suspended = (await getUser('alice'))!;
    expect(suspended.accountStatus).toBe('suspended');
    expect(suspended.profileReady).toBe(false);
    expect(suspended.guardVersion).toBeGreaterThan(before.guardVersion);

    // New actions stop: the account, its profile and its photos
    expect((await request(app).get('/v1/me').set('Authorization', bearer('alice'))).status).toBe(403);
    expect((await request(app).get(`/v1/profiles/${m.userId}`).set('Authorization', bearer('bob'))).status).toBe(404);
    expect((await request(app).get(`/v1/media/${m.photoIds[0]}/display`).set('Authorization', bearer('bob'))).status).toBe(404);

    const [entry] = await audits().find().toArray();
    expect(entry).toMatchObject({
      actorUid: 'staff-admin',
      actorRole: 'admin',
      action: 'account.suspend',
      targetType: 'user',
      targetId: m.userId,
      reason: 'harassment',
      note: 'Reported in pilot test',
      before: { accountStatus: 'active', guardVersion: before.guardVersion },
      after: { accountStatus: 'suspended', guardVersion: before.guardVersion + 1 },
      requestId: 'req-suspend-1',
    });

    const again = await request(app).post(`/v1/admin/users/${m.userId}/suspend`).set('Authorization', bearer('admin')).send({ reason: 'harassment' });
    expect(again.status).toBe(409);

    const restore = await request(app).post(`/v1/admin/users/${m.userId}/restore`).set('Authorization', bearer('admin2')).send({ reason: 'appeal_upheld' });
    expect(restore.status).toBe(200);
    expectContract(restore, '/v1/admin/users/{id}/restore', 'post');
    expect(restore.body.data.account).toMatchObject({ accountStatus: 'active', profileReady: true, suspension: null });
    expect((await request(app).get(`/v1/profiles/${m.userId}`).set('Authorization', bearer('bob'))).status).toBe(200);

    const restoreAgain = await request(app).post(`/v1/admin/users/${m.userId}/restore`).set('Authorization', bearer('admin')).send({ reason: 'appeal_upheld' });
    expect(restoreAgain.status).toBe(409);

    const history = await request(app).get('/v1/admin/audit-log').query({ targetType: 'user', targetId: m.userId }).set('Authorization', bearer('admin'));
    expect(history.status).toBe(200);
    expectContract(history, '/v1/admin/audit-log', 'get');
    expect(history.body.data.map((e: { action: string }) => e.action)).toEqual(['account.suspend', 'account.restore']);
  });

  it('restores an account suspended during onboarding to onboarding', async () => {
    const m = await seedMember('alice');
    await request(app).post(`/v1/admin/users/${m.userId}/suspend`).set('Authorization', bearer('admin')).send({ reason: 'scam_or_spam' });
    const res = await request(app).post(`/v1/admin/users/${m.userId}/restore`).set('Authorization', bearer('admin')).send({ reason: 'decision_error' });
    expect(res.body.data.account.accountStatus).toBe('onboarding');
  });

  it('requires a catalog reason, rejects other states and unknown fields, and writes nothing', async () => {
    const m = await seedVisibleMember('alice');
    await seedMember('dora', { status: 'deletion_pending' });
    const suspend = (id: string, body: Record<string, unknown>) =>
      request(app).post(`/v1/admin/users/${id}/suspend`).set('Authorization', bearer('admin')).send(body);

    for (const body of [{}, { reason: 'because' }, { reason: 'harassment', accountStatus: 'active' }, { reason: 'appeal_upheld' }]) {
      const res = await suspend(m.userId, body);
      expect(res.status, `${JSON.stringify(body)}`).toBe(422);
      expectContract(res, '/v1/admin/users/{id}/suspend', 'post');
    }
    expect((await suspend(userIdOf('dora'), { reason: 'harassment' })).status).toBe(409);
    expect((await suspend('no-such-user', { reason: 'harassment' })).status).toBe(404);
    expect((await request(app).post(`/v1/admin/users/${m.userId}/restore`).set('Authorization', bearer('admin')).send({ reason: 'appeal_upheld' })).status).toBe(409);
    expect((await getUser('alice'))!.accountStatus).toBe('active');
    expect(await audits().countDocuments()).toBe(0);
  });

  it('shows administrators an account summary without private fields', async () => {
    const m = await seedVisibleMember('alice');
    const res = await request(app).get(`/v1/admin/users/${m.userId}`).set('Authorization', bearer('admin'));
    expect(res.status).toBe(200);
    expectContract(res, '/v1/admin/users/{id}', 'get');
    expect(Object.keys(res.body.data).sort()).toEqual(['accountStatus', 'createdAt', 'displayName', 'guardVersion', 'profileReady', 'suspension', 'userId']);
    expect((await request(app).get('/v1/admin/users/nobody').set('Authorization', bearer('admin'))).status).toBe(404);
  });
});

describe('reason catalog and audit queries', () => {
  it('lists every catalog', async () => {
    const res = await request(app).get('/v1/admin/reasons').set('Authorization', bearer('mod'));
    expect(res.status).toBe(200);
    expectContract(res, '/v1/admin/reasons', 'get');
    const codes = (list: { code: string }[]) => list.map((r) => r.code);
    expect(codes(res.body.data.photoRejection)).toContain('contact_details');
    expect(codes(res.body.data.promptAnswerRejection)).toEqual(['contact_details', 'sexual_content', 'hateful_or_harassing', 'promotional', 'community_guidelines']);
    expect(codes(res.body.data.accountSuspension)).toContain('harassment');
    expect(codes(res.body.data.accountRestore)).toContain('appeal_upheld');
  });

  it('requires a target for audit queries', async () => {
    for (const query of [{}, { targetType: 'user' }, { targetType: 'everything', targetId: 'x' }]) {
      const res = await request(app).get('/v1/admin/audit-log').query(query).set('Authorization', bearer('admin'));
      expect(res.status).toBe(422);
    }
  });
});
