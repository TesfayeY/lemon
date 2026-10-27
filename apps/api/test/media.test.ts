import { describe, it, expect, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import request from 'supertest';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import type { Auth } from 'firebase-admin/auth';
import type { Db } from 'mongodb';
import { createApp } from '../src/app.js';
import { createAuthRoutes } from '../src/modules/auth/routes.js';
import { createProfileRoutes } from '../src/modules/profiles/routes.js';
import { createMediaRoutes } from '../src/modules/media/routes.js';
import { reviewPhoto, ReviewError } from '../src/modules/media/review-service.js';
import { toPublicPhotoDTO } from '../src/modules/media/dto.js';
import { InMemoryMediaStorage } from '../src/adapters/media/in-memory.js';
import { runMediaCleanup } from '../src/workers/media-cleanup.js';
import { createEmptyProfile } from '../src/modules/profiles/schema.js';
import { createDefaultPreferences } from '../src/modules/preferences/schema.js';
import type { UserDocument } from '../src/modules/auth/account.js';
import type { PhotoDocument } from '../src/modules/media/schema.js';
import { processImage } from '../src/modules/media/processing.js';
import * as images from './fixtures/images/factory.js';

// Real implementation by default; individual tests can hold calls at a barrier
vi.mock('../src/modules/media/processing.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/modules/media/processing.js')>();
  return { ...actual, processImage: vi.fn(actual.processImage) };
});

// --- In-memory Db fake (subset of MongoDB semantics used by the media module) ---

type Doc = Record<string, unknown>;

// Mirrors src/indexes.ts so duplicate-key paths behave like MongoDB
const UNIQUE_KEYS: Record<string, { keys: string[]; partial?: (doc: Doc) => boolean }[]> = {
  users: [{ keys: ['firebaseUid'] }],
  profiles: [{ keys: ['userId'] }],
  preferences: [{ keys: ['userId'] }],
  promptAnswers: [
    { keys: ['ownerId', 'promptId'] },
    { keys: ['ownerId', 'slot'], partial: (doc) => doc['slot'] !== undefined },
  ],
  photos: [{ keys: ['ownerId', 'idempotencyKey'], partial: (doc) => typeof doc['idempotencyKey'] === 'string' }],
};

function matchesValue(actual: unknown, condition: unknown): boolean {
  if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
    return Object.entries(condition as Doc).every(([op, operand]) => {
      switch (op) {
        case '$in': return (operand as unknown[]).includes(actual);
        case '$lt': return actual instanceof Date && actual < (operand as Date);
        // Like MongoDB, { $ne: null } also excludes a missing field
        case '$ne': return operand === null ? actual !== null && actual !== undefined : actual !== operand;
        default: throw new Error(`Unsupported operator in fake Db: ${op}`);
      }
    });
  }
  // MongoDB equality on null also matches a missing field
  if (condition === null) return actual === null || actual === undefined;
  return actual === condition;
}

function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([k, v]) => matchesValue(doc[k], v));
}

/**
 * With `interleave`, every operation first yields to the event loop, so concurrent
 * requests interleave between reads and writes as they would against a real server.
 * Without it each handler's fake calls resolve as microtasks and run back to back.
 */
function createInMemoryDb(options: { interleave?: boolean } = {}) {
  const collections = new Map<string, Map<string, Doc>>();
  const getCol = (name: string) => {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name)!;
  };
  const tick = () => (options.interleave ? new Promise<void>((resolve) => setImmediate(resolve)) : Promise.resolve());

  return {
    collection: (name: string) => {
      const store = getCol(name);
      const findAll = (filter: Doc) => [...store.values()].filter((doc) => matches(doc, filter));
      return {
        // Return copies, like the driver: later writes must not change documents already read
        findOne: vi.fn(async (filter: Doc) => {
          await tick();
          const doc = findAll(filter)[0];
          return doc ? { ...doc } : null;
        }),
        find: vi.fn((filter: Doc) => {
          let limit = Infinity;
          const cursor = {
            limit: (n: number) => { limit = n; return cursor; },
            toArray: async () => {
              await tick();
              return findAll(filter).slice(0, limit).map((doc) => ({ ...doc }));
            },
          };
          return cursor;
        }),
        insertOne: vi.fn(async (doc: Doc) => {
          await tick();
          for (const { keys, partial } of [{ keys: ['_id'] }, ...(UNIQUE_KEYS[name] ?? [])]) {
            if (partial && !partial(doc)) continue;
            for (const existing of store.values()) {
              if (partial && !partial(existing)) continue;
              if (keys.every((k) => existing[k] === doc[k])) {
                throw Object.assign(new Error('duplicate key'), { code: 11000 });
              }
            }
          }
          store.set(doc['_id'] as string, { ...doc });
          return { insertedId: doc['_id'] };
        }),
        updateOne: vi.fn(async (filter: Doc, update: Doc) => {
          await tick();
          const doc = findAll(filter)[0];
          if (!doc) return { matchedCount: 0, modifiedCount: 0 };
          const { $set = {}, $inc = {}, $unset = {} } = update as {
            $set?: Doc; $inc?: Record<string, number>; $unset?: Doc;
          };
          Object.assign(doc, $set);
          for (const [k, by] of Object.entries($inc)) doc[k] = ((doc[k] as number) ?? 0) + by;
          for (const k of Object.keys($unset)) delete doc[k];
          return { matchedCount: 1, modifiedCount: 1 };
        }),
        deleteOne: vi.fn(async (filter: Doc) => {
          await tick();
          const doc = findAll(filter)[0];
          if (!doc) return { deletedCount: 0 };
          store.delete(doc['_id'] as string);
          return { deletedCount: 1 };
        }),
        countDocuments: vi.fn(async (filter: Doc) => {
          await tick();
          return findAll(filter).length;
        }),
      };
    },
  } as unknown as Db;
}

// --- App and user helpers ---

/** Token "token-<name>" authenticates as Firebase UID "uid-<name>" */
function createMultiUserAuth(): Auth {
  return {
    verifyIdToken: vi.fn(async (token: string) => ({
      uid: `uid-${token.replace('token-', '')}`,
      email_verified: true,
    })),
  } as unknown as Auth;
}

interface Harness {
  app: ReturnType<typeof createApp>;
  db: Db;
  storage: InMemoryMediaStorage;
}

function setup(options: { maxBytes?: number; interleave?: boolean } = {}): Harness {
  const db = createInMemoryDb({ interleave: options.interleave ?? false });
  const auth = createMultiUserAuth();
  const storage = new InMemoryMediaStorage();
  const app = createApp({
    mongoCheck: async () => true,
    firebaseCheck: async () => true,
    routes: [
      createAuthRoutes(db, auth),
      createProfileRoutes(db, auth),
      createMediaRoutes(db, auth, { MEDIA_MAX_BYTES: options.maxBytes ?? 10 * 1024 * 1024, MEDIA_LOCAL_DIR: 'unused' }, storage),
    ],
  });
  return { app, db, storage };
}

const userId = (name: string) => `user-${name}`;

/** A user whose profile is complete except for approved photos. */
async function seedCompleteProfile(db: Db, name: string): Promise<void> {
  const now = new Date();
  const user: UserDocument = {
    _id: userId(name),
    firebaseUid: `uid-${name}`,
    accountStatus: 'onboarding',
    emailVerified: true,
    birthDate: '1994-05-12',
    adultEligible: true,
    discoverPaused: false,
    profileReady: false,
    guardVersion: 1,
    agreements: { termsVersion: '1.0', acceptedAt: now },
    createdAt: now,
    updatedAt: now,
  };
  await db.collection('users').insertOne(user as unknown as Doc);
  await db.collection('profiles').insertOne({
    ...createEmptyProfile(userId(name)),
    displayName: name,
    genderIdentity: 'woman',
    cityId: 'city-seattle-wa',
    stateCode: 'WA',
    intention: 'long-term',
  } as unknown as Doc);
  await db.collection('preferences').insertOne({
    ...createDefaultPreferences(userId(name)),
    acceptedGenderCategories: ['man'],
  } as unknown as Doc);
  for (const [slot, promptId] of ['prompt-1', 'prompt-2', 'prompt-3'].entries()) {
    await db.collection('promptAnswers').insertOne({
      _id: uuidv4(), ownerId: userId(name), promptId, slot, approvedText: 'Buna with friends', pendingText: null,
      state: 'approved', revision: 1, publishedRevision: 1, createdAt: now, updatedAt: now,
    } as unknown as Doc);
  }
}

async function getUser(db: Db, name: string): Promise<UserDocument> {
  return (await db.collection('users').findOne({ _id: userId(name) } as Doc)) as unknown as UserDocument;
}

async function getPhoto(db: Db, id: string): Promise<PhotoDocument | null> {
  return (await db.collection('photos').findOne({ _id: id } as Doc)) as unknown as PhotoDocument | null;
}

let imageSeed = 0;
/** A distinct valid JPEG each call, so request hashes differ. */
function uniqueJpeg(): Promise<Buffer> {
  imageSeed++;
  const shade = (imageSeed * 37) % 200;
  return images.jpeg(400, 500, `rgb(${shade}, 80, 120)`);
}

function upload(h: Harness, name: string, image: Buffer, key: string = uuidv4(), filename = 'photo.jpg', contentType = 'image/jpeg') {
  return request(h.app)
    .post('/v1/me/photos')
    .set('Authorization', `Bearer token-${name}`)
    .set('Idempotency-Key', key)
    .attach('photo', image, { filename, contentType });
}

async function uploadOk(h: Harness, name: string): Promise<string> {
  const res = await upload(h, name, await uniqueJpeg());
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

function listPhotos(h: Harness, name: string) {
  return request(h.app).get('/v1/me/photos').set('Authorization', `Bearer token-${name}`);
}

function fetchMedia(h: Harness, name: string, path: string) {
  return request(h.app)
    .get(path)
    .set('Authorization', `Bearer token-${name}`)
    .buffer(true)
    .parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    });
}

function errorCode(res: request.Response): string {
  const body = Buffer.isBuffer(res.body) ? JSON.parse(res.body.toString('utf8')) : res.body;
  return body.error.code;
}

/** Complete profile + 3 approved photos → active and ready. Returns the photo IDs. */
async function makeReady(h: Harness, name: string): Promise<string[]> {
  await seedCompleteProfile(h.db, name);
  const ids = [await uploadOk(h, name), await uploadOk(h, name), await uploadOk(h, name)];
  for (const id of ids) await reviewPhoto(h.db, id, 'approve', null, 'reviewer-1');
  const user = await getUser(h.db, name);
  expect(user.profileReady).toBe(true);
  return ids;
}

// --- Tests ---

describe('POST /v1/me/photos', () => {
  it('stores an uploaded photo in quarantine as pending, never auto-approved', async () => {
    const h = setup();
    await seedCompleteProfile(h.db, 'alice');

    const res = await upload(h, 'alice', await images.jpeg());
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ id: expect.any(String), state: 'pending', order: 0, revision: 2 });

    const id = res.body.data.id as string;
    expect(h.storage.keys()).toEqual([
      `public-variants/${id}/display`,
      `public-variants/${id}/thumb`,
      `quarantine/${userId('alice')}/${id}`,
    ]);
    expect(h.storage.get(`quarantine/${userId('alice')}/${id}`)!.contentType).toBe('image/jpeg');
    expect(h.storage.get(`public-variants/${id}/thumb`)!.contentType).toBe('image/webp');
    expect(h.storage.get(`public-variants/${id}/display`)!.contentType).toBe('image/webp');
    expect(await h.db.collection('auditLog').countDocuments({})).toBe(0);
    expect((await getPhoto(h.db, id))!.state).toBe('pending');
  });

  it('requires authentication', async () => {
    const h = setup();
    const res = await request(h.app).post('/v1/me/photos').attach('photo', await images.jpeg(), 'p.jpg');
    expect(res.status).toBe(401);
  });

  it('requires a well-formed Idempotency-Key', async () => {
    const h = setup();
    await seedCompleteProfile(h.db, 'alice');
    for (const key of [null, 'short', 'has spaces in it', 'x'.repeat(129)]) {
      const req = request(h.app).post('/v1/me/photos').set('Authorization', 'Bearer token-alice');
      if (key) req.set('Idempotency-Key', key);
      const res = await req.attach('photo', await images.jpeg(), 'p.jpg');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    }
  });

  it('rejects requests without a photo part or with extra parts', async () => {
    const h = setup();
    await seedCompleteProfile(h.db, 'alice');

    const json = await request(h.app).post('/v1/me/photos').set('Authorization', 'Bearer token-alice')
      .set('Idempotency-Key', uuidv4()).send({ photo: 'base64...' });
    expect(json.status).toBe(400);
    expect(json.body.error.code).toBe('FILE_REQUIRED');

    const wrongField = await request(h.app).post('/v1/me/photos').set('Authorization', 'Bearer token-alice')
      .set('Idempotency-Key', uuidv4()).attach('image', await images.jpeg(), 'p.jpg');
    expect(wrongField.status).toBe(400);
    expect(wrongField.body.error.code).toBe('INVALID_MULTIPART');

    const twoFiles = await request(h.app).post('/v1/me/photos').set('Authorization', 'Bearer token-alice')
      .set('Idempotency-Key', uuidv4())
      .attach('photo', await images.jpeg(), 'a.jpg').attach('photo', await images.jpeg(), 'b.jpg');
    expect(twoFiles.status).toBe(400);
    expect(twoFiles.body.error.code).toBe('INVALID_MULTIPART');
    expect(h.storage.keys()).toEqual([]);
  });

  it('rejects oversized input with 413 before decoding', async () => {
    const h = setup({ maxBytes: 200_000 });
    await seedCompleteProfile(h.db, 'alice');

    const res = await upload(h, 'alice', Buffer.alloc(300_000, 0xff));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(res.body.error.maxBytes).toBe(200_000);
    expect(h.storage.keys()).toEqual([]);
  });

  it('ignores a fake MIME type and extension: a script named photo.jpg is rejected', async () => {
    const h = setup();
    await seedCompleteProfile(h.db, 'alice');

    const res = await upload(h, 'alice', images.disguisedScript(), uuidv4(), 'photo.jpg', 'image/jpeg');
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(h.storage.keys()).toEqual([]);
  });

  it('ignores a wrong client MIME type on a real photo', async () => {
    const h = setup();
    await seedCompleteProfile(h.db, 'alice');

    const res = await upload(h, 'alice', await images.png(), uuidv4(), 'photo.gif', 'image/gif');
    expect(res.status).toBe(201);
  });

  it('rejects HEIC with an informative 415', async () => {
    const h = setup();
    await seedCompleteProfile(h.db, 'alice');

    const res = await upload(h, 'alice', images.heicHeader(), uuidv4(), 'IMG_0001.HEIC', 'image/heic');
    expect(res.status).toBe(415);
    expect(res.body.error).toMatchObject({
      code: 'UNSUPPORTED_MEDIA_TYPE',
      detectedFormat: 'heic',
      acceptedFormats: ['jpeg', 'png', 'webp'],
      retryable: false,
    });
    expect(res.body.error.message).toMatch(/HEIC/);
  });

  it('rejects corrupt images and extreme dimensions', async () => {
    const h = setup();
    await seedCompleteProfile(h.db, 'alice');

    const corrupt = await upload(h, 'alice', await images.truncatedJpeg());
    expect(corrupt.status).toBe(422);
    expect(corrupt.body.error.code).toBe('INVALID_IMAGE');

    for (const input of [await images.jpeg(200, 200), images.pngHeader(9000, 500), images.pngHeader(50_000, 50_000)]) {
      const res = await upload(h, 'alice', input);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('IMAGE_DIMENSIONS_INVALID');
    }
    expect(h.storage.keys()).toEqual([]);
    expect(await h.db.collection('photos').countDocuments({})).toBe(0);
  });

  it('removes EXIF GPS and other metadata from everything it stores and serves', async () => {
    const h = setup();
    await seedCompleteProfile(h.db, 'alice');
    const fixture = await readFile(new URL('./fixtures/images/gps-exif.jpg', import.meta.url));

    const res = await upload(h, 'alice', fixture);
    expect(res.status).toBe(201);
    const id = res.body.data.id as string;

    for (const key of h.storage.keys()) {
      const stored = h.storage.get(key)!.body;
      const meta = await sharp(stored).metadata();
      expect(meta.exif).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
      expect(meta.iptc).toBeUndefined();
      expect(stored.includes(Buffer.from(images.FIXTURE_MAKE))).toBe(false);
    }

    const served = await fetchMedia(h, 'alice', `/v1/media/${id}/display`);
    expect(served.status).toBe(200);
    const meta = await sharp(served.body as Buffer).metadata();
    expect(meta.exif).toBeUndefined();
    expect([meta.width, meta.height]).toEqual([400, 600]); // orientation applied

    const photo = await getPhoto(h.db, id);
    expect([photo!.width, photo!.height]).toEqual([400, 600]);
  });

  it('returns the same photo for a duplicate retry with the same Idempotency-Key', async () => {
    const h = setup();
    await seedCompleteProfile(h.db, 'alice');
    const image = await images.jpeg();
    const key = uuidv4();

    const first = await upload(h, 'alice', image, key);
    const retry = await upload(h, 'alice', image, key);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.data.id).toBe(first.body.data.id);
    expect(retry.body.data.state).toBe('pending');
    expect(await h.db.collection('photos').countDocuments({})).toBe(1);
  });

  it('collapses concurrent duplicate retries into one photo', async () => {
    const h = setup({ interleave: true });
    await seedCompleteProfile(h.db, 'alice');
    const image = await images.jpeg();
    const key = uuidv4();

    const results = await Promise.all([upload(h, 'alice', image, key), upload(h, 'alice', image, key), upload(h, 'alice', image, key)]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    for (const r of results) expect([200, 201, 409]).toContain(r.status);
    expect(await h.db.collection('photos').countDocuments({ state: 'pending' })).toBe(1);
  });

  it('rejects the same Idempotency-Key with different bytes', async () => {
    const h = setup();
    await seedCompleteProfile(h.db, 'alice');
    const key = uuidv4();

    await upload(h, 'alice', await uniqueJpeg(), key);
    const res = await upload(h, 'alice', await uniqueJpeg(), key);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('deletes partial objects when a storage write fails, and the retry succeeds', async () => {
    const h = setup();
    await seedCompleteProfile(h.db, 'alice');
    const put = h.storage.putObject.bind(h.storage);
    let calls = 0;
    vi.spyOn(h.storage, 'putObject').mockImplementation(async (key, body, opts) => {
      calls++;
      if (calls === 2) throw new Error('disk full');
      return put(key, body, opts);
    });
    const image = await images.jpeg();
    const key = uuidv4();

    const failed = await upload(h, 'alice', image, key);
    expect(failed.status).toBe(503);
    expect(failed.body.error).toMatchObject({ code: 'STORAGE_UNAVAILABLE', retryable: true });
    expect(h.storage.keys()).toEqual([]);
    expect(await h.db.collection('photos').countDocuments({})).toBe(0);
    expect((await listPhotos(h, 'alice')).body.data.photos).toEqual([]);

    const retry = await upload(h, 'alice', image, key);
    expect(retry.status).toBe(201);
    expect(h.storage.keys()).toHaveLength(3);
  });

  it('allows at most 6 non-rejected photos', async () => {
    const h = setup();
    await seedCompleteProfile(h.db, 'alice');
    for (let i = 0; i < 6; i++) await uploadOk(h, 'alice');

    const res = await upload(h, 'alice', await uniqueJpeg());
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PHOTO_LIMIT_REACHED');
  });

  it('holds the 6-photo limit under concurrent uploads', async () => {
    const h = setup({ interleave: true });
    await seedCompleteProfile(h.db, 'alice');
    const inputs = await Promise.all(Array.from({ length: 8 }, () => uniqueJpeg()));

    // Release all eight uploads into slot reservation at the same moment
    const { processImage: realProcessImage } =
      await vi.importActual<typeof import('../src/modules/media/processing.js')>('../src/modules/media/processing.js');
    const waiting: (() => void)[] = [];
    vi.mocked(processImage).mockImplementation(async (input) => {
      const result = await realProcessImage(input);
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
        if (waiting.length === inputs.length) waiting.forEach((release) => release());
      });
      return result;
    });

    const results = await Promise.all(inputs.map((image) => upload(h, 'alice', image)));
    vi.mocked(processImage).mockImplementation(realProcessImage);
    expect(results.filter((r) => r.status === 201)).toHaveLength(6);
    expect(results.filter((r) => r.status === 422)).toHaveLength(2);
    expect(await h.db.collection('photos').countDocuments({ state: 'pending' })).toBe(6);
  });

  it('does not count rejected photos toward the limit', async () => {
    const h = setup();
    await seedCompleteProfile(h.db, 'alice');
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await uploadOk(h, 'alice'));
    await reviewPhoto(h.db, ids[0]!, 'reject', 'low_quality', 'reviewer-1');

    expect((await upload(h, 'alice', await uniqueJpeg())).status).toBe(201);
  });

  it('rejects uploads from restricted accounts', async () => {
    const h = setup();
    await seedCompleteProfile(h.db, 'alice');
    await h.db.collection('users').updateOne({ _id: userId('alice') } as Doc, { $set: { accountStatus: 'suspended' } });

    const res = await upload(h, 'alice', await images.jpeg());
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_RESTRICTED');
  });
});

describe('GET /v1/me/photos', () => {
  it('lists the owner\'s photos with state, order, revision and respectful rejection reasons', async () => {
    const h = setup();
    await seedCompleteProfile(h.db, 'alice');
    const [a, b, c] = [await uploadOk(h, 'alice'), await uploadOk(h, 'alice'), await uploadOk(h, 'alice')];
    await reviewPhoto(h.db, a, 'approve', null, 'reviewer-1');
    await reviewPhoto(h.db, b, 'reject', 'face_not_clear', 'reviewer-1');

    const res = await listPhotos(h, 'alice');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ revision: 5, minPhotos: 3, maxPhotos: 6 });

    const photos = res.body.data.photos as Record<string, unknown>[];
    expect(photos.map((p) => [p['id'], p['state']])).toEqual([[a, 'approved'], [c, 'pending'], [b, 'rejected']]);
    expect(photos[2]!['rejectionReason']).toEqual({
      code: 'face_not_clear',
      message: expect.stringMatching(/choose one where your face is easy to see/),
    });
    expect(photos[0]!['rejectionReason']).toBeNull();
    expect(photos[0]!['media']).toEqual({ thumb: `/v1/media/${a}/thumb`, display: `/v1/media/${a}/display` });
  });

  it('never exposes storage keys, idempotency keys or review internals', async () => {
    const h = setup();
    await seedCompleteProfile(h.db, 'alice');
    await uploadOk(h, 'alice');

    const res = await listPhotos(h, 'alice');
    const json = JSON.stringify(res.body);
    for (const leaked of ['originalPrivateKey', 'variantKeys', 'quarantine/', 'idempotencyKey', 'requestHash', 'ownerId', 'moderationReason']) {
      expect(json).not.toContain(leaked);
    }
  });

  it('only shows the caller\'s own photos', async () => {
    const h = setup();
    await seedCompleteProfile(h.db, 'alice');
    await seedCompleteProfile(h.db, 'bob');
    await uploadOk(h, 'alice');

    expect((await listPhotos(h, 'bob')).body.data.photos).toEqual([]);
  });
});

describe('PATCH /v1/me/photos/order', () => {
  async function threePhotos(h: Harness) {
    await seedCompleteProfile(h.db, 'alice');
    const ids = [await uploadOk(h, 'alice'), await uploadOk(h, 'alice'), await uploadOk(h, 'alice')];
    const revision = (await listPhotos(h, 'alice')).body.data.revision as number;
    return { ids, revision };
  }

  function reorder(h: Harness, name: string, body: unknown) {
    return request(h.app).patch('/v1/me/photos/order').set('Authorization', `Bearer token-${name}`).send(body as object);
  }

  it('reorders photos and bumps the revision', async () => {
    const h = setup();
    const { ids, revision } = await threePhotos(h);
    const newOrder = [ids[2]!, ids[0]!, ids[1]!];

    const res = await reorder(h, 'alice', { expectedRevision: revision, photoIds: newOrder });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ revision: revision + 1, photoIds: newOrder });

    const list = await listPhotos(h, 'alice');
    expect(list.body.data.photos.map((p: { id: string }) => p.id)).toEqual(newOrder);
    expect(list.body.data.photos.map((p: { order: number }) => p.order)).toEqual([0, 1, 2]);
  });

  it('returns 409 with the current revision when the revision is stale', async () => {
    const h = setup();
    const { ids, revision } = await threePhotos(h);
    await reorder(h, 'alice', { expectedRevision: revision, photoIds: [ids[1], ids[0], ids[2]] });

    const res = await reorder(h, 'alice', { expectedRevision: revision, photoIds: [ids[2], ids[1], ids[0]] });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'REVISION_CONFLICT', currentRevision: revision + 1, retryable: true });
  });

  it('tells a stale device to refresh (409) rather than reporting a mismatch', async () => {
    const h = setup();
    const { ids, revision } = await threePhotos(h);
    await uploadOk(h, 'alice'); // added from another device

    const res = await reorder(h, 'alice', { expectedRevision: revision, photoIds: [ids[2], ids[1], ids[0]] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REVISION_CONFLICT');
  });

  it('lets only one of two concurrent reorders on the same revision win', async () => {
    const h = setup({ interleave: true });
    const { ids, revision } = await threePhotos(h);

    const results = await Promise.all([
      reorder(h, 'alice', { expectedRevision: revision, photoIds: [ids[1], ids[0], ids[2]] }),
      reorder(h, 'alice', { expectedRevision: revision, photoIds: [ids[2], ids[1], ids[0]] }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('returns 422 when IDs are missing, extra, duplicated or belong to someone else', async () => {
    const h = setup();
    const { ids, revision } = await threePhotos(h);
    await seedCompleteProfile(h.db, 'bob');
    const bobPhoto = await uploadOk(h, 'bob');

    const cases = [
      [ids[0], ids[1]],
      [...ids, uuidv4()],
      [ids[0], ids[0], ids[1]],
      [ids[0], ids[1], bobPhoto],
    ];
    for (const photoIds of cases) {
      const res = await reorder(h, 'alice', { expectedRevision: revision, photoIds });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('PHOTO_SET_MISMATCH');
    }
    expect((await getPhoto(h.db, bobPhoto))!.order).toBe(0);
  });

  it('excludes rejected photos from the set to order', async () => {
    const h = setup();
    const { ids } = await threePhotos(h);
    await reviewPhoto(h.db, ids[1]!, 'reject', 'low_quality', 'reviewer-1');
    const revision = (await listPhotos(h, 'alice')).body.data.revision as number;

    const withRejected = await reorder(h, 'alice', { expectedRevision: revision, photoIds: [ids[2], ids[1], ids[0]] });
    expect(withRejected.status).toBe(422);
    const withoutRejected = await reorder(h, 'alice', { expectedRevision: revision, photoIds: [ids[2], ids[0]] });
    expect(withoutRejected.status).toBe(200);
  });

  it('validates the body', async () => {
    const h = setup();
    const { ids, revision } = await threePhotos(h);

    for (const body of [{ photoIds: ids }, { expectedRevision: '1', photoIds: ids }, { expectedRevision: revision }, { expectedRevision: revision, photoIds: [1, 2, 3] }]) {
      const res = await reorder(h, 'alice', body);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('DELETE /v1/me/photos/:id', () => {
  it('returns 404 for anyone but the owner and leaves the photo intact', async () => {
    const h = setup();
    await seedCompleteProfile(h.db, 'alice');
    await seedCompleteProfile(h.db, 'bob');
    const id = await uploadOk(h, 'alice');

    const res = await request(h.app).delete(`/v1/me/photos/${id}`).set('Authorization', 'Bearer token-bob');
    expect(res.status).toBe(404);
    expect((await getPhoto(h.db, id))!.state).toBe('pending');
    expect(h.storage.keys()).toHaveLength(3);
  });

  it('removes access immediately, deletes objects and bumps the revision', async () => {
    const h = setup();
    await seedCompleteProfile(h.db, 'alice');
    const id = await uploadOk(h, 'alice');
    const before = (await listPhotos(h, 'alice')).body.data.revision as number;

    const res = await request(h.app).delete(`/v1/me/photos/${id}`).set('Authorization', 'Bearer token-alice');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ deleted: true, revision: before + 1 });

    expect((await listPhotos(h, 'alice')).body.data.photos).toEqual([]);
    expect(h.storage.keys()).toEqual([]);
    const media = await fetchMedia(h, 'alice', `/v1/media/${id}/display`);
    expect(media.status).toBe(404);

    const again = await request(h.app).delete(`/v1/me/photos/${id}`).set('Authorization', 'Bearer token-alice');
    expect(again.status).toBe(404);
  });

  it('keeps a tombstone so a stale upload retry cannot resurrect the photo', async () => {
    const h = setup();
    await seedCompleteProfile(h.db, 'alice');
    const image = await images.jpeg();
    const key = uuidv4();
    const id = (await upload(h, 'alice', image, key)).body.data.id as string;
    await request(h.app).delete(`/v1/me/photos/${id}`).set('Authorization', 'Bearer token-alice');

    const stale = await upload(h, 'alice', image, key);
    expect(stale.status).toBe(409);
    expect((await listPhotos(h, 'alice')).body.data.photos).toEqual([]);
  });
});

describe('GET /v1/media/:assetId/:variant (R-MEDIA-04, R-MEDIA-05)', () => {
  it('streams approved variants to an eligible viewer with private, revalidated caching', async () => {
    const h = setup();
    const [photoId] = await makeReady(h, 'alice');
    await makeReady(h, 'bob');

    for (const variant of ['thumb', 'display']) {
      const res = await fetchMedia(h, 'bob', `/v1/media/${photoId}/${variant}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/webp');
      expect(res.headers['cache-control']).toBe('private, no-cache');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect((await sharp(res.body as Buffer).metadata()).format).toBe('webp');
    }
  });

  it('rechecks access even on conditional revalidation', async () => {
    const h = setup();
    const [photoId] = await makeReady(h, 'alice');
    await makeReady(h, 'bob');
    const first = await fetchMedia(h, 'bob', `/v1/media/${photoId}/display`);

    const revalidated = await fetchMedia(h, 'bob', `/v1/media/${photoId}/display`).set('If-None-Match', first.headers['etag']!);
    expect(revalidated.status).toBe(304);

    await request(h.app).delete(`/v1/me/photos/${photoId}`).set('Authorization', 'Bearer token-alice');
    const afterDelete = await fetchMedia(h, 'bob', `/v1/media/${photoId}/display`).set('If-None-Match', first.headers['etag']!);
    expect(afterDelete.status).toBe(404);
  });

  it('never serves originals or quarantine objects, even to the owner', async () => {
    const h = setup();
    const [photoId] = await makeReady(h, 'alice');
    await makeReady(h, 'bob');

    for (const variant of ['original', 'quarantine', 'master', '..', `..%2F..%2Fquarantine%2F${userId('alice')}%2F${photoId}`]) {
      for (const viewer of ['alice', 'bob']) {
        const res = await fetchMedia(h, viewer, `/v1/media/${photoId}/${variant}`);
        expect(res.status).toBe(404);
      }
    }
    const quarantinePath = await fetchMedia(h, 'alice', `/v1/media/quarantine/${userId('alice')}/${photoId}`);
    expect(quarantinePath.status).toBe(404);
  });

  it('lets the owner preview their own pending and rejected photos', async () => {
    const h = setup();
    await seedCompleteProfile(h.db, 'alice');
    const pending = await uploadOk(h, 'alice');
    const rejected = await uploadOk(h, 'alice');
    await reviewPhoto(h.db, rejected, 'reject', 'low_quality', 'reviewer-1');

    expect((await fetchMedia(h, 'alice', `/v1/media/${pending}/thumb`)).status).toBe(200);
    expect((await fetchMedia(h, 'alice', `/v1/media/${rejected}/thumb`)).status).toBe(200);
  });

  it('denies pending, rejected and deleted photos to other users', async () => {
    const h = setup();
    const [approved] = await makeReady(h, 'alice');
    await makeReady(h, 'bob');
    const pending = await uploadOk(h, 'alice');
    const rejected = await uploadOk(h, 'alice');
    await reviewPhoto(h.db, rejected, 'reject', 'community_guidelines', 'reviewer-1');

    // Delete one of the extras so alice stays ready with three approved photos
    const extra = await uploadOk(h, 'alice');
    await reviewPhoto(h.db, extra, 'approve', null, 'reviewer-1');
    await request(h.app).delete(`/v1/me/photos/${extra}`).set('Authorization', 'Bearer token-alice');
    expect((await getUser(h.db, 'alice')).profileReady).toBe(true);

    expect((await fetchMedia(h, 'bob', `/v1/media/${approved}/display`)).status).toBe(200);
    for (const id of [pending, rejected, extra, uuidv4()]) {
      const res = await fetchMedia(h, 'bob', `/v1/media/${id}/display`);
      expect(res.status).toBe(404);
      expect(errorCode(res)).toBe('MEDIA_UNAVAILABLE');
    }
  });

  it('denies a viewer who is not active and ready', async () => {
    const h = setup();
    const [photoId] = await makeReady(h, 'alice');
    await seedCompleteProfile(h.db, 'carol'); // onboarding, no approved photos

    const res = await fetchMedia(h, 'carol', `/v1/media/${photoId}/display`);
    expect(res.status).toBe(403);
    expect(errorCode(res)).toBe('ACCOUNT_NOT_ELIGIBLE');
  });

  it('denies approved photos when the owner is no longer active and ready', async () => {
    const h = setup();
    const [photoId] = await makeReady(h, 'alice');
    await makeReady(h, 'bob');

    await h.db.collection('users').updateOne({ _id: userId('alice') } as Doc, { $set: { accountStatus: 'suspended' } });
    const res = await fetchMedia(h, 'bob', `/v1/media/${photoId}/display`);
    expect(res.status).toBe(404);
  });

  it('requires authentication', async () => {
    const h = setup();
    const [photoId] = await makeReady(h, 'alice');
    const res = await request(h.app).get(`/v1/media/${photoId}/display`);
    expect(res.status).toBe(401);
  });
});

describe('Readiness from approved photos', () => {
  it('approving the 3rd photo makes a complete profile ready; deleting one drops readiness', async () => {
    const h = setup();
    await seedCompleteProfile(h.db, 'alice');
    const ids = [await uploadOk(h, 'alice'), await uploadOk(h, 'alice'), await uploadOk(h, 'alice')];

    await reviewPhoto(h.db, ids[0]!, 'approve', null, 'reviewer-1');
    await reviewPhoto(h.db, ids[1]!, 'approve', null, 'reviewer-1');
    expect((await getUser(h.db, 'alice')).profileReady).toBe(false);

    await reviewPhoto(h.db, ids[2]!, 'approve', null, 'reviewer-1');
    let alice = await getUser(h.db, 'alice');
    expect(alice.profileReady).toBe(true);
    expect(alice.accountStatus).toBe('active');

    await request(h.app).delete(`/v1/me/photos/${ids[0]}`).set('Authorization', 'Bearer token-alice');
    alice = await getUser(h.db, 'alice');
    expect(alice.profileReady).toBe(false);
  });

  it('pending photos do not count toward readiness', async () => {
    const h = setup();
    await seedCompleteProfile(h.db, 'alice');
    for (let i = 0; i < 6; i++) await uploadOk(h, 'alice');
    await request(h.app).get('/v1/me').set('Authorization', 'Bearer token-alice');
    expect((await getUser(h.db, 'alice')).profileReady).toBe(false);
  });
});

describe('reviewPhoto', () => {
  it('records actor, target, reason, before/after state and timestamp in the audit log', async () => {
    const h = setup();
    await seedCompleteProfile(h.db, 'alice');
    const id = await uploadOk(h, 'alice');

    await reviewPhoto(h.db, id, 'reject', 'contact_details', 'reviewer-7');

    const entries = await h.db.collection('auditLog').find({ targetId: id }).toArray();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'photo.reject',
      actorId: 'reviewer-7',
      targetType: 'photo',
      targetId: id,
      targetOwnerId: userId('alice'),
      reason: 'contact_details',
      before: { state: 'pending', moderationReason: null },
      after: { state: 'rejected', moderationReason: 'contact_details' },
      createdAt: expect.any(Date),
    });
  });

  it('requires a known rejection reason and an actor', async () => {
    const h = setup();
    await seedCompleteProfile(h.db, 'alice');
    const id = await uploadOk(h, 'alice');

    await expect(reviewPhoto(h.db, id, 'reject', null, 'reviewer-1')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(reviewPhoto(h.db, id, 'reject', 'ugly', 'reviewer-1')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(reviewPhoto(h.db, id, 'approve', null, '  ')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await getPhoto(h.db, id))!.state).toBe('pending');
    expect(await h.db.collection('auditLog').countDocuments({})).toBe(0);
  });

  it('only reviews pending photos, once', async () => {
    const h = setup();
    await seedCompleteProfile(h.db, 'alice');
    const id = await uploadOk(h, 'alice');
    await reviewPhoto(h.db, id, 'approve', 'looks good', 'reviewer-1');

    await expect(reviewPhoto(h.db, id, 'reject', 'low_quality', 'reviewer-2')).rejects.toBeInstanceOf(ReviewError);
    await expect(reviewPhoto(h.db, 'missing', 'approve', null, 'reviewer-1')).rejects.toMatchObject({ code: 'PHOTO_NOT_FOUND' });
    expect((await getPhoto(h.db, id))!.state).toBe('approved');
    expect(await h.db.collection('auditLog').countDocuments({})).toBe(1);
  });
});

describe('toPublicPhotoDTO', () => {
  it('exposes only display fields', async () => {
    const h = setup();
    await seedCompleteProfile(h.db, 'alice');
    const id = await uploadOk(h, 'alice');
    const dto = toPublicPhotoDTO((await getPhoto(h.db, id))!);
    expect(Object.keys(dto).sort()).toEqual(['contentVersion', 'height', 'id', 'media', 'order', 'width']);
  });
});

describe('Media cleanup worker', () => {
  it('expires abandoned uploads, frees their slot and removes their objects', async () => {
    const h = setup();
    await seedCompleteProfile(h.db, 'alice');
    const id = await uploadOk(h, 'alice');
    // Simulate a crash after objects were written but before the upload committed
    await h.db.collection('photos').updateOne({ _id: id } as Doc, {
      $set: { state: 'processing', createdAt: new Date(Date.now() - 60 * 60 * 1000) },
    });
    const revision = (await listPhotos(h, 'alice')).body.data.revision as number;

    const result = await runMediaCleanup(h.db, h.storage);
    expect(result).toEqual({ expired: 1, purged: 1, retryLater: 0 });
    expect(h.storage.keys()).toEqual([]);
    expect(await getPhoto(h.db, id)).toBeNull();
    expect((await listPhotos(h, 'alice')).body.data.revision).toBe(revision + 1);
  });

  it('leaves recent in-flight uploads alone', async () => {
    const h = setup();
    await seedCompleteProfile(h.db, 'alice');
    const id = await uploadOk(h, 'alice');
    await h.db.collection('photos').updateOne({ _id: id } as Doc, { $set: { state: 'processing' } });

    expect(await runMediaCleanup(h.db, h.storage)).toEqual({ expired: 0, purged: 0, retryLater: 0 });
    expect(h.storage.keys()).toHaveLength(3);
  });

  it('retries object deletion that failed during a photo delete', async () => {
    const h = setup();
    await seedCompleteProfile(h.db, 'alice');
    const id = await uploadOk(h, 'alice');
    const spy = vi.spyOn(h.storage, 'deleteObject').mockRejectedValue(new Error('storage offline'));

    const res = await request(h.app).delete(`/v1/me/photos/${id}`).set('Authorization', 'Bearer token-alice');
    expect(res.status).toBe(200);
    expect((await fetchMedia(h, 'alice', `/v1/media/${id}/display`)).status).toBe(404);
    expect(h.storage.keys()).toHaveLength(3);

    expect(await runMediaCleanup(h.db, h.storage)).toEqual({ expired: 0, purged: 0, retryLater: 1 });
    spy.mockRestore();
    expect(await runMediaCleanup(h.db, h.storage)).toEqual({ expired: 0, purged: 1, retryLater: 0 });
    expect(h.storage.keys()).toEqual([]);
    expect((await getPhoto(h.db, id))!.objectsPurgedAt).toBeInstanceOf(Date);
    expect(await runMediaCleanup(h.db, h.storage)).toEqual({ expired: 0, purged: 0, retryLater: 0 });
  });
});
