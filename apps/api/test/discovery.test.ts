import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import request from 'supertest';
import { parse } from 'yaml';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { MongoClient, type Db } from 'mongodb';
import { createApp } from '../src/app.js';
import { ensureIndexes } from '../src/indexes.js';
import { createDiscoveryRoutes, type DiscoveryRouteOverrides } from '../src/modules/discovery/routes.js';
import { createDiscoveryService } from '../src/modules/discovery/service.js';
import { combineExclusions, type PairExclusionProvider } from '../src/modules/discovery/exclusions.js';
import { decodeCursor, encodeCursor } from '../src/modules/discovery/cursor.js';
import type { DiscoveryCity, LocationCatalog } from '../src/modules/discovery/location.js';
import type { DiscoverySessionDocument, PassDocument } from '../src/modules/discovery/schema.js';
import { createEmptyProfile } from '../src/modules/profiles/schema.js';
import { createDefaultPreferences, type LocationScope } from '../src/modules/preferences/schema.js';
import type { AccountStatusType, UserDocument } from '../src/modules/auth/account.js';
import { createMultiUserAuth } from './support.js';

// --- Contract validation for discovery responses (same approach as contract.test.ts) ---

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
  validate(res.body);
  expect(validate.errors ?? [], `${method.toUpperCase()} ${apiPath} ${res.status}`).toEqual([]);
}

// --- Fictional location catalog (P-07 launch metros are not decided) ---

const CITIES: DiscoveryCity[] = [
  { id: 'springfield-xa', stateCode: 'XA', countryCode: 'US', metroId: 'metro-lakes' },
  { id: 'springfield-xb', stateCode: 'XB', countryCode: 'US' },
  { id: 'riverton-xa', stateCode: 'XA', countryCode: 'US' },
  { id: 'lakeview-xa', stateCode: 'XA', countryCode: 'US', metroId: 'metro-lakes' },
  { id: 'harbor-xb', stateCode: 'XB', countryCode: 'US', metroId: 'metro-lakes' },
  { id: 'abroad-city', stateCode: 'ZZ', countryCode: 'ET' },
];
const catalog: LocationCatalog = {
  findCity: (id) => CITIES.find((c) => c.id === id),
  metroCityIds: (metroId) => CITIES.filter((c) => c.metroId === metroId).map((c) => c.id),
};

// --- Real local replica set, isolated database per run ---

const uri = process.env['MONGO_URI']!;
const dbName = `lemon_test_discovery_${process.pid}_${Date.now()}`;
const START = new Date('2026-11-10T12:00:00Z');
const SECRET = 'discovery-test-secret-'.padEnd(48, 'z');
const DAY_MS = 24 * 60 * 60 * 1000;
const clock = { now: START };

let client: MongoClient;
let db: Db;
const auth = createMultiUserAuth();

// Fake Phase 09/12 providers: symmetric pair sets
const pairKey = (a: string, b: string) => [a, b].sort().join('|');
const blockedPairs = new Set<string>();
const terminalPairs = new Set<string>();
const reportHiddenPairs = new Set<string>();
const fromPairs = (pairs: Set<string>): PairExclusionProvider => ({
  excludedAmong: vi.fn(async (viewerId: string, ids: readonly string[]) =>
    new Set(ids.filter((id) => pairs.has(pairKey(viewerId, id))))),
});
const blocks = fromPairs(blockedPairs);
const terminal = fromPairs(terminalPairs);
const reportHides = fromPairs(reportHiddenPairs);
const exclusions = combineExclusions(blocks, terminal, reportHides);

function makeApp(overrides: DiscoveryRouteOverrides = {}) {
  return createApp({
    mongoCheck: async () => true,
    firebaseCheck: async () => true,
    routes: [
      createDiscoveryRoutes(
        db,
        auth,
        { NODE_ENV: 'test', DISCOVERY_CURSOR_SECRET: SECRET, PASS_COOLDOWN_DAYS: 30 },
        { now: () => clock.now, newSeed: () => 42, catalog, exclusions, ...overrides },
      ),
    ],
  });
}

interface PersonSpec {
  gender?: string;
  interestedIn?: string[];
  birthDate?: string;
  cityId?: string;
  stateCode?: string;
  countryCode?: string;
  scope?: LocationScope;
  minAge?: number;
  maxAge?: number;
  longDistance?: boolean;
  status?: AccountStatusType;
  ready?: boolean;
  paused?: boolean;
  hometown?: string;
  withPreferences?: boolean;
}

async function seed(name: string, s: PersonSpec = {}): Promise<string> {
  const cityId = s.cityId ?? 'riverton-xa';
  const now = new Date();
  const user: UserDocument = {
    _id: name,
    firebaseUid: `uid-${name}`,
    accountStatus: s.status ?? 'active',
    emailVerified: true,
    birthDate: s.birthDate ?? '1996-05-01',
    adultEligible: true,
    discoverPaused: s.paused ?? false,
    profileReady: s.ready ?? true,
    guardVersion: 1,
    agreements: { termsVersion: '2026-10', acceptedAt: now },
    createdAt: now,
    updatedAt: now,
  };
  await db.collection<UserDocument>('users').insertOne(user);
  await db.collection('profiles').insertOne({
    ...createEmptyProfile(name),
    displayName: name,
    genderIdentity: s.gender ?? 'woman',
    cityId,
    stateCode: s.stateCode ?? catalog.findCity(cityId)?.stateCode ?? 'XA',
    countryCode: s.countryCode ?? 'US',
    intention: 'serious',
    hometown: s.hometown ?? null,
    hometownDisplay: 'public',
  });
  if (s.withPreferences !== false) {
    await db.collection('preferences').insertOne({
      ...createDefaultPreferences(name),
      acceptedGenderCategories: s.interestedIn ?? ['man'],
      minAge: s.minAge ?? 25,
      maxAge: s.maxAge ?? 40,
      locationScope: s.scope ?? 'state',
      longDistance: s.longDistance ?? false,
    });
  }
  const photoBase = { ownerId: name, width: 1080, height: 1350, contentVersion: 1, moderationReason: null,
    originalPrivateKey: `quarantine/${name}`, variantKeys: { thumb: 't', display: 'd' }, requestHash: 'h',
    reviewedAt: now, deletedAt: null, objectsPurgedAt: null, createdAt: now, updatedAt: now };
  await db.collection('photos').insertMany([
    ...[0, 1, 2].map((order) => ({ ...photoBase, _id: `${name}-photo-${order}`, order, state: 'approved' })),
    { ...photoBase, _id: `${name}-photo-pending`, order: 3, state: 'pending' },
  ]);
  await db.collection('promptAnswers').insertMany([0, 1, 2].map((slot) => ({
    _id: `${name}-answer-${slot}`, ownerId: name, promptId: ['prompt-tradition', 'prompt-sunday', 'prompt-home'][slot],
    slot, approvedText: `Answer ${slot}`, pendingText: slot === 0 ? 'Unreviewed edit' : null,
    state: slot === 0 ? 'pending' : 'approved', revision: 1, publishedRevision: 1, createdAt: now, updatedAt: now,
  })));
  return name;
}

const woman = (name: string, s: PersonSpec = {}) => seed(name, s);
const man = (name: string, s: PersonSpec = {}) =>
  seed(name, { gender: 'man', interestedIn: ['woman'], birthDate: '1994-02-15', ...s });

const as = (name: string) => `Bearer token-${name}`;
const discover = (app: ReturnType<typeof makeApp>, name: string, cursor?: string) =>
  request(app).get('/v1/discovery').query(cursor === undefined ? {} : { cursor }).set('Authorization', as(name));
const pass = (app: ReturnType<typeof makeApp>, name: string, candidateId: unknown) =>
  request(app).post('/v1/passes').set('Authorization', as(name)).send({ candidateId });

const ids = (res: request.Response): string[] =>
  (res.body.data.items as { profile: { userId: string } }[]).map((c) => c.profile.userId);

/** Follow cursors to the end of a session, collecting every returned candidate. */
async function drain(app: ReturnType<typeof makeApp>, name: string): Promise<{ seen: string[]; pages: number }> {
  let res = await discover(app, name);
  const seen = [...ids(res)];
  let pages = 1;
  while (res.body.meta.nextCursor) {
    res = await discover(app, name, res.body.meta.nextCursor);
    expect(res.status).toBe(200);
    seen.push(...ids(res));
    pages++;
  }
  return { seen, pages };
}

async function onlySession(): Promise<DiscoverySessionDocument> {
  const all = await db.collection<DiscoverySessionDocument>('discoverySessions').find().toArray();
  expect(all).toHaveLength(1);
  return all[0]!;
}

beforeAll(async () => {
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(`Discovery integration tests need MongoDB at ${uri} (run the local replica set)`, { cause: err });
  }
  db = client.db(dbName);
  await ensureIndexes(db);
});

afterAll(async () => {
  await db?.dropDatabase();
  await client?.close();
});

beforeEach(async () => {
  clock.now = START;
  blockedPairs.clear();
  terminalPairs.clear();
  reportHiddenPairs.clear();
  vi.clearAllMocks();
  await Promise.all(
    ['users', 'profiles', 'preferences', 'photos', 'promptAnswers', 'passes', 'discoverySessions', 'likes']
      .map((c) => db.collection(c).deleteMany({})),
  );
});

describe('GET /v1/discovery: viewer guard', () => {
  it('requires authentication and an account', async () => {
    const app = makeApp();
    const res = await request(app).get('/v1/discovery');
    expect(res.status).toBe(401);
    expectContract(res, '/v1/discovery', 'get');
    const unknown = await discover(app, 'nobody');
    expect(unknown.status).toBe(404);
    expectContract(unknown, '/v1/discovery', 'get');
  });

  it.each([
    ['onboarding', { status: 'onboarding' as const, ready: false }],
    ['suspended', { status: 'suspended' as const }],
    ['incomplete', { ready: false }],
    ['without preferences', { withPreferences: false }],
    ['on a stale city ID', { cityId: 'retired-city-xa', stateCode: 'XA' }],
    ['living outside the US', { cityId: 'abroad-city' }],
  ])('rejects a viewer who is %s', async (_label, s) => {
    await woman('viewer', s);
    const res = await discover(makeApp(), 'viewer');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_NOT_ELIGIBLE');
    expectContract(res, '/v1/discovery', 'get');
  });

  it('tells a paused viewer that Discover is paused', async () => {
    await woman('viewer', { paused: true });
    const res = await discover(makeApp(), 'viewer');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('DISCOVERY_PAUSED');
  });
});

describe('GET /v1/discovery: mutual eligibility', () => {
  it('returns only public DTOs and approved media references', async () => {
    await woman('viewer');
    await man('dawit', { hometown: 'Asmara' });
    const res = await discover(makeApp(), 'viewer');
    expect(res.status).toBe(200);
    expectContract(res, '/v1/discovery', 'get');
    expect(res.body.data.status).toBe('end');
    expect(res.body.meta.nextCursor).toBeNull();

    const [card] = res.body.data.items;
    expect(card.profile).toMatchObject({ userId: 'dawit', displayName: 'dawit', hometown: 'Asmara', stateCode: 'XA' });
    // Published text only; the edit awaiting review never leaks
    expect(card.profile.promptAnswers.map((a: { text: string }) => a.text)).toEqual(['Answer 0', 'Answer 1', 'Answer 2']);
    expect(card.profile.promptAnswers.map((a: { contentVersion: number }) => a.contentVersion)).toEqual([1, 1, 1]);
    // Photos come from the shared public projection; the card has nothing else
    expect(Object.keys(card)).toEqual(['profile']);
    expect(card.profile.photos.map((p: { id: string }) => p.id)).toEqual(['dawit-photo-0', 'dawit-photo-1', 'dawit-photo-2']);
    expect(card.profile.photos[0].media).toEqual({ thumb: '/v1/media/dawit-photo-0/thumb', display: '/v1/media/dawit-photo-0/display' });

    const body = JSON.stringify(res.body);
    for (const secret of ['1994-02-15', 'uid-dawit', 'firebaseUid', 'birthDate', 'accountStatus', 'discoverPaused',
      'Unreviewed edit', 'quarantine/', 'photo-pending', 'acceptedGenderCategories', 'minAge', 'locationScope']) {
      expect(body).not.toContain(secret);
    }
  });

  it('requires gender/interest choices to include each other in both directions', async () => {
    await woman('viewer');
    await man('mutual');
    await man('wants-men', { interestedIn: ['man'] });
    await seed('nonbinary', { gender: 'nonbinary', interestedIn: ['woman'] });
    await woman('another-woman', { interestedIn: ['woman'] });
    const { seen } = await drain(makeApp(), 'viewer');
    expect(seen).toEqual(['mutual']);
  });

  it('requires both age ranges to include the other', async () => {
    await woman('viewer', { minAge: 30, maxAge: 35 }); // viewer is 30
    await man('in-range', { birthDate: '1991-11-11' }); // 34, turns 35 tomorrow
    await man('too-old', { birthDate: '1990-11-10' }); // 36 today
    await man('too-young', { birthDate: '1997-01-01' }); // 29
    await man('wants-older', { minAge: 31 });
    await man('wants-younger', { maxAge: 29 });
    const { seen } = await drain(makeApp(), 'viewer');
    expect(seen).toEqual(['in-range']);
  });

  it('excludes inactive, incomplete, paused and preference-less candidates', async () => {
    await woman('viewer');
    await man('ok');
    await man('onboarding', { status: 'onboarding', ready: false });
    await man('suspended', { status: 'suspended' });
    await man('deleting', { status: 'deletion_pending' });
    await man('incomplete', { ready: false });
    await man('paused', { paused: true });
    await man('no-prefs', { withPreferences: false });
    const { seen } = await drain(makeApp(), 'viewer');
    expect(seen).toEqual(['ok']);
  });

  it('applies city/state/nationwide scope mutually', async () => {
    await woman('viewer', { scope: 'nationwide' });
    await man('same-state', { cityId: 'lakeview-xa' });
    await man('other-state-state-scope', { cityId: 'harbor-xb' });
    await man('other-state-nationwide', { cityId: 'harbor-xb', scope: 'nationwide' });
    await man('other-state-long-distance', { cityId: 'springfield-xb', longDistance: true });
    const { seen } = await drain(makeApp(), 'viewer');
    expect(seen.sort()).toEqual(['other-state-nationwide', 'same-state']);
  });

  it('keeps same-name cities in different states distinct and honours explicit metro membership', async () => {
    await woman('viewer', { cityId: 'springfield-xa', scope: 'city' });
    await man('springfield-other-state', { cityId: 'springfield-xb', scope: 'city' });
    await man('metro-same-state', { cityId: 'lakeview-xa', scope: 'city' });
    await man('metro-other-state', { cityId: 'harbor-xb', scope: 'city' });
    await man('same-state-no-metro', { cityId: 'riverton-xa', scope: 'state' });
    const { seen } = await drain(makeApp(), 'viewer');
    expect(seen.sort()).toEqual(['metro-other-state', 'metro-same-state']);
  });

  it('keeps non-US and stale city IDs out of the pool', async () => {
    await woman('viewer', { scope: 'nationwide' });
    await man('ok', { scope: 'nationwide' });
    await man('abroad', { cityId: 'abroad-city', scope: 'nationwide' });
    await man('stale-city', { cityId: 'retired-city-xa', stateCode: 'XA', scope: 'nationwide' });
    await man('wrong-state', { cityId: 'riverton-xa', stateCode: 'XB', scope: 'nationwide' });
    await man('non-us-country', { countryCode: 'ET', scope: 'nationwide' });
    const { seen } = await drain(makeApp(), 'viewer');
    expect(seen).toEqual(['ok']);
  });

  it('never lets hometown substitute for residence', async () => {
    await woman('viewer', { cityId: 'riverton-xa', scope: 'city' });
    // Lives in XB, grew up in the viewer's city
    await man('hometown-match', { cityId: 'harbor-xb', hometown: 'riverton-xa', scope: 'nationwide' });
    const res = await discover(makeApp(), 'viewer');
    expect(res.body.data.status).toBe('empty');
  });

  it('returns an explicit empty state without widening filters or creating a session', async () => {
    await woman('viewer', { maxAge: 31 });
    await man('just-outside', { birthDate: '1994-02-15' }); // 32
    await man('other-state', { cityId: 'harbor-xb', scope: 'nationwide' });
    const res = await discover(makeApp(), 'viewer');
    expect(res.status).toBe(200);
    expectContract(res, '/v1/discovery', 'get');
    expect(res.body.data).toEqual({ items: [], status: 'empty', preferencesRevision: 1 });
    expect(res.body.meta.nextCursor).toBeNull();
    expect(await db.collection('discoverySessions').countDocuments()).toBe(0);
  });
});

describe('GET /v1/discovery: pair exclusions', () => {
  it('hides any outgoing like, pending incoming likes (shown in Likes) and incoming likes the viewer declined', async () => {
    await woman('viewer');
    for (const n of ['liked-pending', 'liked-declined', 'liked-accepted', 'likes-me', 'declined-by-me', 'untouched']) await man(n);
    const like = (fromUserId: string, toUserId: string, state: string) => ({
      _id: `${fromUserId}->${toUserId}`, fromUserId, toUserId, state,
      target: { kind: 'photo', id: `${toUserId}-photo-0`, contentVersion: 1 },
      contextSnapshot: {}, idempotencyKey: `key-${fromUserId}-${toUserId}`,
      createdAt: new Date(), updatedAt: new Date(),
    });
    await db.collection('likes').insertMany([
      like('viewer', 'liked-pending', 'pending'),
      like('viewer', 'liked-declined', 'declined'),
      like('viewer', 'liked-accepted', 'accepted'),
      like('likes-me', 'viewer', 'pending'),
      like('declined-by-me', 'viewer', 'declined'),
    ]);
    const { seen } = await drain(makeApp(), 'viewer');
    expect(seen).toEqual(['untouched']);
  });

  it('hides blocks in either direction via the exclusion provider', async () => {
    await woman('viewer');
    await man('i-blocked', { interestedIn: ['woman'] });
    await man('blocked-me');
    await man('fine');
    blockedPairs.add(pairKey('viewer', 'i-blocked'));
    blockedPairs.add(pairKey('blocked-me', 'viewer'));
    const app = makeApp();
    expect((await drain(app, 'viewer')).seen).toEqual(['fine']);
    // And the other side never sees the viewer either
    expect((await drain(app, 'blocked-me')).seen).toEqual([]);
    expect((await drain(app, 'fine')).seen).toEqual(['viewer']);
    expect(blocks.excludedAmong).toHaveBeenCalledWith('viewer', expect.arrayContaining(['i-blocked', 'blocked-me']));
  });

  it('hides terminal pairs and report-triggered hides via the exclusion provider', async () => {
    await woman('viewer');
    await man('unmatched');
    await man('reported');
    await man('fine');
    terminalPairs.add(pairKey('viewer', 'unmatched'));
    reportHiddenPairs.add(pairKey('viewer', 'reported'));
    expect((await drain(makeApp(), 'viewer')).seen).toEqual(['fine']);
  });

  it('asks providers about bounded batches only', async () => {
    await woman('viewer');
    for (let i = 0; i < 7; i++) await man(`m${i}`);
    await drain(makeApp({ poolBatchSize: 3, pageSize: 2, maxScanPerPage: 4 }), 'viewer');
    for (const [, batch] of vi.mocked(blocks.excludedAmong).mock.calls) {
      expect(batch.length).toBeLessThanOrEqual(3);
    }
  });
});

describe('POST /v1/passes', () => {
  it('records a 30-day pass that hides the candidate from new sessions', async () => {
    await woman('viewer');
    await man('passed');
    await man('kept');
    const app = makeApp();
    const res = await pass(app, 'viewer', 'passed');
    expect(res.status).toBe(200);
    expectContract(res, '/v1/passes', 'post');
    expect(res.body.data).toEqual({
      candidateId: 'passed',
      passedAt: START.toISOString(),
      expiresAt: new Date(START.getTime() + 30 * DAY_MS).toISOString(),
    });
    expect((await drain(app, 'viewer')).seen).toEqual(['kept']);
  });

  it('is idempotent: retries and parallel requests keep one pass with the original expiry', async () => {
    await woman('viewer');
    await man('passed');
    const app = makeApp();
    const first = await pass(app, 'viewer', 'passed');
    clock.now = new Date(START.getTime() + DAY_MS);
    const results = await Promise.all(Array.from({ length: 5 }, () => pass(app, 'viewer', 'passed')));
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.body.data).toEqual(first.body.data);
    }
    expect(await db.collection('passes').countDocuments({ viewerId: 'viewer' })).toBe(1);
  });

  it('ignores expired passes that TTL has not deleted yet, and renews them on a new pass', async () => {
    await woman('viewer');
    await man('old-pass');
    await db.collection<PassDocument>('passes').insertOne({
      _id: 'p1', viewerId: 'viewer', candidateId: 'old-pass',
      passedAt: new Date(START.getTime() - 31 * DAY_MS), expiresAt: new Date(START.getTime() - 1000),
    });
    const app = makeApp();
    expect((await drain(app, 'viewer')).seen).toEqual(['old-pass']);

    const renewed = await pass(app, 'viewer', 'old-pass');
    expect(renewed.body.data.expiresAt).toBe(new Date(START.getTime() + 30 * DAY_MS).toISOString());
    expect(await db.collection('passes').countDocuments()).toBe(1);
    expect((await drain(app, 'viewer')).seen).toEqual([]);
  });

  it('uses the configured cooldown and lets the candidate return once it ends', async () => {
    await woman('viewer');
    await man('passed');
    const app = createApp({
      mongoCheck: async () => true,
      firebaseCheck: async () => true,
      routes: [createDiscoveryRoutes(db, auth,
        { NODE_ENV: 'test', DISCOVERY_CURSOR_SECRET: SECRET, PASS_COOLDOWN_DAYS: 7 },
        { now: () => clock.now, catalog, exclusions })],
    });
    const res = await pass(app, 'viewer', 'passed');
    expect(res.body.data.expiresAt).toBe(new Date(START.getTime() + 7 * DAY_MS).toISOString());
    clock.now = new Date(START.getTime() + 7 * DAY_MS - 1);
    expect((await drain(app, 'viewer')).seen).toEqual([]);
    clock.now = new Date(START.getTime() + 7 * DAY_MS);
    expect((await drain(app, 'viewer')).seen).toEqual(['passed']);
  });

  it('may pass any existing user without revealing their availability', async () => {
    await woman('viewer');
    await man('suspended', { status: 'suspended' });
    await man('blocked-me');
    blockedPairs.add(pairKey('viewer', 'blocked-me'));
    const app = makeApp();
    expect((await pass(app, 'viewer', 'suspended')).status).toBe(200);
    expect((await pass(app, 'viewer', 'blocked-me')).status).toBe(200);
  });

  it('rejects missing candidates, self passes and malformed bodies', async () => {
    await woman('viewer');
    const app = makeApp();
    const missing = await pass(app, 'viewer', 'no-such-user');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('PROFILE_UNAVAILABLE');
    expectContract(missing, '/v1/passes', 'post');

    const self = await pass(app, 'viewer', 'viewer');
    expect(self.status).toBe(422);
    expectContract(self, '/v1/passes', 'post');

    for (const body of [{}, { candidateId: '' }, { candidateId: 42 }, { candidateId: 'x'.repeat(129) },
      { candidateId: 'a', viewerId: 'someone-else' }]) {
      const res = await request(app).post('/v1/passes').set('Authorization', as('viewer')).send(body);
      expect(res.status).toBe(422);
      expectContract(res, '/v1/passes', 'post');
    }
    expect(await db.collection('passes').countDocuments()).toBe(0);
  });

  it('requires an eligible viewer', async () => {
    await woman('viewer', { status: 'onboarding', ready: false });
    await man('c');
    const res = await pass(makeApp(), 'viewer', 'c');
    expect(res.status).toBe(403);
    expectContract(res, '/v1/passes', 'post');
    expect((await request(makeApp()).post('/v1/passes').send({ candidateId: 'c' })).status).toBe(401);
  });
});

describe('Discovery sessions and cursors', () => {
  it('pages a stable shuffle without duplicates and ends with an explicit status', async () => {
    await woman('viewer');
    const everyone = [];
    for (let i = 0; i < 25; i++) everyone.push(await man(`m${String(i).padStart(2, '0')}`));
    const app = makeApp();

    const first = await discover(app, 'viewer');
    expectContract(first, '/v1/discovery', 'get');
    expect(first.body.data.items).toHaveLength(10);
    expect(first.body.data.status).toBe('more');
    const second = await discover(app, 'viewer', first.body.meta.nextCursor);
    expectContract(second, '/v1/discovery', 'get');
    expect(second.body.data.items).toHaveLength(10);
    const third = await discover(app, 'viewer', second.body.meta.nextCursor);
    expect(ids(third)).toHaveLength(5);
    expect(third.body.data.status).toBe('end');
    expect(third.body.meta.nextCursor).toBeNull();

    const seen = [...ids(first), ...ids(second), ...ids(third)];
    expect(new Set(seen).size).toBe(25);
    expect([...seen].sort()).toEqual(everyone);
    // Order follows the stored session exactly
    expect(seen).toEqual((await onlySession()).candidateIds);
    // Shuffled, not alphabetical or insertion order
    expect(seen).not.toEqual(everyone);
  });

  it('serves the same page again for the same cursor, and the same order for the same seed', async () => {
    await woman('viewer');
    for (let i = 0; i < 15; i++) await man(`m${i}`);
    const app = makeApp();
    const a = await discover(app, 'viewer');
    const page2 = await discover(app, 'viewer', a.body.meta.nextCursor);
    const again = await discover(app, 'viewer', a.body.meta.nextCursor);
    expect(ids(again)).toEqual(ids(page2));
    expect(again.body.meta.nextCursor).toBe(page2.body.meta.nextCursor);

    const b = await discover(app, 'viewer');
    expect(ids(b)).toEqual(ids(a));
    const otherSeed = await discover(makeApp({ newSeed: () => 7 }), 'viewer');
    expect(ids(otherSeed)).not.toEqual(ids(a));
  });

  it('bounds the session size', async () => {
    await woman('viewer');
    for (let i = 0; i < 8; i++) await man(`m${i}`);
    const { seen } = await drain(makeApp({ maxSessionSize: 5 }), 'viewer');
    expect(seen).toHaveLength(5);
    const session = await onlySession();
    expect(session.candidateIds).toHaveLength(5);
    expect(session).toMatchObject({ ownerId: 'viewer', preferencesRevision: 1, viewerCityId: 'riverton-xa', seed: 42 });
    expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBe(30 * 60 * 1000);
  });

  it('rechecks eligibility per page and tracks scanned offsets so nothing repeats or is skipped', async () => {
    await woman('viewer');
    for (let i = 0; i < 9; i++) await man(`m${i}`);
    const app = makeApp({ pageSize: 3, maxScanPerPage: 6 });

    const p1 = await discover(app, 'viewer');
    const order = (await onlySession()).candidateIds;
    expect(ids(p1)).toEqual(order.slice(0, 3));
    expect(decodeCursor(p1.body.meta.nextCursor, SECRET)).toMatchObject({ ok: true, payload: { nextOffset: 3 } });

    // Positions 3 and 5 drop out after the session was built
    expect((await pass(app, 'viewer', order[3])).status).toBe(200);
    await db.collection('users').updateOne({ _id: order[5] as never }, { $set: { discoverPaused: true } });

    const p2 = await discover(app, 'viewer', p1.body.meta.nextCursor);
    expect(ids(p2)).toEqual([order[4], order[6], order[7]]);
    // The cursor stops right after the last returned candidate: position 8 is still unscanned
    expect(decodeCursor(p2.body.meta.nextCursor, SECRET)).toMatchObject({ ok: true, payload: { nextOffset: 8 } });

    const p3 = await discover(app, 'viewer', p2.body.meta.nextCursor);
    expect(ids(p3)).toEqual([order[8]]);
    expect(p3.body.data.status).toBe('end');
  });

  it('returns a short page with a cursor when the scan budget runs out', async () => {
    await woman('viewer');
    for (let i = 0; i < 7; i++) await man(`m${i}`);
    const app = makeApp({ pageSize: 3, maxScanPerPage: 3 });
    const p1 = await discover(app, 'viewer');
    const order = (await onlySession()).candidateIds;
    await db.collection('users').updateMany({ _id: { $in: order.slice(3, 6) as never[] } }, { $set: { accountStatus: 'suspended' } });

    const p2 = await discover(app, 'viewer', p1.body.meta.nextCursor);
    expect(p2.body.data).toMatchObject({ items: [], status: 'more' });
    expect(decodeCursor(p2.body.meta.nextCursor, SECRET)).toMatchObject({ ok: true, payload: { nextOffset: 6 } });
    const p3 = await discover(app, 'viewer', p2.body.meta.nextCursor);
    expect(ids(p3)).toEqual([order[6]]);
  });

  it('skips candidates who disappeared, were blocked or liked after the session was built', async () => {
    await woman('viewer');
    for (let i = 0; i < 6; i++) await man(`m${i}`);
    const app = makeApp({ pageSize: 2, maxScanPerPage: 6 });
    const p1 = await discover(app, 'viewer');
    const order = (await onlySession()).candidateIds;
    await db.collection('users').deleteOne({ _id: order[2] as never });
    await db.collection('profiles').deleteOne({ userId: order[2] });
    blockedPairs.add(pairKey(order[3]!, 'viewer'));
    await db.collection('likes').insertOne({ _id: 'l1' as never, fromUserId: 'viewer', toUserId: order[4], state: 'pending', idempotencyKey: 'key-l1' });

    const p2 = await discover(app, 'viewer', p1.body.meta.nextCursor);
    expect(ids(p2)).toEqual([order[5]]);
    expect(p2.body.data.status).toBe('end');
  });

  it('expires cursors with the session, including after TTL removal', async () => {
    await woman('viewer');
    for (let i = 0; i < 12; i++) await man(`m${i}`);
    const app = makeApp();
    const p1 = await discover(app, 'viewer');
    const cursor = p1.body.meta.nextCursor as string;

    clock.now = new Date(START.getTime() + 30 * 60 * 1000);
    const expired = await discover(app, 'viewer', cursor);
    expect(expired.status).toBe(409);
    expect(expired.body.error).toMatchObject({ code: 'DISCOVERY_SESSION_EXPIRED', retryable: true });
    expectContract(expired, '/v1/discovery', 'get');

    clock.now = START;
    await db.collection('discoverySessions').deleteMany({});
    const removed = await discover(app, 'viewer', cursor);
    expect(removed.status).toBe(409);
    expect(removed.body.error.code).toBe('DISCOVERY_SESSION_EXPIRED');

    // Starting again works
    expect((await discover(app, 'viewer')).status).toBe(200);
  });

  it('checks the stored expiry even if a cursor claims a later one', async () => {
    await woman('viewer');
    for (let i = 0; i < 12; i++) await man(`m${i}`);
    const app = makeApp();
    await discover(app, 'viewer');
    const session = await onlySession();
    await db.collection('discoverySessions').updateOne({ _id: session._id as never }, { $set: { expiresAt: new Date(START.getTime() - 1) } });
    const cursor = encodeCursor({ sessionId: session._id, nextOffset: 10, expiresAt: START.getTime() + DAY_MS }, SECRET);
    const res = await discover(app, 'viewer', cursor);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DISCOVERY_SESSION_EXPIRED');
  });

  it('rejects tampered, forged and malformed cursors', async () => {
    await woman('viewer');
    for (let i = 0; i < 12; i++) await man(`m${i}`);
    const app = makeApp();
    const p1 = await discover(app, 'viewer');
    const cursor = p1.body.meta.nextCursor as string;
    const session = await onlySession();
    const [v, , sig] = cursor.split('.');
    const edited = Buffer.from(JSON.stringify({ s: session._id, o: 0, e: session.expiresAt.getTime() })).toString('base64url');

    for (const bad of [
      `${v}.${edited}.${sig}`,
      encodeCursor({ sessionId: session._id, nextOffset: 0, expiresAt: session.expiresAt.getTime() }, 'wrong-secret'.padEnd(40, 'q')),
      'not-a-cursor',
      // Correctly signed but beyond the end of the session
      encodeCursor({ sessionId: session._id, nextOffset: 13, expiresAt: session.expiresAt.getTime() }, SECRET),
    ]) {
      const res = await discover(app, 'viewer', bad);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_CURSOR');
      expectContract(res, '/v1/discovery', 'get');
    }

    const repeated = await request(app).get(`/v1/discovery?cursor=${cursor}&cursor=${cursor}`).set('Authorization', as('viewer'));
    expect(repeated.status).toBe(400);
  });

  it("refuses another person's cursor without revealing anything about it", async () => {
    await woman('viewer');
    await woman('other');
    for (let i = 0; i < 12; i++) await man(`m${i}`);
    const app = makeApp();
    const p1 = await discover(app, 'viewer');
    const res = await discover(app, 'other', p1.body.meta.nextCursor);
    const forged = await discover(app, 'other', 'not-a-cursor');
    expect(res.status).toBe(400);
    // Indistinguishable from a forged cursor: no data, same error
    expect(res.body).toEqual({ error: forged.body.error, requestId: expect.any(String) });
    expect(res.body.error.code).toBe('INVALID_CURSOR');
  });

  it('invalidates the session when preferences change', async () => {
    await woman('viewer');
    for (let i = 0; i < 12; i++) await man(`m${i}`);
    const app = makeApp();
    const p1 = await discover(app, 'viewer');
    await db.collection('preferences').updateOne({ userId: 'viewer' }, { $set: { maxAge: 33 }, $inc: { revision: 1 } });

    const res = await discover(app, 'viewer', p1.body.meta.nextCursor);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'DISCOVERY_SESSION_INVALIDATED', retryable: true });
    expectContract(res, '/v1/discovery', 'get');

    const fresh = await discover(app, 'viewer');
    expect(fresh.status).toBe(200);
    expect(fresh.body.data.preferencesRevision).toBe(2);
  });

  it('invalidates the session when the viewer moves city', async () => {
    await woman('viewer');
    for (let i = 0; i < 12; i++) await man(`m${i}`);
    const app = makeApp();
    const p1 = await discover(app, 'viewer');
    await db.collection('profiles').updateOne({ userId: 'viewer' }, { $set: { cityId: 'lakeview-xa' } });
    const res = await discover(app, 'viewer', p1.body.meta.nextCursor);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DISCOVERY_SESSION_INVALIDATED');
  });

  it('stops serving pages once the viewer pauses', async () => {
    await woman('viewer');
    for (let i = 0; i < 12; i++) await man(`m${i}`);
    const app = makeApp();
    const p1 = await discover(app, 'viewer');
    await db.collection('users').updateOne({ _id: 'viewer' as never }, { $set: { discoverPaused: true } });
    const res = await discover(app, 'viewer', p1.body.meta.nextCursor);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('DISCOVERY_PAUSED');
  });
});

describe('isDiscoverable', () => {
  it('applies the same rules as the feed', async () => {
    await woman('viewer');
    await man('ok');
    await man('far', { cityId: 'harbor-xb' });
    await man('liked-me');
    await db.collection('likes').insertOne({ _id: 'l' as never, fromUserId: 'liked-me', toUserId: 'viewer', state: 'pending', idempotencyKey: 'key-l' });
    const service = createDiscoveryService(db, { cursorSecret: SECRET, now: () => clock.now, catalog, exclusions });
    const viewer = (await db.collection<UserDocument>('users').findOne({ _id: 'viewer' }))!;
    expect(await service.isDiscoverable(viewer, 'ok')).toBe(true);
    expect(await service.isDiscoverable(viewer, 'far')).toBe(false);
    expect(await service.isDiscoverable(viewer, 'liked-me')).toBe(false);
    expect(await service.isDiscoverable(viewer, 'missing')).toBe(false);
    expect(await service.isDiscoverable(viewer, 'viewer')).toBe(false);
  });
});

describe('Discovery indexes and query plans', () => {
  const planOf = (explain: Record<string, unknown>) => JSON.stringify(explain['queryPlanner']);

  beforeEach(async () => {
    const now = new Date();
    const states = ['XA', 'XB'];
    const cities = ['riverton-xa', 'harbor-xb', 'lakeview-xa', 'springfield-xb'];
    await db.collection('profiles').insertMany(Array.from({ length: 400 }, (_, i) => ({
      ...createEmptyProfile(`load-${i}`),
      genderIdentity: ['man', 'woman', 'nonbinary'][i % 3],
      cityId: cities[i % 4],
      stateCode: states[i % 2],
      createdAt: now,
    })));
  });

  it.each([
    ['state', { stateCode: 'XA' }, 'genderIdentity_1_stateCode_1'],
    ['city', { cityId: 'riverton-xa' }, 'genderIdentity_1_cityId_1'],
    ['metro', { cityId: { $in: ['springfield-xa', 'lakeview-xa', 'harbor-xb'] } }, 'genderIdentity_1_cityId_1'],
  ])('uses an index for the %s candidate pre-filter', async (_label, scope, indexName) => {
    const explain = await db.collection('profiles')
      .find({ genderIdentity: { $in: ['man'] }, ...scope, countryCode: 'US', userId: { $ne: 'viewer' } }, { projection: { _id: 0, userId: 1 } })
      .explain('queryPlanner');
    const plan = planOf(explain);
    expect(plan).not.toContain('COLLSCAN');
    expect(plan).toContain(indexName);
  });

  it('uses an index for the nationwide pre-filter', async () => {
    const explain = await db.collection('profiles')
      .find({ genderIdentity: { $in: ['man', 'woman'] }, countryCode: 'US', userId: { $ne: 'viewer' } })
      .explain('queryPlanner');
    expect(planOf(explain)).not.toContain('COLLSCAN');
  });

  it('uses the unique pass index for per-page pass checks', async () => {
    const explain = await db.collection('passes')
      .find({ viewerId: 'viewer', candidateId: { $in: ['a', 'b'] }, expiresAt: { $gt: START } })
      .explain('queryPlanner');
    expect(planOf(explain)).toContain('viewerId_1_candidateId_1');
  });

  it('enforces one pass per viewer and candidate, with TTL cleanup for passes and sessions', async () => {
    const passIndexes = await db.collection('passes').indexes();
    expect(passIndexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: { viewerId: 1, candidateId: 1 }, unique: true }),
      expect.objectContaining({ key: { expiresAt: 1 }, expireAfterSeconds: 0 }),
    ]));
    const sessionIndexes = await db.collection('discoverySessions').indexes();
    expect(sessionIndexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: { expiresAt: 1 }, expireAfterSeconds: 0 }),
    ]));
    const doc = { viewerId: 'v', candidateId: 'c', passedAt: START, expiresAt: START };
    await db.collection('passes').insertOne({ _id: 'x1' as never, ...doc });
    await expect(db.collection('passes').insertOne({ _id: 'x2' as never, ...doc })).rejects.toMatchObject({ code: 11000 });
  });
});
