import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { parse } from 'yaml';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { MongoClient, type Collection, type Db } from 'mongodb';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { ensureIndexes } from '../src/indexes.js';
import {
  createLikesRoutes, noopPairGuard, LIKES_COLLECTION,
  type LikeDocument, type PairGuard,
} from '../src/modules/likes/index.js';
import { QUOTAS_COLLECTION, type QuotaDocument } from '../src/modules/likes/quota.js';
import { createEmptyProfile, type ProfileDocument, type PromptAnswerDocument } from '../src/modules/profiles/schema.js';
import { photoObjectKeys, type PhotoDocument } from '../src/modules/media/schema.js';
import type { UserDocument } from '../src/modules/auth/account.js';
import { createMultiUserAuth } from './support.js';

/**
 * Likes run against the real local MongoDB replica set: the unique indexes,
 * transactions and quota rollback are the behavior under test, so an
 * in-memory fake would prove nothing. Each run uses its own database.
 */

const uri = process.env['MONGO_URI']!;
const dbName = `lemon_test_likes_${process.pid}_${Date.now()}`;
const NOW = new Date('2026-10-25T15:00:00Z');
const PROMPTS = ['prompt-tradition', 'prompt-home', 'prompt-sunday'] as const;

let client: MongoClient;
let db: Db;
let likes: Collection<LikeDocument>;
let quotas: Collection<QuotaDocument>;
let app: ReturnType<typeof createApp>;

// Mutable per-test collaborators the app reads through
let clock = NOW;
let guard: PairGuard = noopPairGuard;

beforeAll(async () => {
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(`Likes integration tests need MongoDB at ${uri} (run the local replica set)`, { cause: err });
  }
  db = client.db(dbName);
  await ensureIndexes(db);
  likes = db.collection<LikeDocument>(LIKES_COLLECTION);
  quotas = db.collection<QuotaDocument>(QUOTAS_COLLECTION);
  app = buildLikesApp(8);
});

afterAll(async () => {
  await db?.dropDatabase();
  await client?.close();
});

beforeEach(async () => {
  clock = NOW;
  guard = noopPairGuard;
  await Promise.all(
    ['users', 'profiles', 'photos', 'promptAnswers', LIKES_COLLECTION, QUOTAS_COLLECTION]
      .map(name => db.collection(name).deleteMany({})),
  );
});

function buildLikesApp(dailyLikes: number) {
  return createApp({
    mongoCheck: async () => true,
    firebaseCheck: async () => true,
    routes: [
      createLikesRoutes(db, createMultiUserAuth(), { LIKES_PER_UTC_DAY: dailyLikes }, {
        now: () => clock,
        pairGuard: {
          check: ctx => guard.check(ctx),
          touch: ctx => guard.touch(ctx),
        },
      }),
    ],
  });
}

// --- Seeding ---------------------------------------------------------------

interface Seeded {
  name: string;
  userId: string;
  photoIds: string[];
  answerIds: string[];
}

async function seedUser(name: string, overrides: Partial<UserDocument> = {}): Promise<Seeded> {
  const userId = `user-${name}`;
  const user: UserDocument = {
    _id: userId,
    firebaseUid: `uid-${name}`,
    accountStatus: 'active',
    emailVerified: true,
    birthDate: '1995-03-10',
    adultEligible: true,
    discoverPaused: false,
    profileReady: true,
    guardVersion: 1,
    agreements: { termsVersion: '1.0', acceptedAt: NOW },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
  await db.collection<UserDocument>('users').insertOne(user);
  await db.collection<ProfileDocument>('profiles').insertOne({
    ...createEmptyProfile(userId),
    displayName: name[0]!.toUpperCase() + name.slice(1),
    genderIdentity: 'woman',
    cityId: 'city-dallas-tx',
    stateCode: 'TX',
    intention: 'serious',
  });

  const photoIds = [0, 1, 2].map(i => `${name}-photo-${i}`);
  await db.collection<PhotoDocument>('photos').insertMany(photoIds.map((id, i) => ({
    _id: id,
    ownerId: userId,
    state: 'approved',
    ...photoObjectKeys(userId, id),
    width: 1080,
    height: 1350,
    order: i,
    contentVersion: 1,
    moderationReason: null,
    requestHash: `hash-${id}`,
    reviewedAt: NOW,
    deletedAt: null,
    objectsPurgedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  })));

  const answerIds = PROMPTS.map((_, i) => `${name}-answer-${i}`);
  await db.collection<PromptAnswerDocument>('promptAnswers').insertMany(answerIds.map((id, i) => ({
    _id: id,
    ownerId: userId,
    promptId: PROMPTS[i]!,
    slot: i,
    approvedText: `${name} answer ${i}`,
    pendingText: null,
    state: 'approved',
    revision: 1,
    publishedRevision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  })));

  return { name, userId, photoIds, answerIds };
}

// --- Request helpers -------------------------------------------------------

const as = (name: string) => `Bearer token-${name}`;
let keySeq = 0;
const newKey = () => `test-key-${++keySeq}-${process.pid}`;

const photoTarget = (to: Seeded, i = 0, contentVersion = 1) =>
  ({ toUserId: to.userId, target: { kind: 'photo', id: to.photoIds[i], contentVersion } });
const promptTarget = (to: Seeded, i = 0, contentVersion = 1) =>
  ({ toUserId: to.userId, target: { kind: 'prompt', id: to.answerIds[i], contentVersion } });

function send(from: string, body: object, key: string = newKey()) {
  return request(app).post('/v1/likes').set('Authorization', as(from)).set('Idempotency-Key', key).send(body);
}
const incoming = (name: string, query = '') =>
  request(app).get(`/v1/likes/incoming${query}`).set('Authorization', as(name));
const decline = (name: string, likeId: string) =>
  request(app).post(`/v1/likes/${likeId}/decline`).set('Authorization', as(name));

async function usedLikes(userId: string): Promise<number> {
  const docs = await quotas.find({ userId }).toArray();
  return docs.reduce((sum, d) => sum + d.usedLikes, 0);
}

/** Every request waits at the pair check until `arrivals` requests are there, then all proceed */
function barrierGuard(arrivals: number): PairGuard {
  const waiting: (() => void)[] = [];
  let released = false;
  return {
    check: async () => {
      if (!released) {
        await new Promise<void>(resolve => {
          waiting.push(resolve);
          if (waiting.length === arrivals) {
            released = true;
            waiting.forEach(release => release());
          }
        });
      }
      return { ok: true };
    },
    touch: async () => {},
  };
}

// --- Contract --------------------------------------------------------------

const spec = parse(readFileSync(fileURLToPath(new URL('../../../contracts/openapi.yaml', import.meta.url)), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema(spec, 'openapi');

function expectContract(res: request.Response, apiPath: string, method: string) {
  const response = spec.paths[apiPath]?.[method]?.responses?.[String(res.status)];
  expect(response, `No contract for ${method.toUpperCase()} ${apiPath} ${res.status}`).toBeDefined();
  const base = response.$ref
    ? (response.$ref as string).slice(1)
    : `/paths/${apiPath.replace(/~/g, '~0').replace(/\//g, '~1')}/${method}/responses/${res.status}`;
  const validate = ajv.getSchema(`openapi#${base}/content/application~1json/schema`)!;
  validate(res.body);
  expect(validate.errors ?? [], `${method.toUpperCase()} ${apiPath} ${res.status}`).toEqual([]);
}

// ===========================================================================

describe('likes collection indexes (shared data contract)', () => {
  it('creates the unique direction, unique idempotency and incoming-list indexes', async () => {
    const indexes = await likes.indexes();
    const find = (key: Record<string, number>) =>
      indexes.find(ix => JSON.stringify(ix.key) === JSON.stringify(key));
    expect(find({ fromUserId: 1, toUserId: 1 })?.unique).toBe(true);
    expect(find({ fromUserId: 1, idempotencyKey: 1 })?.unique).toBe(true);
    expect(find({ toUserId: 1, state: 1, createdAt: -1 })).toBeDefined();
  });

  it('rejects a second like in the same direction at the database, whatever the key', async () => {
    const doc = {
      fromUserId: 'a', toUserId: 'b', target: { kind: 'photo' as const, id: 'p', contentVersion: 1 },
      contextSnapshot: { kind: 'photo' as const, width: 1, height: 1 }, state: 'pending' as const,
      createdAt: NOW, updatedAt: NOW,
    };
    await likes.insertOne({ ...doc, _id: 'l1', idempotencyKey: 'k1' });
    await expect(likes.insertOne({ ...doc, _id: 'l2', idempotencyKey: 'k2' })).rejects.toMatchObject({ code: 11000 });
    await expect(likes.insertOne({ ...doc, _id: 'l3', toUserId: 'c', idempotencyKey: 'k1' })).rejects.toMatchObject({ code: 11000 });
  });
});

describe('LIKES_PER_UTC_DAY config', () => {
  it('defaults to 8 and accepts a configured non-negative integer', () => {
    vi.stubEnv('LIKES_PER_UTC_DAY', undefined as unknown as string);
    expect(loadConfig().LIKES_PER_UTC_DAY).toBe(8);
    vi.stubEnv('LIKES_PER_UTC_DAY', '3');
    expect(loadConfig().LIKES_PER_UTC_DAY).toBe(3);
    vi.stubEnv('LIKES_PER_UTC_DAY', '-1');
    expect(() => loadConfig()).toThrow('LIKES_PER_UTC_DAY');
    vi.unstubAllEnvs();
  });
});

describe('POST /v1/likes', () => {
  it('creates a photo like with a comment, stores the contract shape and charges one like', async () => {
    await seedUser('alice');
    const bob = await seedUser('bob');

    const key = newKey();
    const res = await send('alice', { ...photoTarget(bob, 1), comment: '  Love this   photo ☕  ' }, key);
    expect(res.status).toBe(201);
    expectContract(res, '/v1/likes', 'post');
    expect(res.body.data.like).toEqual({
      id: expect.any(String),
      toUserId: bob.userId,
      target: { kind: 'photo', id: bob.photoIds[1], contentVersion: 1 },
      comment: 'Love this photo ☕',
      createdAt: NOW.toISOString(),
    });
    expect(res.body.data.quota).toEqual({ limit: 8, used: 1, remaining: 7, resetAt: '2026-10-26T00:00:00.000Z' });

    const stored = await likes.findOne({ _id: res.body.data.like.id });
    expect(stored).toEqual({
      _id: res.body.data.like.id,
      fromUserId: 'user-alice',
      toUserId: bob.userId,
      target: { kind: 'photo', id: bob.photoIds[1], contentVersion: 1 },
      comment: 'Love this photo ☕',
      contextSnapshot: { kind: 'photo', width: 1080, height: 1350 },
      state: 'pending',
      idempotencyKey: key,
      createdAt: NOW,
      updatedAt: NOW,
    });
    // No storage keys, moderation data or private fields in the snapshot
    expect(JSON.stringify(stored)).not.toMatch(/quarantine|public-variants|moderation|birthDate|uid-/);
    expect(await usedLikes('user-alice')).toBe(1);
  });

  it('creates a prompt like with a context snapshot of the prompt and published answer', async () => {
    await seedUser('alice');
    const bob = await seedUser('bob');

    const res = await send('alice', promptTarget(bob, 2));
    expect(res.status).toBe(201);
    expect(res.body.data.like.comment).toBeNull();
    const stored = (await likes.findOne({ _id: res.body.data.like.id }))!;
    expect(stored.contextSnapshot).toEqual({
      kind: 'prompt',
      promptId: 'prompt-sunday',
      promptText: 'My ideal Sunday looks like…',
      answerText: 'bob answer 2',
    });
    expect(stored).not.toHaveProperty('comment');
  });

  it('requires authentication and a well-formed Idempotency-Key', async () => {
    await seedUser('alice');
    const bob = await seedUser('bob');
    let res = await request(app).post('/v1/likes').send(photoTarget(bob));
    expect(res.status).toBe(401);
    expectContract(res, '/v1/likes', 'post');

    for (const key of [undefined, 'short', 'has spaces in it', 'x'.repeat(129)]) {
      const req = request(app).post('/v1/likes').set('Authorization', as('alice'));
      res = await (key === undefined ? req : req.set('Idempotency-Key', key)).send(photoTarget(bob));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    }
    expectContract(res, '/v1/likes', 'post');
    expect(await likes.countDocuments()).toBe(0);
  });

  it('validates the request body', async () => {
    await seedUser('alice');
    const bob = await seedUser('bob');
    const bodies = [
      {},
      { toUserId: bob.userId },
      { toUserId: bob.userId, target: { kind: 'bio', id: 'x', contentVersion: 1 } },
      { toUserId: bob.userId, target: { kind: 'photo', id: bob.photoIds[0] } },
      { toUserId: bob.userId, target: { kind: 'photo', id: bob.photoIds[0], contentVersion: 1.5 } },
      { toUserId: bob.userId, target: { kind: 'photo', id: bob.photoIds[0], contentVersion: 0 } },
      { ...photoTarget(bob), comment: 42 },
    ];
    for (const body of bodies) {
      const res = await send('alice', body);
      expect(res.status, `${JSON.stringify(body)}`).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.fieldErrors.length).toBeGreaterThan(0);
      expectContract(res, '/v1/likes', 'post');
    }
    expect(await usedLikes('user-alice')).toBe(0);
  });

  it('rejects a self like without charging', async () => {
    const alice = await seedUser('alice');
    const res = await send('alice', photoTarget(alice));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SELF_LIKE');
    expectContract(res, '/v1/likes', 'post');
    expect(await likes.countDocuments()).toBe(0);
    expect(await usedLikes(alice.userId)).toBe(0);
  });

  it('ignores a spoofed sender in the body: identity comes from the token only', async () => {
    await seedUser('alice');
    const bob = await seedUser('bob');
    const victim = await seedUser('victim');

    const res = await send('alice', {
      ...photoTarget(bob),
      fromUserId: victim.userId,
      uid: 'uid-victim',
      firebaseUid: 'uid-victim',
      state: 'accepted',
    });
    expect(res.status).toBe(201);
    const stored = (await likes.findOne({ _id: res.body.data.like.id }))!;
    expect(stored.fromUserId).toBe('user-alice');
    expect(stored.state).toBe('pending');
    expect(stored).not.toHaveProperty('uid');
    expect(await usedLikes('user-alice')).toBe(1);
    expect(await usedLikes(victim.userId)).toBe(0);
  });

  describe('target validation (all rejections charge nothing)', () => {
    it('rejects a target owned by someone other than the recipient', async () => {
      await seedUser('alice');
      const bob = await seedUser('bob');
      const carol = await seedUser('carol');

      for (const body of [
        { toUserId: bob.userId, target: { kind: 'photo', id: carol.photoIds[0], contentVersion: 1 } },
        { toUserId: bob.userId, target: { kind: 'prompt', id: carol.answerIds[0], contentVersion: 1 } },
        { toUserId: bob.userId, target: { kind: 'prompt', id: bob.photoIds[0], contentVersion: 1 } }, // wrong kind
        { toUserId: bob.userId, target: { kind: 'photo', id: 'no-such-photo', contentVersion: 1 } },
      ]) {
        const res = await send('alice', body);
        expect(res.status, `${JSON.stringify(body)}`).toBe(409);
        expect(res.body.error.code).toBe('TARGET_UNAVAILABLE');
        expectContract(res, '/v1/likes', 'post');
      }
      expect(await likes.countDocuments()).toBe(0);
      expect(await usedLikes('user-alice')).toBe(0);
    });

    it('rejects a stale content version with 409', async () => {
      await seedUser('alice');
      const bob = await seedUser('bob');
      await db.collection<PromptAnswerDocument>('promptAnswers').updateOne(
        { _id: bob.answerIds[0] },
        { $set: { approvedText: 'bob answer 0, edited', publishedRevision: 2 } },
      );

      for (const body of [photoTarget(bob, 0, 2), promptTarget(bob, 0, 1)]) {
        const res = await send('alice', body);
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('TARGET_STALE');
        expectContract(res, '/v1/likes', 'post');
      }
      expect(await usedLikes('user-alice')).toBe(0);

      // The current version is fine
      expect((await send('alice', promptTarget(bob, 0, 2))).status).toBe(201);
    });

    it('rejects deleted, rejected, pending and unpublished targets', async () => {
      await seedUser('alice');
      const bob = await seedUser('bob');
      const photos = db.collection<PhotoDocument>('photos');
      await photos.updateOne({ _id: bob.photoIds[0] }, { $set: { state: 'deleted', deletedAt: NOW } });
      await photos.updateOne({ _id: bob.photoIds[1] }, { $set: { state: 'rejected', moderationReason: 'low_quality' } });
      await photos.updateOne({ _id: bob.photoIds[2] }, { $set: { state: 'pending' } });
      await db.collection<PromptAnswerDocument>('promptAnswers').updateOne(
        { _id: bob.answerIds[0] },
        { $set: { approvedText: null, pendingText: 'awaiting review', state: 'pending', publishedRevision: 0 } },
      );
      await db.collection<PromptAnswerDocument>('promptAnswers').deleteOne({ _id: bob.answerIds[1] });

      for (const body of [photoTarget(bob, 0), photoTarget(bob, 1), photoTarget(bob, 2), promptTarget(bob, 0), promptTarget(bob, 1)]) {
        const res = await send('alice', body);
        expect(res.status, `${JSON.stringify(body)}`).toBe(409);
        expect(res.body.error.code).toBe('TARGET_UNAVAILABLE');
      }
      expect(await likes.countDocuments()).toBe(0);
      expect(await usedLikes('user-alice')).toBe(0);
    });

    it('accepts a published answer whose newer edit is still awaiting review', async () => {
      await seedUser('alice');
      const bob = await seedUser('bob');
      await db.collection<PromptAnswerDocument>('promptAnswers').updateOne(
        { _id: bob.answerIds[0] },
        { $set: { pendingText: 'new words', state: 'pending', revision: 2 } },
      );
      const res = await send('alice', promptTarget(bob, 0, 1));
      expect(res.status).toBe(201);
      const stored = (await likes.findOne({ _id: res.body.data.like.id }))!;
      // Only published text is ever captured, never the submission awaiting review
      expect(stored.contextSnapshot).toMatchObject({ answerText: 'bob answer 0' });
    });
  });

  describe('recipient and sender eligibility', () => {
    it('rejects paused, inactive, unready, missing and blocked recipients identically', async () => {
      await seedUser('alice');
      const paused = await seedUser('paused', { discoverPaused: true });
      const suspended = await seedUser('suspended', { accountStatus: 'suspended' });
      const onboarding = await seedUser('onboarding', { accountStatus: 'onboarding', profileReady: false });
      const unready = await seedUser('unready', { profileReady: false });
      const deleted = await seedUser('deleted', { accountStatus: 'deleted' });
      const blocked = await seedUser('blocked');
      guard = {
        check: async ({ toUserId }) => (toUserId === blocked.userId ? { ok: false, reason: 'blocked' } : { ok: true }),
        touch: async () => {},
      };

      const bodies = [paused, suspended, onboarding, unready, deleted, blocked].map(u => photoTarget(u));
      bodies.push({ toUserId: 'user-nobody', target: { kind: 'photo', id: 'nobody-photo', contentVersion: 1 } });
      const errors = [];
      for (const body of bodies) {
        const res = await send('alice', body);
        expect(res.status, `${body.toUserId}`).toBe(404);
        expectContract(res, '/v1/likes', 'post');
        errors.push(res.body.error);
      }
      // No response distinguishes a block from any other unavailable profile
      expect(new Set(errors.map(e => JSON.stringify(e))).size).toBe(1);
      expect(errors[0]).toMatchObject({ code: 'PROFILE_UNAVAILABLE' });
      expect(await likes.countDocuments()).toBe(0);
      expect(await usedLikes('user-alice')).toBe(0);
    });

    it('requires the sender to be active, ready and not paused', async () => {
      await seedUser('paused', { discoverPaused: true });
      await seedUser('unready', { profileReady: false });
      await seedUser('suspended', { accountStatus: 'suspended' });
      const bob = await seedUser('bob');

      let res = await send('paused', photoTarget(bob));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ACCOUNT_PAUSED');
      expectContract(res, '/v1/likes', 'post');

      res = await send('unready', photoTarget(bob));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ACCOUNT_NOT_ELIGIBLE');

      res = await send('suspended', photoTarget(bob));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ACCOUNT_RESTRICTED');

      res = await send('stranger', photoTarget(bob));
      expect(res.status).toBe(404);
      expect(await likes.countDocuments()).toBe(0);
    });

    it('asks the sender to answer a pending incoming like instead of sending one back', async () => {
      const alice = await seedUser('alice');
      const bob = await seedUser('bob');
      expect((await send('bob', photoTarget(alice))).status).toBe(201);

      const res = await send('alice', photoTarget(bob));
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INCOMING_LIKE_PENDING');
      expectContract(res, '/v1/likes', 'post');
      expect(await usedLikes(alice.userId)).toBe(0);
    });
  });

  describe('idempotency', () => {
    it('returns the original like for a duplicate request without charging again', async () => {
      await seedUser('alice');
      const bob = await seedUser('bob');
      const key = newKey();
      const body = { ...photoTarget(bob), comment: 'Selam!' };

      const first = await send('alice', body, key);
      expect(first.status).toBe(201);
      const retry = await send('alice', body, key);
      expect(retry.status).toBe(200);
      expectContract(retry, '/v1/likes', 'post');
      expect(retry.body.data.like).toEqual(first.body.data.like);
      expect(retry.body.data.quota).toMatchObject({ used: 1, remaining: 7 });
      expect(await likes.countDocuments()).toBe(1);
      expect(await usedLikes('user-alice')).toBe(1);
    });

    it('replays the original like even after the target changed or the allowance ran out', async () => {
      await seedUser('alice');
      const bob = await seedUser('bob');
      const key = newKey();
      const first = await send('alice', photoTarget(bob), key);
      await db.collection<PhotoDocument>('photos').updateOne({ _id: bob.photoIds[0] }, { $set: { state: 'deleted' } });
      await quotas.updateMany({}, { $set: { usedLikes: 8 } });

      const retry = await send('alice', photoTarget(bob), key);
      expect(retry.status).toBe(200);
      expect(retry.body.data.like.id).toBe(first.body.data.like.id);
    });

    it('collapses concurrent duplicates into one like and one charge', async () => {
      await seedUser('alice');
      const bob = await seedUser('bob');
      const key = newKey();
      guard = barrierGuard(6);

      const results = await Promise.all(Array.from({ length: 6 }, () => send('alice', photoTarget(bob), key)));
      expect(results.map(r => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
      expect(new Set(results.map(r => r.body.data.like.id)).size).toBe(1);
      expect(await likes.countDocuments()).toBe(1);
      expect(await usedLikes('user-alice')).toBe(1);
    });

    it('rejects the same key with a different payload', async () => {
      await seedUser('alice');
      const bob = await seedUser('bob');
      const carol = await seedUser('carol');
      const key = newKey();
      expect((await send('alice', { ...photoTarget(bob), comment: 'one' }, key)).status).toBe(201);

      for (const body of [
        { ...photoTarget(bob), comment: 'two' },
        photoTarget(bob),
        { ...photoTarget(bob, 1), comment: 'one' },
        { ...photoTarget(carol), comment: 'one' },
      ]) {
        const res = await send('alice', body, key);
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
        expectContract(res, '/v1/likes', 'post');
      }
      expect(await likes.countDocuments()).toBe(1);
      expect(await usedLikes('user-alice')).toBe(1);
    });

    it('treats the same normalized comment as the same payload', async () => {
      await seedUser('alice');
      const bob = await seedUser('bob');
      const key = newKey();
      expect((await send('alice', { ...photoTarget(bob), comment: 'Selam  ሰላም' }, key)).status).toBe(201);
      expect((await send('alice', { ...photoTarget(bob), comment: ' Selam ሰላም ' }, key)).status).toBe(200);
    });

    it('scopes keys to the authenticated sender', async () => {
      const alice = await seedUser('alice');
      const bob = await seedUser('bob');
      await seedUser('carol');
      const key = newKey();
      expect((await send('alice', photoTarget(bob), key)).status).toBe(201);
      expect((await send('carol', photoTarget(alice), key)).status).toBe(201);
    });

    it('allows one like per direction: a new key cannot like the same person again', async () => {
      await seedUser('alice');
      const bob = await seedUser('bob');
      const first = await send('alice', photoTarget(bob));
      let res = await send('alice', promptTarget(bob));
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ALREADY_LIKED');
      expectContract(res, '/v1/likes', 'post');

      // After a decline the sender sees the same answer: the decline is never revealed
      expect((await decline('bob', first.body.data.like.id)).status).toBe(200);
      res = await send('alice', photoTarget(bob, 2));
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ALREADY_LIKED');
      expect(await usedLikes('user-alice')).toBe(1);
    });
  });

  describe('comment limit (200 grapheme clusters)', () => {
    const family = '👨‍👩‍👧‍👦'; // one grapheme, 11 UTF-16 code units
    const combining = 'é̂'; // one grapheme: e + two combining marks
    const ethiopic = 'ሰ';

    it.each([
      ['emoji ZWJ sequences', family],
      ['combining marks', combining],
      ['Ethiopic syllables', ethiopic],
      ['flags', '🇪🇹'],
    ])('accepts exactly 200 and rejects 201 %s', async (_label, grapheme) => {
      await seedUser('alice');
      const bob = await seedUser('bob');
      const carol = await seedUser('carol');

      const over = await send('alice', { ...photoTarget(bob), comment: grapheme.repeat(201) });
      expect(over.status).toBe(422);
      expect(over.body.error.fieldErrors).toEqual([{ field: 'comment', message: expect.stringContaining('200') }]);
      expect(await usedLikes('user-alice')).toBe(0);

      const exact = await send('alice', { ...photoTarget(carol), comment: grapheme.repeat(200) });
      expect(exact.status).toBe(201);
      expect(exact.body.data.like.comment).toBe(grapheme.repeat(200).normalize('NFC'));
    });

    it('stores a blank comment as no comment', async () => {
      await seedUser('alice');
      const bob = await seedUser('bob');
      const res = await send('alice', { ...photoTarget(bob), comment: ' \n\t ' });
      expect(res.status).toBe(201);
      expect(res.body.data.like.comment).toBeNull();
    });
  });

  describe('daily allowance', () => {
    async function seedRecipients(count: number): Promise<Seeded[]> {
      const out: Seeded[] = [];
      for (let i = 0; i < count; i++) out.push(await seedUser(`r${i}`));
      return out;
    }

    it('allows the configured likes per UTC day, then 429 with the reset time', async () => {
      await seedUser('alice');
      const recipients = await seedRecipients(9);
      for (const r of recipients.slice(0, 8)) expect((await send('alice', photoTarget(r))).status).toBe(201);

      const res = await send('alice', photoTarget(recipients[8]!));
      expect(res.status).toBe(429);
      expectContract(res, '/v1/likes', 'post');
      expect(res.body.error).toMatchObject({ code: 'QUOTA_EXHAUSTED', limit: 8, resetAt: '2026-10-26T00:00:00.000Z' });
      expect(res.headers['retry-after']).toBe(String(9 * 3600));
      expect(await likes.countDocuments()).toBe(8);
      expect(await usedLikes('user-alice')).toBe(8);
    });

    it('resets at UTC midnight on the server clock', async () => {
      await seedUser('alice');
      const recipients = await seedRecipients(10);
      clock = new Date('2026-10-25T23:59:59.999Z');
      for (const r of recipients.slice(0, 8)) expect((await send('alice', photoTarget(r))).status).toBe(201);
      expect((await send('alice', photoTarget(recipients[8]!))).status).toBe(429);

      clock = new Date('2026-10-26T00:00:00.000Z');
      const res = await send('alice', photoTarget(recipients[8]!));
      expect(res.status).toBe(201);
      expect(res.body.data.quota).toEqual({ limit: 8, used: 1, remaining: 7, resetAt: '2026-10-27T00:00:00.000Z' });
    });

    it('charges nothing for rejected likes, so the last like of the day still works', async () => {
      const alice = await seedUser('alice');
      const recipients = await seedRecipients(8);
      for (const r of recipients.slice(0, 7)) expect((await send('alice', photoTarget(r))).status).toBe(201);

      const last = recipients[7]!;
      expect((await send('alice', photoTarget(last, 0, 9))).status).toBe(409); // stale
      expect((await send('alice', photoTarget(alice))).status).toBe(422); // self
      expect((await send('alice', photoTarget(recipients[0]!, 1))).status).toBe(409); // already liked
      expect((await send('alice', { ...photoTarget(last), comment: 'x'.repeat(201) })).status).toBe(422);
      expect(await usedLikes(alice.userId)).toBe(7);

      expect((await send('alice', photoTarget(last))).status).toBe(201);
      expect(await usedLikes(alice.userId)).toBe(8);
    });

    it('rolls the charge back when the like transaction fails after charging', async () => {
      await seedUser('alice');
      const bob = await seedUser('bob');
      guard = { check: async () => ({ ok: true }), touch: async () => { throw new Error('pair write failed'); } };
      const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await send('alice', photoTarget(bob));
      quiet.mockRestore();
      expect(res.status).toBe(500);
      expect(await likes.countDocuments()).toBe(0);
      expect(await usedLikes('user-alice')).toBe(0);

      guard = noopPairGuard;
      expect((await send('alice', photoTarget(bob))).status).toBe(201);
      expect(await usedLikes('user-alice')).toBe(1);
    });

    it('never overspends under parallel sends to different recipients', async () => {
      await seedUser('alice');
      const recipients = await seedRecipients(20);
      guard = barrierGuard(20);

      const results = await Promise.all(recipients.map(r => send('alice', photoTarget(r))));
      expect(results.filter(r => r.status === 201)).toHaveLength(8);
      expect(results.filter(r => r.status === 429)).toHaveLength(12);
      expect(results.flatMap(r => (r.status === 201 ? [r.body.data.quota.used] : [])).sort((a, b) => a - b))
        .toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(await likes.countDocuments({ fromUserId: 'user-alice' })).toBe(8);
      expect(await usedLikes('user-alice')).toBe(8);
      expect(await quotas.countDocuments({ userId: 'user-alice' })).toBe(1);
    });

    it('honors a configured allowance', async () => {
      app = buildLikesApp(2);
      try {
        await seedUser('alice');
        const recipients = await seedRecipients(3);
        expect((await send('alice', photoTarget(recipients[0]!))).status).toBe(201);
        expect((await send('alice', photoTarget(recipients[1]!))).status).toBe(201);
        const res = await send('alice', photoTarget(recipients[2]!));
        expect(res.status).toBe(429);
        expect(res.body.error.limit).toBe(2);
      } finally {
        app = buildLikesApp(8);
      }
    });
  });
});

describe('GET /v1/likes/quota', () => {
  it('reports the composer allowance and the next UTC reset', async () => {
    await seedUser('alice');
    const bob = await seedUser('bob');
    let res = await request(app).get('/v1/likes/quota').set('Authorization', as('alice'));
    expect(res.status).toBe(200);
    expectContract(res, '/v1/likes/quota', 'get');
    expect(res.body.data).toEqual({ limit: 8, used: 0, remaining: 8, resetAt: '2026-10-26T00:00:00.000Z' });

    await send('alice', photoTarget(bob));
    res = await request(app).get('/v1/likes/quota').set('Authorization', as('alice'));
    expect(res.body.data).toMatchObject({ used: 1, remaining: 7 });

    res = await request(app).get('/v1/likes/quota');
    expect(res.status).toBe(401);
    expectContract(res, '/v1/likes/quota', 'get');
  });
});

describe('GET /v1/likes/incoming', () => {
  it('lists pending likes newest first with a public sender summary and context', async () => {
    await seedUser('alice');
    await seedUser('carol');
    const bob = await seedUser('bob');

    await send('alice', { ...photoTarget(bob, 1), comment: 'Great smile' });
    clock = new Date(NOW.getTime() + 1000);
    await send('carol', promptTarget(bob, 0));

    const res = await incoming('bob');
    expect(res.status).toBe(200);
    expectContract(res, '/v1/likes/incoming', 'get');
    expect(res.body.meta.nextCursor).toBeNull();
    const [fromCarol, fromAlice] = res.body.data.likes;
    expect(fromCarol).toEqual({
      id: expect.any(String),
      sender: {
        userId: 'user-carol',
        displayName: 'Carol',
        age: 31,
        cityName: 'Dallas',
        stateCode: 'TX',
        photo: {
          id: 'carol-photo-0', order: 0, width: 1080, height: 1350, contentVersion: 1,
          media: { thumb: '/v1/media/carol-photo-0/thumb', display: '/v1/media/carol-photo-0/display' },
        },
      },
      target: { kind: 'prompt', id: bob.answerIds[0], contentVersion: 1 },
      context: { kind: 'prompt', promptId: 'prompt-tradition', promptText: 'A tradition I would love to share with you…', answerText: 'bob answer 0' },
      targetChanged: false,
      comment: null,
      createdAt: new Date(NOW.getTime() + 1000).toISOString(),
      canAccept: false,
    });
    expect(fromAlice).toMatchObject({
      sender: { userId: 'user-alice' },
      target: { kind: 'photo', id: bob.photoIds[1], contentVersion: 1 },
      context: { kind: 'photo', media: { thumb: `/v1/media/${bob.photoIds[1]}/thumb`, display: `/v1/media/${bob.photoIds[1]}/display` } },
      targetChanged: false,
      comment: 'Great smile',
    });

    // Public allowlist only: no DOB, email, Firebase UID, keys or moderation data
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/birthDate|1995-03-10|email|uid-|firebase|quarantine|public-variants|moderation|idempotency|test-key|fromUserId|"state"/i);
  });

  it('only shows the caller their own pending likes', async () => {
    const alice = await seedUser('alice');
    const bob = await seedUser('bob');
    await seedUser('carol');
    const toBob = await send('alice', photoTarget(bob));
    await send('carol', photoTarget(alice));

    let res = await incoming('bob');
    expect(res.body.data.likes.map((l: { id: string }) => l.id)).toEqual([toBob.body.data.like.id]);
    res = await incoming('carol');
    expect(res.body.data.likes).toEqual([]);

    await decline('bob', toBob.body.data.like.id);
    res = await incoming('bob');
    expect(res.body.data.likes).toEqual([]);
  });

  it('hides paused, inactive, unready and blocked senders until they are available again', async () => {
    const bob = await seedUser('bob');
    const senders = ['paused', 'suspended', 'unready', 'blocked', 'visible'];
    for (const name of senders) {
      await seedUser(name);
      expect((await send(name, photoTarget(bob))).status).toBe(201);
    }
    const users = db.collection<UserDocument>('users');
    await users.updateOne({ _id: 'user-paused' }, { $set: { discoverPaused: true } });
    await users.updateOne({ _id: 'user-suspended' }, { $set: { accountStatus: 'suspended' } });
    await users.updateOne({ _id: 'user-unready' }, { $set: { profileReady: false } });
    guard = {
      check: async ({ fromUserId }) => (fromUserId === 'user-blocked' ? { ok: false, reason: 'blocked' } : { ok: true }),
      touch: async () => {},
    };

    let res = await incoming('bob');
    expect(res.body.data.likes.map((l: { sender: { userId: string } }) => l.sender.userId)).toEqual(['user-visible']);

    // Resuming restores the stored like
    await users.updateOne({ _id: 'user-paused' }, { $set: { discoverPaused: false } });
    res = await incoming('bob');
    expect(res.body.data.likes.map((l: { sender: { userId: string } }) => l.sender.userId).sort())
      .toEqual(['user-paused', 'user-visible']);
  });

  it('requires an active, ready recipient', async () => {
    await seedUser('unready', { profileReady: false });
    const res = await incoming('unready');
    expect(res.status).toBe(403);
    expectContract(res, '/v1/likes/incoming', 'get');
    expect((await request(app).get('/v1/likes/incoming')).status).toBe(401);
  });

  it('shows safe context and a neutral changed flag after content is removed or edited', async () => {
    const bob = await seedUser('bob');
    for (const name of ['alice', 'carol', 'dawit']) await seedUser(name);
    await send('alice', photoTarget(bob, 0));
    await send('carol', promptTarget(bob, 1));
    await send('dawit', promptTarget(bob, 2));

    // Photo removed and purged; one answer deleted; another edited and republished
    await db.collection<PhotoDocument>('photos').updateOne(
      { _id: bob.photoIds[0] },
      { $set: { state: 'deleted', deletedAt: NOW, objectsPurgedAt: NOW } },
    );
    await db.collection<PromptAnswerDocument>('promptAnswers').deleteOne({ _id: bob.answerIds[1] });
    await db.collection<PromptAnswerDocument>('promptAnswers').updateOne(
      { _id: bob.answerIds[2] },
      { $set: { approvedText: 'bob answer 2, rewritten', publishedRevision: 2 } },
    );

    const res = await incoming('bob');
    expect(res.status).toBe(200);
    expectContract(res, '/v1/likes/incoming', 'get');
    const bySender = Object.fromEntries(
      res.body.data.likes.map((l: { sender: { userId: string } }) => [l.sender.userId, l]),
    );
    expect(bySender['user-alice']).toMatchObject({ targetChanged: true, context: { kind: 'photo', media: null } });
    expect(bySender['user-carol']).toMatchObject({
      targetChanged: true,
      context: { kind: 'prompt', promptId: 'prompt-home', answerText: null },
    });
    // Edited but still published: the recipient sees the words that were liked, flagged as changed
    expect(bySender['user-dawit']).toMatchObject({
      targetChanged: true,
      context: { kind: 'prompt', answerText: 'bob answer 2' },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/quarantine|public-variants|bob answer 1/);
  });

  describe('pagination', () => {
    it('pages with an opaque cursor without skips or repeats, including equal timestamps', async () => {
      const bob = await seedUser('bob');
      const ids: string[] = [];
      for (let i = 0; i < 23; i++) {
        await seedUser(`s${i}`);
        // Pairs of likes share a timestamp, so the id tie-break matters
        clock = new Date(NOW.getTime() + Math.floor(i / 2) * 1000);
        const res = await send(`s${i}`, photoTarget(bob));
        ids.push(res.body.data.like.id);
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: string = `?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const res = await incoming('bob', query);
        expect(res.status).toBe(200);
        expectContract(res, '/v1/likes/incoming', 'get');
        seen.push(...res.body.data.likes.map((l: { id: string }) => l.id));
        cursor = res.body.meta.nextCursor;
        pages++;
      } while (cursor && pages < 10);

      expect(pages).toBe(3);
      expect(seen).toHaveLength(23);
      expect(new Set(seen).size).toBe(23);
      expect(new Set(seen)).toEqual(new Set(ids));
      // Newest first
      const created = await likes.find({ _id: { $in: seen } }).toArray();
      const times = seen.map(id => created.find(l => l._id === id)!.createdAt.getTime());
      expect([...times].sort((a, b) => b - a)).toEqual(times);
    });

    it('skips hidden senders without losing or repeating visible likes across pages', async () => {
      const bob = await seedUser('bob');
      const visible: string[] = [];
      for (let i = 0; i < 30; i++) {
        await seedUser(`s${i}`);
        clock = new Date(NOW.getTime() + i * 1000);
        const res = await send(`s${i}`, photoTarget(bob));
        if (i % 3 === 0) {
          await db.collection<UserDocument>('users').updateOne({ _id: `user-s${i}` }, { $set: { discoverPaused: true } });
        } else {
          visible.push(res.body.data.like.id);
        }
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const query: string = `?limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const res = await incoming('bob', query);
        seen.push(...res.body.data.likes.map((l: { id: string }) => l.id));
        cursor = res.body.meta.nextCursor;
        if (!cursor) break;
      }
      expect(cursor).toBeNull();
      expect(seen).toEqual([...visible].reverse());
    });

    it('rejects a malformed cursor or limit', async () => {
      await seedUser('bob');
      for (const query of ['?cursor=not-a-cursor', `?cursor=${Buffer.from('{"t":"x"}').toString('base64url')}`]) {
        const res = await incoming('bob', query);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('INVALID_CURSOR');
        expectContract(res, '/v1/likes/incoming', 'get');
      }
      for (const query of ['?limit=0', '?limit=51', '?limit=abc']) {
        const res = await incoming('bob', query);
        expect(res.status).toBe(422);
        expectContract(res, '/v1/likes/incoming', 'get');
      }
    });
  });
});

describe('POST /v1/likes/:id/decline', () => {
  it('declines idempotently, charges nothing and removes the like from the list', async () => {
    const alice = await seedUser('alice');
    const bob = await seedUser('bob');
    const sent = await send('alice', photoTarget(bob));
    const likeId = sent.body.data.like.id as string;

    clock = new Date(NOW.getTime() + 60_000);
    const first = await decline('bob', likeId);
    expect(first.status).toBe(200);
    expectContract(first, '/v1/likes/{id}/decline', 'post');
    expect(first.body.data).toEqual({ id: likeId, state: 'declined', decidedAt: clock.toISOString() });

    clock = new Date(NOW.getTime() + 120_000);
    const again = await decline('bob', likeId);
    expect(again.status).toBe(200);
    expect(again.body.data).toEqual(first.body.data);

    const stored = (await likes.findOne({ _id: likeId }))!;
    expect(stored).toMatchObject({ state: 'declined', decidedAt: new Date(NOW.getTime() + 60_000) });
    expect(await usedLikes(bob.userId)).toBe(0);
    expect(await usedLikes(alice.userId)).toBe(1);
    expect((await incoming('bob')).body.data.likes).toEqual([]);
  });

  it('settles concurrent declines on one decision', async () => {
    await seedUser('alice');
    const bob = await seedUser('bob');
    const likeId = (await send('alice', photoTarget(bob))).body.data.like.id as string;
    const results = await Promise.all(Array.from({ length: 5 }, () => decline('bob', likeId)));
    expect(results.every(r => r.status === 200)).toBe(true);
    expect(new Set(results.map(r => r.body.data.decidedAt)).size).toBe(1);
  });

  it('lets only the recipient decline', async () => {
    await seedUser('alice');
    await seedUser('carol');
    const bob = await seedUser('bob');
    const likeId = (await send('alice', photoTarget(bob))).body.data.like.id as string;

    for (const name of ['alice', 'carol']) {
      const res = await decline(name, likeId);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('LIKE_NOT_FOUND');
      expectContract(res, '/v1/likes/{id}/decline', 'post');
    }
    expect((await decline('bob', 'no-such-like')).status).toBe(404);
    expect((await request(app).post(`/v1/likes/${likeId}/decline`)).status).toBe(401);
    expect((await likes.findOne({ _id: likeId }))!.state).toBe('pending');
  });

  it('still works when the sender is paused or the recipient is unready', async () => {
    await seedUser('alice');
    const bob = await seedUser('bob');
    const likeId = (await send('alice', photoTarget(bob))).body.data.like.id as string;
    await db.collection<UserDocument>('users').updateOne({ _id: 'user-alice' }, { $set: { discoverPaused: true } });
    await db.collection<UserDocument>('users').updateOne({ _id: bob.userId }, { $set: { profileReady: false } });
    expect((await decline('bob', likeId)).status).toBe(200);
  });
});

describe('POST /v1/likes/:id/accept', () => {
  it('is not available until matching ships, and creates nothing', async () => {
    await seedUser('alice');
    const bob = await seedUser('bob');
    const likeId = (await send('alice', photoTarget(bob))).body.data.like.id as string;

    const res = await request(app).post(`/v1/likes/${likeId}/accept`).set('Authorization', as('bob'));
    expect(res.status).toBe(501);
    expect(res.body.error).toMatchObject({ code: 'ACCEPT_NOT_AVAILABLE', retryable: false });
    expectContract(res, '/v1/likes/{id}/accept', 'post');
    expect((await likes.findOne({ _id: likeId }))!.state).toBe('pending');
    expect(await db.collection('matches').countDocuments()).toBe(0);

    const other = await request(app).post(`/v1/likes/${likeId}/accept`).set('Authorization', as('alice'));
    expect(other.status).toBe(404);
    expectContract(other, '/v1/likes/{id}/accept', 'post');
  });
});
