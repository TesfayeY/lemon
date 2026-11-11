/**
 * Public profile projection and contextual access (real MongoDB).
 *
 * - `GET /v1/profiles/:id` rechecks discovery eligibility, except for the
 *   viewer's own profile and senders of a pending like to the viewer.
 * - Everyone else gets the same 404 as a missing profile.
 * - Discover cards and profile reads come from the same projection.
 */
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
import { createDiscoveryRoutes } from '../src/modules/discovery/routes.js';
import { createDiscoveryService } from '../src/modules/discovery/service.js';
import type { PairExclusionProvider } from '../src/modules/discovery/exclusions.js';
import { createProfileRoutes } from '../src/modules/profiles/routes.js';
import { createEmptyProfile, type PromptAnswerDocument } from '../src/modules/profiles/schema.js';
import { createDefaultPreferences, type LocationScope } from '../src/modules/preferences/schema.js';
import type { AccountStatusType, UserDocument } from '../src/modules/auth/account.js';
import { createMultiUserAuth } from './support.js';

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

// --- Real local replica set, isolated database per run ---

const uri = process.env['MONGO_URI']!;
const dbName = `lemon_test_public_profile_${process.pid}_${Date.now()}`;
const SECRET = 'public-profile-test-secret-'.padEnd(48, 'z');
let client: MongoClient;
let db: Db;
const auth = createMultiUserAuth();

const pairKey = (a: string, b: string) => [a, b].sort().join('|');
const blockedPairs = new Set<string>();
const exclusions: PairExclusionProvider = {
  excludedAmong: vi.fn(async (viewerId: string, ids: readonly string[]) =>
    new Set(ids.filter((id) => blockedPairs.has(pairKey(viewerId, id))))),
};

function makeApp() {
  const service = createDiscoveryService(db, { cursorSecret: SECRET, exclusions, newSeed: () => 7 });
  return createApp({
    mongoCheck: async () => true,
    firebaseCheck: async () => true,
    routes: [
      createProfileRoutes(db, auth, { profileAccess: service }),
      createDiscoveryRoutes(db, auth, { NODE_ENV: 'test', DISCOVERY_CURSOR_SECRET: SECRET, PASS_COOLDOWN_DAYS: 30 }, {}, service),
    ],
  });
}

interface PersonSpec {
  gender?: string;
  interestedIn?: string[];
  birthDate?: string;
  cityId?: string;
  scope?: LocationScope;
  status?: AccountStatusType;
  ready?: boolean;
  paused?: boolean;
  genderSelfDescription?: string | null;
}

const CITY_STATE: Record<string, string> = { 'city-dallas-tx': 'TX', 'city-houston-tx': 'TX', 'city-seattle-wa': 'WA' };

async function seed(name: string, s: PersonSpec = {}): Promise<string> {
  const cityId = s.cityId ?? 'city-dallas-tx';
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
    agreements: { termsVersion: '1.0', acceptedAt: now },
    createdAt: now,
    updatedAt: now,
  };
  await db.collection<UserDocument>('users').insertOne(user);
  await db.collection('profiles').insertOne({
    ...createEmptyProfile(name),
    displayName: name,
    genderIdentity: s.gender ?? 'woman',
    genderSelfDescription: s.genderSelfDescription ?? null,
    cityId,
    stateCode: CITY_STATE[cityId],
    intention: 'serious',
  });
  await db.collection('preferences').insertOne({
    ...createDefaultPreferences(name),
    acceptedGenderCategories: s.interestedIn ?? ['man'],
    minAge: 25,
    maxAge: 40,
    locationScope: s.scope ?? 'state',
    longDistance: false,
  });
  const photoBase = { ownerId: name, width: 1080, height: 1350, moderationReason: null,
    variantKeys: { thumb: `public-variants/${name}/thumb`, display: `public-variants/${name}/display` },
    requestHash: 'hash', reviewedAt: now, deletedAt: null, objectsPurgedAt: null,
    createdAt: now, updatedAt: now };
  const photo = (suffix: string, order: number, state: string, contentVersion = 1, extra = {}) => ({
    ...photoBase, _id: `${name}-${suffix}`, order, state, contentVersion, idempotencyKey: `idem-${name}-${suffix}`,
    originalPrivateKey: `quarantine/${name}/${suffix}`, ...extra,
  });
  await db.collection('photos').insertMany([
    photo('photo-b', 1, 'approved', 3),
    photo('photo-a', 0, 'approved'),
    photo('photo-c', 2, 'approved'),
    photo('pending', 3, 'pending'),
    photo('rejected', 4, 'rejected', 1, { moderationReason: 'contact_details' }),
    photo('deleted', 5, 'deleted', 1, { deletedAt: now }),
  ]);
  await db.collection('promptAnswers').insertMany([0, 1, 2].map((slot) => ({
    _id: `${name}-answer-${slot}`, ownerId: name, promptId: ['prompt-tradition', 'prompt-sunday', 'prompt-home'][slot],
    slot, approvedText: `Answer ${slot}`, pendingText: slot === 0 ? 'Unreviewed edit' : null,
    state: slot === 0 ? 'pending' : 'approved', revision: 1, publishedRevision: slot + 1, createdAt: now, updatedAt: now,
  })));
  return name;
}

const woman = (name: string, s: PersonSpec = {}) => seed(name, s);
const man = (name: string, s: PersonSpec = {}) =>
  seed(name, { gender: 'man', interestedIn: ['woman'], birthDate: '1994-02-15', ...s });

const as = (name: string) => `Bearer token-${name}`;
const view = (app: ReturnType<typeof makeApp>, viewer: string, target: string) =>
  request(app).get(`/v1/profiles/${target}`).set('Authorization', as(viewer));
const pendingLike = (fromUserId: string, toUserId: string, state = 'pending') => ({
  _id: `${fromUserId}->${toUserId}` as never, fromUserId, toUserId, state,
  target: { kind: 'photo', id: `${toUserId}-photo-a`, contentVersion: 1 },
  contextSnapshot: {}, idempotencyKey: `key-${fromUserId}-${toUserId}`, createdAt: new Date(), updatedAt: new Date(),
});

beforeAll(async () => {
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(`Public profile integration tests need MongoDB at ${uri} (run the local replica set)`, { cause: err });
  }
  db = client.db(dbName);
  await ensureIndexes(db);
});

afterAll(async () => {
  await db?.dropDatabase();
  await client?.close();
});

beforeEach(async () => {
  blockedPairs.clear();
  vi.clearAllMocks();
  await Promise.all(
    ['users', 'profiles', 'preferences', 'photos', 'promptAnswers', 'passes', 'discoverySessions', 'likes']
      .map((c) => db.collection(c).deleteMany({})),
  );
});

describe('GET /v1/profiles/:id: public projection', () => {
  it('serves approved photos in order and published answers with their content version, nothing private', async () => {
    await woman('viewer');
    await man('dawit', { genderSelfDescription: 'In my own words' });
    const res = await view(makeApp(), 'viewer', 'dawit');
    expect(res.status).toBe(200);
    expectContract(res, '/v1/profiles/{id}', 'get');

    const profile = res.body.data;
    expect(profile.photos).toEqual([
      { id: 'dawit-photo-a', order: 0, width: 1080, height: 1350, contentVersion: 1,
        media: { thumb: '/v1/media/dawit-photo-a/thumb', display: '/v1/media/dawit-photo-a/display' } },
      expect.objectContaining({ id: 'dawit-photo-b', order: 1, contentVersion: 3 }),
      expect.objectContaining({ id: 'dawit-photo-c', order: 2 }),
    ]);
    // contentVersion is the publishedRevision the likes service validates against
    expect(profile.promptAnswers.map((a: { id: string; text: string; contentVersion: number }) => [a.id, a.text, a.contentVersion]))
      .toEqual([['dawit-answer-0', 'Answer 0', 1], ['dawit-answer-1', 'Answer 1', 2], ['dawit-answer-2', 'Answer 2', 3]]);

    const body = JSON.stringify(res.body);
    for (const secret of ['1994-02-15', 'uid-dawit', 'firebaseUid', 'birthDate', 'email', 'accountStatus', 'discoverPaused',
      'Unreviewed edit', 'pendingText', 'quarantine/', 'public-variants/', 'idem-', 'variantKeys', 'moderationReason',
      'contact_details', 'dawit-pending', 'dawit-rejected', 'dawit-deleted', 'In my own words', 'genderSelfDescription',
      'acceptedGenderCategories', 'minAge', 'locationScope', 'publishedRevision']) {
      expect(body).not.toContain(secret);
    }
  });

  it('is exactly the projection on the Discover card and in the owner preview', async () => {
    await woman('viewer');
    await man('dawit');
    const app = makeApp();
    const discover = await request(app).get('/v1/discovery').set('Authorization', as('viewer'));
    expect(discover.status).toBe(200);
    expectContract(discover, '/v1/discovery', 'get');
    const [card] = discover.body.data.items;
    const viewed = await view(app, 'viewer', 'dawit');
    expect(card).toEqual({ profile: viewed.body.data });

    const preview = await request(app).get('/v1/me/profile/preview').set('Authorization', as('dawit'));
    expectContract(preview, '/v1/me/profile/preview', 'get');
    expect(preview.body.data).toEqual(viewed.body.data);
  });

  it('bumps a prompt contentVersion only when a new revision is published', async () => {
    await woman('viewer');
    await man('dawit');
    const app = makeApp();
    const answers = db.collection<PromptAnswerDocument>('promptAnswers');
    const versionOf = async () => (await view(app, 'viewer', 'dawit')).body.data.promptAnswers[1];

    expect(await versionOf()).toMatchObject({ text: 'Answer 1', contentVersion: 2 });
    await answers.updateOne({ _id: 'dawit-answer-1' }, { $set: { pendingText: 'Newer', state: 'pending', revision: 2 } });
    expect(await versionOf()).toMatchObject({ text: 'Answer 1', contentVersion: 2 });
    // What prompt review does on approval
    await answers.updateOne({ _id: 'dawit-answer-1' },
      { $set: { approvedText: 'Newer', pendingText: null, state: 'approved' }, $inc: { publishedRevision: 1 } });
    expect(await versionOf()).toMatchObject({ text: 'Newer', contentVersion: 3 });
  });
});

describe('GET /v1/profiles/:id: contextual access', () => {
  it('answers 404 PROFILE_UNAVAILABLE, identical to a missing profile, for anyone not discoverable', async () => {
    await woman('viewer');
    await man('wants-men', { interestedIn: ['man'] });
    await man('other-state', { cityId: 'city-seattle-wa' });
    await man('too-old', { birthDate: '1970-01-01' });
    await man('paused', { paused: true });
    await man('suspended', { status: 'suspended' });
    await man('not-ready', { ready: false });
    await man('passed');
    await man('blocked');
    await man('i-liked');
    await woman('another-woman');
    blockedPairs.add(pairKey('viewer', 'blocked'));
    await db.collection('likes').insertOne(pendingLike('viewer', 'i-liked'));
    const app = makeApp();
    expect((await request(app).post('/v1/passes').set('Authorization', as('viewer')).send({ candidateId: 'passed' })).status).toBe(200);

    const missing = await view(app, 'viewer', 'nobody-by-this-id');
    expect(missing.status).toBe(404);
    expectContract(missing, '/v1/profiles/{id}', 'get');
    expect(missing.body.error).toEqual({ code: 'PROFILE_UNAVAILABLE', message: 'This profile is not available', retryable: false });

    for (const target of ['wants-men', 'other-state', 'too-old', 'paused', 'suspended', 'not-ready', 'passed', 'blocked',
      'i-liked', 'another-woman']) {
      const res = await view(app, 'viewer', target);
      expect({ target, status: res.status, error: res.body.error }).toEqual({ target, status: 404, error: missing.body.error });
      expectContract(res, '/v1/profiles/{id}', 'get');
    }
  });

  it('always shows viewers their own profile, even one Discover would never show them', async () => {
    await woman('viewer', { interestedIn: ['woman'], ready: false, status: 'onboarding' });
    const res = await view(makeApp(), 'viewer', 'viewer');
    expect(res.status).toBe(200);
    expectContract(res, '/v1/profiles/{id}', 'get');
    expect(res.body.data.userId).toBe('viewer');
    expect(res.body.data.photos).toHaveLength(3);
  });

  it('shows the sender of a pending like to the viewer, as the Likes list does', async () => {
    await woman('viewer');
    // Outside the viewer's location scope, so never discoverable
    await man('admirer', { cityId: 'city-seattle-wa', scope: 'nationwide' });
    await db.collection('likes').insertOne(pendingLike('admirer', 'viewer'));
    const app = makeApp();

    const res = await view(app, 'viewer', 'admirer');
    expect(res.status).toBe(200);
    expectContract(res, '/v1/profiles/{id}', 'get');
    expect(res.body.data.photos.map((p: { id: string }) => p.id)).toEqual(['admirer-photo-a', 'admirer-photo-b', 'admirer-photo-c']);

    // The like does not open the viewer's profile to the sender
    expect((await view(app, 'admirer', 'viewer')).status).toBe(404);
  });

  it('hides a pending liker who is paused, blocked or whose like was declined', async () => {
    await woman('viewer');
    await man('paused-admirer', { cityId: 'city-seattle-wa', paused: true });
    await man('blocked-admirer', { cityId: 'city-seattle-wa' });
    await man('declined-admirer', { cityId: 'city-seattle-wa' });
    blockedPairs.add(pairKey('blocked-admirer', 'viewer'));
    await db.collection('likes').insertMany([
      pendingLike('paused-admirer', 'viewer'),
      pendingLike('blocked-admirer', 'viewer'),
      pendingLike('declined-admirer', 'viewer'),
    ]);
    const app = makeApp();
    expect((await view(app, 'viewer', 'declined-admirer')).status).toBe(200);
    await db.collection('likes').updateOne({ _id: 'declined-admirer->viewer' as never }, { $set: { state: 'declined' } });

    for (const target of ['paused-admirer', 'blocked-admirer', 'declined-admirer']) {
      expect({ target, status: (await view(app, 'viewer', target)).status }).toEqual({ target, status: 404 });
    }
  });

  it('requires an active, ready viewer to see anyone else', async () => {
    await woman('viewer', { ready: false });
    await man('dawit');
    const res = await view(makeApp(), 'viewer', 'dawit');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_NOT_ELIGIBLE');
    expectContract(res, '/v1/profiles/{id}', 'get');
  });
});

describe('Gender self-description', () => {
  it('never affects who is discoverable', async () => {
    await woman('viewer');
    await man('with-words', { genderSelfDescription: 'Woman, in my words' });
    await man('without-words');
    const res = await request(makeApp()).get('/v1/discovery').set('Authorization', as('viewer'));
    const seen = (res.body.data.items as { profile: { userId: string } }[]).map((c) => c.profile.userId).sort();
    expect(seen).toEqual(['with-words', 'without-words']);
    expect(JSON.stringify(res.body)).not.toContain('in my words');
  });
});
