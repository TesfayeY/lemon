import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { MongoClient, type Collection, type Db, type Document } from 'mongodb';
import { ensureIndexes } from '../src/indexes.js';
import { migratePromptAnswers, PROMPT_ANSWER_ARCHIVE } from '../src/modules/profiles/prompt-answer-migration.js';
import { buildApp, createMultiUserAuth } from './support.js';

const T0 = Date.parse('2026-10-01T12:00:00Z');

/** Shape written before review-gated prompts and slots: one auto-approved text */
function legacyAnswer(ownerId: string, promptId: string, minute: number, state = 'approved') {
  const at = new Date(T0 + minute * 60_000);
  return {
    _id: `${ownerId}-${promptId}`, ownerId, promptId, text: `Answer to ${promptId}`, state,
    publishedRevision: state === 'approved' ? 1 : 0, createdAt: at, updatedAt: at,
  };
}

// Mongo integration: real local replica set (transactions), isolated database per run
describe('prompt answer migration (MongoDB)', () => {
  const uri = process.env['MONGO_URI']!;
  const dbName = `lemon_test_prompt_migration_${process.pid}_${Date.now()}`;
  let client: MongoClient;
  let db: Db;
  let answers: Collection<Document>;
  let archive: Collection<Document>;

  beforeAll(async () => {
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
    try {
      await client.connect();
    } catch (err) {
      throw new Error(`Migration integration tests need MongoDB at ${uri} (run the local replica set)`, { cause: err });
    }
    db = client.db(dbName);
    await ensureIndexes(db);
    answers = db.collection('promptAnswers');
    archive = db.collection(PROMPT_ANSWER_ARCHIVE);
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await client?.close();
  });

  beforeEach(async () => {
    await answers.deleteMany({});
    await archive.deleteMany({});
  });

  it('builds the slot index over legacy answers and still rejects a taken slot', async () => {
    await answers.insertMany([legacyAnswer('u1', 'prompt-home', 0), legacyAnswer('u1', 'prompt-song', 1)]);
    await expect(ensureIndexes(db)).resolves.toBeUndefined();

    await answers.insertOne({ _id: 'n1', ownerId: 'u2', promptId: 'prompt-home', slot: 0 });
    await expect(answers.insertOne({ _id: 'n2', ownerId: 'u2', promptId: 'prompt-song', slot: 0 }))
      .rejects.toMatchObject({ code: 11000 });
  });

  it('converts approved legacy text to published text and gives it a slot', async () => {
    await answers.insertOne(legacyAnswer('u1', 'prompt-home', 0));

    expect(await migratePromptAnswers(client, db)).toEqual({ slotted: 1, archived: 0 });
    const doc = await answers.findOne({ _id: 'u1-prompt-home' as never });
    expect(doc).toMatchObject({
      approvedText: 'Answer to prompt-home', pendingText: null, state: 'approved',
      slot: 0, revision: 1, publishedRevision: 1,
    });
    expect(doc).not.toHaveProperty('text');
  });

  it('never publishes legacy text that was not approved', async () => {
    await answers.insertOne(legacyAnswer('u1', 'prompt-home', 0, 'pending'));

    await migratePromptAnswers(client, db);
    expect(await answers.findOne({ _id: 'u1-prompt-home' as never })).toMatchObject({
      approvedText: null, pendingText: 'Answer to prompt-home', state: 'pending', publishedRevision: 0,
    });
  });

  it('keeps slots already taken and fills the free ones oldest first', async () => {
    await answers.insertMany([
      { _id: 'current', ownerId: 'u1', promptId: 'prompt-home', slot: 1, approvedText: 'Home', pendingText: null,
        state: 'approved', revision: 1, publishedRevision: 1, createdAt: new Date(T0), updatedAt: new Date(T0) },
      legacyAnswer('u1', 'prompt-song', 5),
      legacyAnswer('u1', 'prompt-travel', 2),
    ]);

    await migratePromptAnswers(client, db);
    const slots = Object.fromEntries((await answers.find({ ownerId: 'u1' }).toArray()).map(a => [a._id, a.slot]));
    expect(slots).toEqual({ 'current': 1, 'u1-prompt-travel': 0, 'u1-prompt-song': 2 });
  });

  it('archives answers over the limit, keeping published then oldest', async () => {
    await answers.insertMany([
      legacyAnswer('u1', 'prompt-home', 0, 'pending'),
      legacyAnswer('u1', 'prompt-song', 1),
      legacyAnswer('u1', 'prompt-travel', 2),
      legacyAnswer('u1', 'prompt-sunday', 3),
      legacyAnswer('u1', 'prompt-cooking', 4),
    ]);

    expect(await migratePromptAnswers(client, db)).toEqual({ slotted: 3, archived: 2 });
    const kept = await answers.find({ ownerId: 'u1' }).sort({ slot: 1 }).toArray();
    expect(kept.map(a => [a.promptId, a.slot])).toEqual([['prompt-song', 0], ['prompt-travel', 1], ['prompt-sunday', 2]]);

    const archived = await archive.find({ ownerId: 'u1' }).sort({ createdAt: 1 }).toArray();
    expect(archived.map(a => a.promptId)).toEqual(['prompt-home', 'prompt-cooking']);
    for (const a of archived) {
      expect(a).toMatchObject({ archiveReason: 'over-limit', revision: 1 });
      expect(a['archivedAt']).toBeInstanceOf(Date);
      expect(a).not.toHaveProperty('slot');
      expect(a).not.toHaveProperty('text');
    }
    expect(archived[0]).toMatchObject({ approvedText: null, pendingText: 'Answer to prompt-home' });
  });

  it('changes nothing on a second run', async () => {
    await answers.insertMany([0, 1, 2, 3].map(i => legacyAnswer('u1', `prompt-${i}`, i)));
    await migratePromptAnswers(client, db);
    const before = await answers.find({}).sort({ _id: 1 }).toArray();

    expect(await migratePromptAnswers(client, db)).toEqual({ slotted: 0, archived: 0 });
    expect(await answers.find({}).sort({ _id: 1 }).toArray()).toEqual(before);
    expect(await archive.countDocuments()).toBe(1);
  });

  it('settles to the same result when several instances run it at once', async () => {
    const owners = Array.from({ length: 20 }, (_, i) => `u${i}`);
    await answers.insertMany(owners.flatMap(o => [0, 1, 2, 3, 4].map(i => legacyAnswer(o, `prompt-${i}`, i))));

    const results = await Promise.all([1, 2, 3].map(() => migratePromptAnswers(client, db)));

    expect(results.reduce((n, r) => n + r.slotted, 0)).toBe(60);
    expect(results.reduce((n, r) => n + r.archived, 0)).toBe(40);
    for (const o of owners) {
      const kept = await answers.find({ ownerId: o }).toArray();
      expect(kept.map(a => a.slot).sort()).toEqual([0, 1, 2]);
    }
    expect(await archive.countDocuments()).toBe(40);
    const archivedIds = (await archive.find({}).toArray()).map(a => a._id);
    expect(await answers.countDocuments({ _id: { $in: archivedIds } })).toBe(0);
  });

  it('leaves migrated answers editable and published through the API', async () => {
    const app = buildApp(createMultiUserAuth(), db);
    const auth = { Authorization: 'Bearer token-legacy' };
    await request(app).post('/v1/me/bootstrap').set(auth);
    const user = await db.collection('users').findOne({ firebaseUid: 'uid-legacy' });
    await answers.insertOne(legacyAnswer(user!._id as unknown as string, 'prompt-home', 0));
    await migratePromptAnswers(client, db);

    const preview = await request(app).get('/v1/me/profile/preview').set(auth);
    expect(preview.body.data.promptAnswers.map((a: { text: string }) => a.text)).toEqual(['Answer to prompt-home']);

    const answerId = `${user!._id}-prompt-home`;
    const edit = await request(app).patch(`/v1/me/prompts/${answerId}`).set(auth)
      .send({ expectedRevision: 1, text: 'Coffee ceremony' });
    expect(edit.status).toBe(200);
    expect(edit.body.data).toMatchObject({ state: 'pending', revision: 2 });
  });
});
