import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import request from 'supertest';
import { parse } from 'yaml';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { PromptAnswerDocument } from '../src/modules/profiles/schema.js';
import type { UserDocument } from '../src/modules/auth/account.js';
import { buildApp, createInMemoryDb, createMultiUserAuth } from './support.js';

const contractsDir = fileURLToPath(new URL('../../../contracts/', import.meta.url));
const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
const specs = {
  openapi: parse(readFileSync(path.join(contractsDir, 'openapi.yaml'), 'utf8')),
  media: parse(readFileSync(path.join(contractsDir, 'openapi', 'media.yaml'), 'utf8')),
};
type SpecName = keyof typeof specs;
const spec = specs.openapi;

// OpenAPI 3.1 schemas are JSON Schema 2020-12; OpenAPI-only keywords are ignored
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
for (const [name, doc] of Object.entries(specs)) ajv.addSchema(doc, name);

const escapePointer = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');

function validatorFor(apiPath: string, method: string, status: number, specName: SpecName = 'openapi') {
  const response = specs[specName].paths[apiPath]?.[method]?.responses?.[String(status)];
  if (!response) throw new Error(`No contract for ${method.toUpperCase()} ${apiPath} ${status}`);
  const base = response.$ref
    ? (response.$ref as string).slice(1)
    : `/paths/${escapePointer(apiPath)}/${method}/responses/${status}`;
  const validate = ajv.getSchema(`${specName}#${base}/content/application~1json/schema`);
  if (!validate) throw new Error(`Unresolvable schema for ${method.toUpperCase()} ${apiPath} ${status}`);
  return validate;
}

function expectContract(body: unknown, apiPath: string, method: string, status: number, specName: SpecName = 'openapi') {
  const validate = validatorFor(apiPath, method, status, specName);
  validate(body);
  expect(validate.errors ?? [], `${method.toUpperCase()} ${apiPath} ${status}`).toEqual([]);
}

const readFixture = (file: string) => JSON.parse(readFileSync(path.join(contractsDir, 'fixtures', file), 'utf8'));

describe('Contract fixtures', () => {
  const fixtureContracts: Record<string, [string, string, number, SpecName?]> = {
    'account.json': ['/v1/me', 'get', 200],
    'self-profile.json': ['/v1/me/profile', 'get', 200],
    'public-profile.json': ['/v1/profiles/{id}', 'get', 200],
    'preferences.json': ['/v1/me/preferences', 'get', 200],
    'catalogs.json': ['/v1/catalogs', 'get', 200],
    'error-revision-conflict.json': ['/v1/me/profile', 'patch', 409],
    'error-validation.json': ['/v1/me/profile', 'patch', 422],
    'photos.json': ['/v1/me/photos', 'get', 200, 'media'],
    'photo-upload.json': ['/v1/me/photos', 'post', 201, 'media'],
  };

  it('maps every fixture file to a contract', () => {
    const files = readdirSync(path.join(contractsDir, 'fixtures')).filter(f => f.endsWith('.json'));
    expect(files.sort()).toEqual(Object.keys(fixtureContracts).sort());
  });

  it.each(Object.entries(fixtureContracts))('%s matches its schema', (file, [apiPath, method, status, specName]) => {
    expectContract(readFixture(file), apiPath, method, status, specName);
  });

  it('only references catalog IDs that the catalog fixture contains', () => {
    const catalogs = readFixture('catalogs.json').data;
    const ids = (list: { id: string }[]) => new Set(list.map(e => e.id));
    const self = readFixture('self-profile.json').data;
    const pub = readFixture('public-profile.json').data;
    for (const language of [...self.languages, ...pub.languages]) expect(ids(catalogs.languages)).toContain(language);
    for (const answer of [...self.promptAnswers, ...pub.promptAnswers]) expect(ids(catalogs.prompts)).toContain(answer.promptId);
    expect(ids(catalogs.cities)).toContain(self.cityId);
    expect(ids(catalogs.genderCategories)).toContain(self.genderIdentity);
    expect(ids(catalogs.intentions)).toContain(self.intention);
  });

  it('shows a public profile its approved photos only, in order', () => {
    const owned = readFixture('photos.json').data.photos as { id: string; state: string; order: number }[];
    const approved = owned.filter(p => p.state === 'approved').sort((a, b) => a.order - b.order).map(p => p.id);
    expect(readFixture('public-profile.json').data.photos.map((p: { id: string }) => p.id)).toEqual(approved);
  });

  it('rejects a public photo that leaks a storage key or review data', () => {
    for (const leak of [{ variantKeys: { thumb: 'public-variants/x/thumb' } }, { moderationReason: 'contact_details' }, { state: 'pending' }]) {
      const fixture = readFixture('public-profile.json');
      Object.assign(fixture.data.photos[0], leak);
      expect(validatorFor('/v1/profiles/{id}', 'get', 200)(fixture)).toBe(false);
    }
  });

  it('rejects a published answer without its content version', () => {
    const fixture = readFixture('public-profile.json');
    delete fixture.data.promptAnswers[0].contentVersion;
    expect(validatorFor('/v1/profiles/{id}', 'get', 200)(fixture)).toBe(false);
  });

  it('rejects a public profile that exposes the gender self-description', () => {
    const fixture = readFixture('public-profile.json');
    fixture.data.genderSelfDescription = 'In my own words';
    expect(validatorFor('/v1/profiles/{id}', 'get', 200)(fixture)).toBe(false);
  });
});

describe('Error codes', () => {
  /**
   * Codes a route sends: `code: 'X'`, `new SomeError(404, 'X'`, `sendError(req, res, 404, 'X'`.
   * At least four characters, so catalog entries like `{ code: 'TX' }` (US states) don't count.
   */
  const SENT = [
    /\bcode:\s*'([A-Z][A-Z0-9_]{3,})'/g,
    /Error\(\s*\d{3},\s*'([A-Z][A-Z0-9_]{3,})'/g,
    /sendError\(\s*req,\s*res,\s*\d{3},\s*'([A-Z][A-Z0-9_]{3,})'/g,
  ];
  // Thrown by the review service to its script caller (scripts/review-photos.ts), never over HTTP
  const INTERNAL_ONLY = new Set(['INVALID_INPUT']);

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return sourceFiles(full);
      return e.name.endsWith('.ts') ? [full] : [];
    });
  }

  it('documents every error code the API sends in ErrorCode', () => {
    const sent = new Set<string>();
    for (const file of sourceFiles(srcDir)) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of SENT) for (const m of text.matchAll(pattern)) sent.add(m[1]!);
    }
    for (const code of INTERNAL_ONLY) sent.delete(code);
    expect(sent.size).toBeGreaterThan(20);
    const documented = new Set<string>(spec.components.schemas.ErrorCode.enum);
    expect([...sent].filter(c => !documented.has(c)).sort()).toEqual([]);
  });

  it('includes the codes the onboarding client found missing', () => {
    expect(spec.components.schemas.ErrorCode.enum).toEqual(expect.arrayContaining([
      'AGE_INELIGIBLE', 'PROMPT_LIMIT', 'CONCURRENT_EDIT', 'INVALID_STATE', 'NO_UPDATES',
      'ACCOUNT_RESTRICTED', 'ACCOUNT_NOT_ELIGIBLE', 'PROFILE_UNAVAILABLE',
    ]));
  });

  it('rejects an error response with an undocumented code', () => {
    const body = { error: { code: 'SOMETHING_NEW', message: 'x', retryable: false }, requestId: 'r' };
    expect(validatorFor('/v1/me/profile', 'get', 404)(body)).toBe(false);
  });
});

describe('Contract fixtures (leak guards)', () => {

  it('rejects a public profile that leaks a private field', () => {
    const fixture = JSON.parse(readFileSync(path.join(contractsDir, 'fixtures', 'public-profile.json'), 'utf8'));
    fixture.data.birthDate = '1995-03-10';
    const validate = validatorFor('/v1/profiles/{id}', 'get', 200);
    expect(validate(fixture)).toBe(false);
  });

  it('rejects a published answer that exposes pending text (nested $ref)', () => {
    const fixture = JSON.parse(readFileSync(path.join(contractsDir, 'fixtures', 'public-profile.json'), 'utf8'));
    fixture.data.promptAnswers[0].pendingText = 'Not reviewed yet';
    const validate = validatorFor('/v1/profiles/{id}', 'get', 200);
    expect(validate(fixture)).toBe(false);
    expect(validate.errors?.[0]?.instancePath).toBe('/data/promptAnswers/0');
  });
});

describe('Live responses match the contract', () => {
  it('covers every Phase 03-04 endpoint, including error paths', async () => {
    const db = createInMemoryDb();
    const app = buildApp(createMultiUserAuth(), db);
    const as = (name: string) => `Bearer token-${name}`;
    const check = (res: request.Response, apiPath: string, method: string) =>
      expectContract(res.body, apiPath, method, res.status);

    check(await request(app).get('/v1/me'), '/v1/me', 'get'); // 401
    let res = await request(app).get('/v1/me').set('Authorization', as('alice'));
    expect(res.status).toBe(404); // before bootstrap
    check(res, '/v1/me', 'get');

    res = await request(app).post('/v1/me/bootstrap').set('Authorization', as('alice'));
    expect(res.status).toBe(201);
    check(res, '/v1/me/bootstrap', 'post');
    res = await request(app).post('/v1/me/bootstrap').set('Authorization', as('alice'));
    expect(res.status).toBe(200);
    check(res, '/v1/me/bootstrap', 'post');
    await request(app).post('/v1/me/bootstrap').set('Authorization', as('bob'));

    check(await request(app).get('/v1/me').set('Authorization', as('alice')), '/v1/me', 'get');

    for (const body of [{ birthDate: '1995-03-10', termsAccepted: true }, { birthDate: '2015-01-01' }, {}]) {
      res = await request(app).patch('/v1/me/onboarding').set('Authorization', as('alice')).send(body);
      check(res, '/v1/me/onboarding', 'patch');
    }
    await request(app).patch('/v1/me/onboarding').set('Authorization', as('bob'))
      .send({ birthDate: '1992-11-02', termsAccepted: true });
    check(await request(app).get('/v1/me').set('Authorization', as('alice')), '/v1/me', 'get');

    check(await request(app).get('/v1/catalogs'), '/v1/catalogs', 'get');

    // Profile: empty draft, full edit, stale edit, invalid edit, no-op edit
    check(await request(app).get('/v1/me/profile').set('Authorization', as('alice')), '/v1/me/profile', 'get');
    check(await request(app).get('/v1/me/profile/preview').set('Authorization', as('alice')), '/v1/me/profile/preview', 'get');
    const fullEdit = {
      displayName: 'ሰላም Selam', genderIdentity: 'woman', genderSelfDescription: 'femme', cityId: 'city-dallas-tx', intention: 'serious',
      bio: 'Coffee first', hometown: 'Asmara', occupation: 'Pharmacist', occupationDisplay: 'public',
      height: 165, languages: ['tigrinya', 'english'], religion: null,
    };
    for (const body of [{ expectedRevision: 1, ...fullEdit }, { expectedRevision: 1, bio: 'stale' },
      { expectedRevision: 2, displayName: 'x'.repeat(41) }, { expectedRevision: 2 }]) {
      res = await request(app).patch('/v1/me/profile').set('Authorization', as('alice')).send(body);
      check(res, '/v1/me/profile', 'patch');
    }
    await request(app).patch('/v1/me/profile').set('Authorization', as('bob')).send({ expectedRevision: 1, ...fullEdit, displayName: 'Dawit', genderIdentity: 'man' });

    // Prompt answers: create, duplicate, invalid, edit, stale edit, delete, missing
    res = await request(app).post('/v1/me/prompts').set('Authorization', as('alice')).send({ promptId: 'prompt-tradition', text: 'Buna' });
    check(res, '/v1/me/prompts', 'post');
    const answerId = res.body.data.id as string;
    for (const body of [{ promptId: 'prompt-tradition', text: 'Again' }, { promptId: 'prompt-fake', text: '' }]) {
      check(await request(app).post('/v1/me/prompts').set('Authorization', as('alice')).send(body), '/v1/me/prompts', 'post');
    }
    for (const body of [{ expectedRevision: 1, text: 'Buna, three rounds' }, { expectedRevision: 1, text: 'stale' }]) {
      res = await request(app).patch(`/v1/me/prompts/${answerId}`).set('Authorization', as('alice')).send(body);
      check(res, '/v1/me/prompts/{id}', 'patch');
    }
    check(await request(app).get('/v1/me/profile').set('Authorization', as('alice')), '/v1/me/profile', 'get');
    check(await request(app).delete(`/v1/me/prompts/${answerId}`).set('Authorization', as('alice')), '/v1/me/prompts/{id}', 'delete');
    check(await request(app).delete(`/v1/me/prompts/${answerId}`).set('Authorization', as('alice')), '/v1/me/prompts/{id}', 'delete');

    // Preferences: defaults, edit, stale, invalid
    check(await request(app).get('/v1/me/preferences').set('Authorization', as('alice')), '/v1/me/preferences', 'get');
    for (const body of [{ expectedRevision: 1, acceptedGenderCategories: ['man'], minAge: 27, maxAge: 38 },
      { expectedRevision: 1, longDistance: true }, { expectedRevision: 2, maxAge: 120 }]) {
      res = await request(app).patch('/v1/me/preferences').set('Authorization', as('alice')).send(body);
      check(res, '/v1/me/preferences', 'patch');
    }

    // Public profile: ineligible viewer, then an eligible viewer of a published profile
    const users = db.collection<UserDocument>('users');
    const alice = (await users.findOne({ firebaseUid: 'uid-alice' }))!;
    const bob = (await users.findOne({ firebaseUid: 'uid-bob' }))!;
    check(await request(app).get(`/v1/profiles/${bob._id}`).set('Authorization', as('alice')), '/v1/profiles/{id}', 'get');

    res = await request(app).post('/v1/me/prompts').set('Authorization', as('bob')).send({ promptId: 'prompt-home', text: 'Addis' });
    await db.collection<PromptAnswerDocument>('promptAnswers').updateOne({ _id: res.body.data.id }, {
      $set: { approvedText: 'Addis', pendingText: null, state: 'approved', publishedRevision: 1 },
    });
    const photoDoc = (id: string, order: number, state: string) => ({
      _id: id, ownerId: bob._id, state, order, width: 1080, height: 1350, contentVersion: 1, moderationReason: null,
      originalPrivateKey: `quarantine/${bob._id}/${id}`, variantKeys: { thumb: 't', display: 'd' }, requestHash: 'h',
      reviewedAt: null, deletedAt: null, objectsPurgedAt: null, createdAt: new Date(), updatedAt: new Date(),
    });
    for (const p of [photoDoc('bob-2', 1, 'approved'), photoDoc('bob-1', 0, 'approved'), photoDoc('bob-pending', 2, 'pending')]) {
      await db.collection('photos').insertOne(p as never);
    }
    for (const u of [alice, bob]) {
      await users.updateOne({ _id: u._id }, { $set: { accountStatus: 'active', profileReady: true } });
    }
    res = await request(app).get(`/v1/profiles/${bob._id}`).set('Authorization', as('alice'));
    expect(res.status).toBe(200);
    expect(res.body.data.promptAnswers).toEqual([expect.objectContaining({ text: 'Addis', contentVersion: 1 })]);
    expect(res.body.data.photos.map((p: { id: string }) => p.id)).toEqual(['bob-1', 'bob-2']);
    check(res, '/v1/profiles/{id}', 'get');
    check(await request(app).get('/v1/me/profile/preview').set('Authorization', as('bob')), '/v1/me/profile/preview', 'get');
    check(await request(app).get(`/v1/profiles/${alice._id}`).set('Authorization', as('alice')), '/v1/profiles/{id}', 'get');
    check(await request(app).get('/v1/profiles/no-such-user').set('Authorization', as('alice')), '/v1/profiles/{id}', 'get');
  });
});
