import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import request from 'supertest';
import { parse } from 'yaml';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { MongoClient, type Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { createApp } from '../src/app.js';
import { ensureIndexes } from '../src/indexes.js';
import { createMediaRoutes, type MediaRoutesConfig } from '../src/modules/media/routes.js';
import { createDiscoveryRoutes } from '../src/modules/discovery/routes.js';
import type { DiscoveryCity, LocationCatalog } from '../src/modules/discovery/location.js';
import { processImage } from '../src/modules/media/processing.js';
import { InMemoryMediaStorage } from '../src/adapters/media/in-memory.js';
import { createEmptyProfile } from '../src/modules/profiles/schema.js';
import { createDefaultPreferences } from '../src/modules/preferences/schema.js';
import { RATE_LIMITS_COLLECTION } from '../src/modules/rate-limit/index.js';
import type { UserDocument } from '../src/modules/auth/account.js';
import { createMultiUserAuth } from './support.js';
import * as images from './fixtures/images/factory.js';

// Real implementation by default; tests can hold calls at a barrier
vi.mock('../src/modules/media/processing.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/modules/media/processing.js')>();
  return { ...actual, processImage: vi.fn(actual.processImage) };
});

// --- Contract validation (same approach as contract.test.ts) ---

const contractsDir = fileURLToPath(new URL('../../../contracts/', import.meta.url));
const specs = {
  openapi: parse(readFileSync(path.join(contractsDir, 'openapi.yaml'), 'utf8')),
  media: parse(readFileSync(path.join(contractsDir, 'openapi', 'media.yaml'), 'utf8')),
};
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
for (const [name, doc] of Object.entries(specs)) ajv.addSchema(doc, name);

function expectContract(body: unknown, status: number, apiPath: string, method: string, specName: keyof typeof specs) {
  const response = specs[specName].paths[apiPath]?.[method]?.responses?.[String(status)];
  if (!response) throw new Error(`No contract for ${method.toUpperCase()} ${apiPath} ${status}`);
  const base = response.$ref
    ? (response.$ref as string).slice(1)
    : `/paths/${apiPath.replace(/~/g, '~0').replace(/\//g, '~1')}/${method}/responses/${status}`;
  const validate = ajv.getSchema(`${specName}#${base}/content/application~1json/schema`)!;
  validate(body);
  expect(validate.errors ?? [], `${method.toUpperCase()} ${apiPath} ${status}`).toEqual([]);
  // Every limit response documents its Retry-After header
  const resolved = response.$ref
    ? specs[specName].components.responses[(response.$ref as string).split('/').pop()!]
    : response;
  expect(resolved.headers?.['Retry-After'], `Retry-After documented for ${apiPath} ${status}`).toBeDefined();
}

// --- Real local replica set, isolated database per run ---

const uri = process.env['MONGO_URI']!;
const dbName = `lemon_test_rate_limit_routes_${process.pid}_${Date.now()}`;
const START = new Date('2026-11-10T12:10:00Z'); // 50 minutes before the next hourly window
const clock = { now: START };
const auth = createMultiUserAuth();
let client: MongoClient;
let db: Db;

beforeAll(async () => {
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(`Rate limit route tests need MongoDB at ${uri} (run the local replica set)`, { cause: err });
  }
  db = client.db(dbName);
  await ensureIndexes(db);
});

afterAll(async () => {
  await db?.dropDatabase();
  await client?.close();
});

const { processImage: realProcessImage } =
  await vi.importActual<typeof import('../src/modules/media/processing.js')>('../src/modules/media/processing.js');

beforeEach(async () => {
  clock.now = START;
  // Call counts are asserted per test, so clear them along with any leftover override
  vi.mocked(processImage).mockClear();
  vi.mocked(processImage).mockImplementation(realProcessImage);
  await Promise.all(
    ['users', 'profiles', 'preferences', 'photos', 'photoSets', 'promptAnswers', 'discoverySessions', 'passes', 'likes', RATE_LIMITS_COLLECTION]
      .map((c) => db.collection(c).deleteMany({})),
  );
});

afterEach(() => {
  vi.mocked(processImage).mockImplementation(realProcessImage);
});

const as = (name: string) => `Bearer token-${name}`;
const attempts = (accountId: string) =>
  db.collection(RATE_LIMITS_COLLECTION).find({ accountId }).toArray().then((docs) => docs.reduce((n, d) => n + (d['count'] as number), 0));

// ============================================================================
// POST /v1/me/photos
// ============================================================================

async function seedUploader(name: string): Promise<void> {
  const now = new Date();
  await db.collection<UserDocument>('users').insertOne({
    _id: `user-${name}`, firebaseUid: `uid-${name}`, accountStatus: 'onboarding', emailVerified: true,
    birthDate: '1994-05-12', adultEligible: true, discoverPaused: false, profileReady: false, guardVersion: 1,
    agreements: { termsVersion: '1.0', acceptedAt: now }, createdAt: now, updatedAt: now,
  });
}

function mediaApp(limits: Partial<MediaRoutesConfig>) {
  const storage = new InMemoryMediaStorage();
  const app = createApp({
    mongoCheck: async () => true,
    firebaseCheck: async () => true,
    routes: [
      createMediaRoutes(
        db,
        auth,
        { MEDIA_MAX_BYTES: 10 * 1024 * 1024, MEDIA_LOCAL_DIR: 'unused', ...limits },
        { profileAccess: { canViewProfile: async () => true }, storage, now: () => clock.now },
      ),
    ],
  });
  return app;
}

let imageSeed = 0;
/** A distinct valid JPEG each call */
function uniqueJpeg(): Promise<Buffer> {
  imageSeed++;
  return images.jpeg(400, 500, `rgb(${(imageSeed * 37) % 200}, 80, 120)`);
}
const NOT_AN_IMAGE = Buffer.from('definitely not an image');

function upload(app: ReturnType<typeof mediaApp>, name: string, image: Buffer, key: string = uuidv4()) {
  return request(app)
    .post('/v1/me/photos')
    .set('Authorization', as(name))
    .set('Idempotency-Key', key)
    .attach('photo', image, { filename: 'photo.jpg', contentType: 'image/jpeg' });
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: { error?: { code: string } } | null;
}

/**
 * Start a multipart upload that announces 5 MB but sends only its first part
 * and never finishes. A server that waits for the body never answers it.
 */
function stalledUpload(port: number, name: string) {
  const boundary = 'lemon-test-boundary';
  const req = http.request({
    host: '127.0.0.1',
    port,
    method: 'POST',
    path: '/v1/me/photos',
    headers: {
      Authorization: as(name),
      'Idempotency-Key': uuidv4(),
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(5 * 1024 * 1024),
    },
  });
  const response = new Promise<RawResponse>((resolve, reject) => {
    req.on('response', (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
  });
  req.write(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`);
  req.write(Buffer.alloc(16 * 1024, 7));
  return { req, response };
}

async function listen(app: ReturnType<typeof mediaApp>) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`No response within ${ms} ms: ${what}`)), ms)),
  ]);
}

describe('POST /v1/me/photos: hourly upload attempts', () => {
  it('counts every attempt per account, failed ones included, and resets on the hour', async () => {
    await seedUploader('alice');
    await seedUploader('bob');
    const app = mediaApp({ PHOTO_UPLOADS_PER_HOUR: 3 });

    expect((await upload(app, 'alice', await uniqueJpeg())).status).toBe(201);
    expect((await upload(app, 'alice', NOT_AN_IMAGE)).status).toBe(415);
    expect((await upload(app, 'alice', await uniqueJpeg())).status).toBe(201);

    const limited = await upload(app, 'alice', await uniqueJpeg());
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('3000');
    expect(limited.body).toEqual({
      error: { code: 'RATE_LIMITED', message: expect.any(String), retryable: true, retryAfterSeconds: 3000 },
      requestId: expect.any(String),
    });
    expectContract(limited.body, 429, '/v1/me/photos', 'post', 'media');
    expect(await db.collection('photos').countDocuments({ ownerId: 'user-alice' })).toBe(2);

    expect((await upload(app, 'bob', await uniqueJpeg())).status).toBe(201);

    clock.now = new Date('2026-11-10T13:00:00Z');
    expect((await upload(app, 'alice', await uniqueJpeg())).status).toBe(201);
  });

  it('replays a finished upload without spending an attempt, even after the limit is reached', async () => {
    await seedUploader('alice');
    const app = mediaApp({ PHOTO_UPLOADS_PER_HOUR: 1 });
    const image = await uniqueJpeg();
    const key = uuidv4();

    const first = await upload(app, 'alice', image, key);
    expect(first.status).toBe(201);
    for (let i = 0; i < 3; i++) {
      const replay = await upload(app, 'alice', image, key);
      expect(replay.status).toBe(200);
      expect(replay.body.data.id).toBe(first.body.data.id);
    }
    expect(await attempts('user-alice')).toBe(1);

    expect((await upload(app, 'alice', await uniqueJpeg())).status).toBe(429);
    expect((await upload(app, 'alice', image, key)).status).toBe(200);
    // A stored key with different bytes is still a conflict, not a charge
    expect((await upload(app, 'alice', await uniqueJpeg(), key)).body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await attempts('user-alice')).toBe(1);
  });

  it('refuses an over-limit upload before reading its body', async () => {
    await seedUploader('alice');
    const app = mediaApp({ PHOTO_UPLOADS_PER_HOUR: 1, MEDIA_MAX_BYTES: 1024 });
    expect((await upload(app, 'alice', NOT_AN_IMAGE)).status).toBe(415);

    // Parsing first would have answered 413 or 400
    expect((await upload(app, 'alice', Buffer.alloc(4096, 1))).status).toBe(429);
    const notMultipart = await request(app).post('/v1/me/photos').set('Authorization', as('alice'))
      .set('Idempotency-Key', uuidv4()).send({ photo: 'x' });
    expect(notMultipart.status).toBe(429);

    // The answer arrives while the body is still unsent: nothing waits for or buffers it
    const server = await listen(app);
    const stalled = stalledUpload(server.port, 'alice');
    try {
      const res = await within(stalled.response, 3000, 'over-limit stalled upload');
      expect(res.status).toBe(429);
      expect(res.headers['retry-after']).toBe('3000');
      expect(res.body?.error?.code).toBe('RATE_LIMITED');
    } finally {
      stalled.req.destroy();
      await server.close();
    }
    expect(processImage).toHaveBeenCalledTimes(1);
  });

  it('does not limit uploads when the setting is not configured', async () => {
    await seedUploader('alice');
    const app = mediaApp({});
    for (let i = 0; i < 4; i++) expect((await upload(app, 'alice', NOT_AN_IMAGE)).status).toBe(415);
    expect(await db.collection(RATE_LIMITS_COLLECTION).countDocuments({})).toBe(0);
  });
});

describe('POST /v1/me/photos: concurrent uploads per process', () => {
  it('turns uploads away with 503 UPLOADS_BUSY while every slot is decoding, spending no attempt', async () => {
    await seedUploader('alice');
    await seedUploader('bob');
    const app = mediaApp({ MEDIA_MAX_CONCURRENT_UPLOADS: 1, PHOTO_UPLOADS_PER_HOUR: 2 });

    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(processImage).mockImplementationOnce(async (input) => {
      await held;
      return realProcessImage(input);
    });

    const first = upload(app, 'alice', await uniqueJpeg()).then((r) => r);
    await vi.waitFor(() => expect(processImage).toHaveBeenCalledTimes(1));

    for (const name of ['alice', 'bob']) {
      const busy = await upload(app, name, await uniqueJpeg());
      expect(busy.status).toBe(503);
      expect(busy.headers['retry-after']).toBe('5');
      expect(busy.body).toEqual({
        error: { code: 'UPLOADS_BUSY', message: expect.any(String), retryable: true, retryAfterSeconds: 5 },
        requestId: expect.any(String),
      });
      expectContract(busy.body, 503, '/v1/me/photos', 'post', 'media');
    }
    expect(await attempts('user-alice')).toBe(1);
    expect(await attempts('user-bob')).toBe(0);

    release();
    expect((await first).status).toBe(201);

    // The slot is free again, and the refused upload did not use alice's second attempt
    expect((await upload(app, 'alice', await uniqueJpeg())).status).toBe(201);
    expect((await upload(app, 'alice', await uniqueJpeg())).status).toBe(429);
  });

  it('frees the slot after a rejected, refused or failed upload', async () => {
    await seedUploader('alice');
    const app = mediaApp({ MEDIA_MAX_CONCURRENT_UPLOADS: 1, PHOTO_UPLOADS_PER_HOUR: 3 });

    expect((await upload(app, 'alice', NOT_AN_IMAGE)).status).toBe(415);
    vi.mocked(processImage).mockRejectedValueOnce(new Error('decoder crashed'));
    expect((await upload(app, 'alice', await uniqueJpeg())).status).toBe(500);
    expect((await upload(app, 'alice', await uniqueJpeg())).status).toBe(201);
    expect((await upload(app, 'alice', await uniqueJpeg())).status).toBe(429);
    // Still not busy: every path above released its slot
    expect((await upload(app, 'alice', await uniqueJpeg())).status).toBe(429);
  });

  it('holds a slot while the body is still arriving and frees it when the client gives up', async () => {
    await seedUploader('alice');
    const app = mediaApp({ MEDIA_MAX_CONCURRENT_UPLOADS: 1 });
    const server = await listen(app);
    const stalled = stalledUpload(server.port, 'alice');
    stalled.response.catch(() => undefined); // destroyed below without a response
    try {
      await vi.waitFor(async () => {
        expect((await upload(app, 'alice', NOT_AN_IMAGE)).status).toBe(503);
      }, { timeout: 3000, interval: 25 });

      stalled.req.destroy();
      await vi.waitFor(async () => {
        expect((await upload(app, 'alice', NOT_AN_IMAGE)).status).toBe(415);
      }, { timeout: 3000, interval: 25 });
    } finally {
      stalled.req.destroy();
      await server.close();
    }
  });
});

// ============================================================================
// GET /v1/discovery
// ============================================================================

const CITIES: DiscoveryCity[] = [{ id: 'riverton-xa', stateCode: 'XA', countryCode: 'US' }];
const catalog: LocationCatalog = { findCity: (id) => CITIES.find((c) => c.id === id) };
const SECRET = 'rate-limit-test-secret-'.padEnd(48, 'z');

async function seedMember(name: string, gender: 'man' | 'woman', options: { paused?: boolean } = {}): Promise<void> {
  const now = new Date();
  await db.collection<UserDocument>('users').insertOne({
    _id: name, firebaseUid: `uid-${name}`, accountStatus: 'active', emailVerified: true,
    birthDate: gender === 'man' ? '1994-02-15' : '1996-05-01', adultEligible: true,
    discoverPaused: options.paused ?? false, profileReady: true, guardVersion: 1,
    agreements: { termsVersion: '2026-10', acceptedAt: now }, createdAt: now, updatedAt: now,
  });
  await db.collection('profiles').insertOne({
    ...createEmptyProfile(name), displayName: name, genderIdentity: gender, cityId: 'riverton-xa',
    stateCode: 'XA', countryCode: 'US', intention: 'serious',
  });
  await db.collection('preferences').insertOne({
    ...createDefaultPreferences(name), acceptedGenderCategories: [gender === 'man' ? 'woman' : 'man'],
    minAge: 25, maxAge: 40, locationScope: 'state', longDistance: false,
  });
  const photo = { ownerId: name, width: 1080, height: 1350, contentVersion: 1, moderationReason: null,
    originalPrivateKey: `quarantine/${name}`, variantKeys: { thumb: 't', display: 'd' }, requestHash: 'h',
    reviewedAt: now, deletedAt: null, objectsPurgedAt: null, createdAt: now, updatedAt: now };
  await db.collection('photos').insertMany([0, 1, 2].map((order) => ({ ...photo, _id: `${name}-photo-${order}`, order, state: 'approved' })));
}

function discoveryApp(sessionsPerHour?: number) {
  return createApp({
    mongoCheck: async () => true,
    firebaseCheck: async () => true,
    routes: [
      createDiscoveryRoutes(
        db,
        auth,
        {
          NODE_ENV: 'test', DISCOVERY_CURSOR_SECRET: SECRET, PASS_COOLDOWN_DAYS: 30,
          ...(sessionsPerHour === undefined ? {} : { DISCOVERY_SESSIONS_PER_HOUR: sessionsPerHour }),
        },
        { now: () => clock.now, newSeed: () => 7, catalog, pageSize: 1 },
      ),
    ],
  });
}

const discover = (app: ReturnType<typeof discoveryApp>, name: string, cursor?: string) =>
  request(app).get('/v1/discovery').query(cursor === undefined ? {} : { cursor }).set('Authorization', as(name));

describe('GET /v1/discovery: new sessions per hour', () => {
  beforeEach(async () => {
    for (const name of ['abeba', 'hanna', 'selam']) await seedMember(name, 'woman');
    await seedMember('dawit', 'man');
    await seedMember('yonas', 'man');
  });

  it('limits requests without a cursor and leaves paging with a cursor unlimited', async () => {
    const app = discoveryApp(2);

    expect((await discover(app, 'dawit')).status).toBe(200);
    const second = await discover(app, 'dawit');
    expect(second.status).toBe(200);
    const cursor = second.body.meta.nextCursor as string;
    expect(cursor).toEqual(expect.any(String));

    const limited = await discover(app, 'dawit');
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('3000');
    expect(limited.body.error).toEqual({
      code: 'RATE_LIMITED', message: expect.any(String), retryable: true, retryAfterSeconds: 3000,
    });
    expectContract(limited.body, 429, '/v1/discovery', 'get', 'openapi');
    // The refused request built no session (the expensive part never ran)
    expect(await db.collection('discoverySessions').countDocuments({ ownerId: 'dawit' })).toBe(2);

    // Paging is not counted, however often a page is fetched
    for (let i = 0; i < 5; i++) {
      const page = await discover(app, 'dawit', cursor);
      expect(page.status).toBe(200);
      expect(page.body.data.items).toHaveLength(1);
    }
    expect(await attempts('dawit')).toBe(2);

    // Per account
    expect((await discover(app, 'yonas')).status).toBe(200);

    clock.now = new Date('2026-11-10T13:00:00Z');
    expect((await discover(app, 'dawit')).status).toBe(200);
  });

  it('counts a request without a cursor whatever its outcome', async () => {
    await db.collection('users').updateOne({ _id: 'dawit' } as never, { $set: { discoverPaused: true } });
    const app = discoveryApp(1);
    expect((await discover(app, 'dawit')).body.error.code).toBe('DISCOVERY_PAUSED');
    expect((await discover(app, 'dawit')).status).toBe(429);
  });

  it('does not limit new sessions when the setting is not configured', async () => {
    const app = discoveryApp();
    for (let i = 0; i < 4; i++) expect((await discover(app, 'dawit')).status).toBe(200);
    expect(await db.collection(RATE_LIMITS_COLLECTION).countDocuments({})).toBe(0);
  });
});
