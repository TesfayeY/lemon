import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { MongoClient, type Collection, type Db, type Document } from 'mongodb';
import { ensureIndexes } from '../src/indexes.js';
import { migratePromptAnswers, PROMPT_ANSWER_ARCHIVE } from '../src/modules/profiles/prompt-answer-migration.js';
import { buildApp, createMultiUserAuth } from './support.js';

const T0 = Date.parse('2026-10-01T12:00:00Z');
const at = (minute: number) => new Date(T0 + minute * 60_000);
const NOTHING_TO_DO = { slotted: 0, archived: 0, published: 0, rejectedDropped: 0, deleted: 0 };
const REVIEW_FIELDS = ['pendingText', 'state', 'rejectionReason', 'text'];

/** Shape written before review-gated prompts and slots: one auto-approved text */
function legacyAnswer(ownerId: string, promptId: string, minute: number, state = 'approved') {
  return {
    _id: `${ownerId}-${promptId}`, ownerId, promptId, text: `Answer to ${promptId}`, state,
    publishedRevision: state === 'approved' ? 1 : 0, createdAt: at(minute), updatedAt: at(minute),
  };
}

/** Shape written while prompt answers waited for review (before D-13) */
function reviewedAnswer(ownerId: string, promptId: string, slot: number, fields: Document) {
  return {
    _id: `${ownerId}-${promptId}`, ownerId, promptId, slot, approvedText: null, pendingText: null, state: 'approved',
    revision: 1, publishedRevision: 0, createdAt: at(slot), updatedAt: at(slot), ...fields,
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
  const byId = (id: string) => answers.findOne({ _id: id as never });

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

    expect(await migratePromptAnswers(client, db)).toEqual({ ...NOTHING_TO_DO, slotted: 1 });
    const doc = await byId('u1-prompt-home');
    expect(doc).toEqual({
      _id: 'u1-prompt-home', ownerId: 'u1', promptId: 'prompt-home', slot: 0, approvedText: 'Answer to prompt-home',
      revision: 1, publishedRevision: 1, createdAt: at(0), updatedAt: at(0),
    });
  });

  it('publishes legacy text that was awaiting review and deletes legacy text that was rejected', async () => {
    await answers.insertMany([
      legacyAnswer('u1', 'prompt-home', 0, 'pending'),
      legacyAnswer('u1', 'prompt-song', 1, 'rejected'),
    ]);

    expect(await migratePromptAnswers(client, db)).toEqual({ ...NOTHING_TO_DO, slotted: 1, published: 1, deleted: 1 });
    expect(await byId('u1-prompt-home')).toMatchObject({ approvedText: 'Answer to prompt-home', publishedRevision: 1, slot: 0 });
    expect(await byId('u1-prompt-song')).toBeNull();
  });

  it('publishes submissions awaiting review: a first answer at version 1, an edit one version up', async () => {
    await answers.insertMany([
      reviewedAnswer('u1', 'prompt-home', 0, { pendingText: 'First answer', state: 'pending' }),
      reviewedAnswer('u1', 'prompt-song', 1, {
        approvedText: 'Old words', pendingText: 'New words', state: 'pending', revision: 3, publishedRevision: 2,
      }),
    ]);

    expect(await migratePromptAnswers(client, db)).toEqual({ ...NOTHING_TO_DO, published: 2 });
    expect(await byId('u1-prompt-home')).toEqual({
      _id: 'u1-prompt-home', ownerId: 'u1', promptId: 'prompt-home', slot: 0, approvedText: 'First answer',
      revision: 1, publishedRevision: 1, createdAt: at(0), updatedAt: at(0),
    });
    // The owner's edit revision is unchanged; the content version moves so likes on the old words show the change
    expect(await byId('u1-prompt-song')).toMatchObject({ approvedText: 'New words', revision: 3, publishedRevision: 2 + 1, slot: 1 });
  });

  it('keeps the content version when the pending text is the published text', async () => {
    await answers.insertOne(reviewedAnswer('u1', 'prompt-home', 0, {
      approvedText: 'Same words', pendingText: 'Same words', state: 'pending', revision: 2, publishedRevision: 1,
    }));

    await migratePromptAnswers(client, db);
    expect(await byId('u1-prompt-home')).toMatchObject({ approvedText: 'Same words', revision: 2, publishedRevision: 1 });
  });

  it('drops a rejected edit and keeps the earlier published text; deletes a rejected first answer', async () => {
    await answers.insertMany([
      reviewedAnswer('u1', 'prompt-home', 0, {
        approvedText: 'Published words', pendingText: 'Call me at 555-0100', state: 'rejected',
        rejectionReason: 'contact_details', revision: 2, publishedRevision: 1,
      }),
      reviewedAnswer('u1', 'prompt-song', 1, {
        pendingText: 'Follow my other account', state: 'rejected', rejectionReason: 'promotional',
      }),
    ]);

    expect(await migratePromptAnswers(client, db)).toEqual({ ...NOTHING_TO_DO, rejectedDropped: 1, deleted: 1 });
    expect(await byId('u1-prompt-home')).toEqual({
      _id: 'u1-prompt-home', ownerId: 'u1', promptId: 'prompt-home', slot: 0, approvedText: 'Published words',
      revision: 2, publishedRevision: 1, createdAt: at(0), updatedAt: at(0),
    });
    expect(await byId('u1-prompt-song')).toBeNull();

    // Rejected text is never published, archived or kept anywhere
    const everything = JSON.stringify([...await answers.find({}).toArray(), ...await archive.find({}).toArray()]);
    for (const rejected of ['555-0100', 'Follow my other account', 'contact_details', 'promotional']) {
      expect(everything).not.toContain(rejected);
    }
  });

  it('strips the review fields from approved answers and leaves current ones untouched', async () => {
    const current = {
      _id: 'u1-prompt-song', ownerId: 'u1', promptId: 'prompt-song', slot: 1, approvedText: 'Current',
      revision: 4, publishedRevision: 3, createdAt: at(1), updatedAt: at(1),
    };
    await answers.insertMany([
      reviewedAnswer('u1', 'prompt-home', 0, { approvedText: 'Approved', publishedRevision: 1, rejectionReason: null }),
      current,
    ]);

    expect(await migratePromptAnswers(client, db)).toEqual(NOTHING_TO_DO);
    const approved = await byId('u1-prompt-home');
    expect(approved).toMatchObject({ approvedText: 'Approved', publishedRevision: 1, slot: 0 });
    for (const field of REVIEW_FIELDS) expect(approved).not.toHaveProperty(field);
    expect(await byId('u1-prompt-song')).toEqual(current);
  });

  it('keeps slots already taken and fills the free ones oldest first', async () => {
    await answers.insertMany([
      { _id: 'current', ownerId: 'u1', promptId: 'prompt-home', slot: 1, approvedText: 'Home',
        revision: 1, publishedRevision: 1, createdAt: new Date(T0), updatedAt: new Date(T0) },
      legacyAnswer('u1', 'prompt-song', 5),
      legacyAnswer('u1', 'prompt-travel', 2),
    ]);

    await migratePromptAnswers(client, db);
    const slots = Object.fromEntries((await answers.find({ ownerId: 'u1' }).toArray()).map(a => [a._id, a.slot]));
    expect(slots).toEqual({ 'current': 1, 'u1-prompt-travel': 0, 'u1-prompt-song': 2 });
  });

  it('gives the slot of a deleted rejected answer to an answer that had none', async () => {
    await answers.insertMany([
      reviewedAnswer('u1', 'prompt-home', 0, { approvedText: 'Home', publishedRevision: 1 }),
      reviewedAnswer('u1', 'prompt-song', 1, { approvedText: 'Song', publishedRevision: 1 }),
      reviewedAnswer('u1', 'prompt-travel', 2, { pendingText: 'Rejected', state: 'rejected' }),
      legacyAnswer('u1', 'prompt-sunday', 3),
    ]);

    expect(await migratePromptAnswers(client, db)).toEqual({ ...NOTHING_TO_DO, slotted: 1, deleted: 1 });
    const kept = await answers.find({ ownerId: 'u1' }).sort({ slot: 1 }).toArray();
    expect(kept.map(a => [a.promptId, a.slot])).toEqual([['prompt-home', 0], ['prompt-song', 1], ['prompt-sunday', 2]]);
    expect(await archive.countDocuments()).toBe(0);
  });

  it('archives answers over the limit, keeping those already published, then oldest', async () => {
    await answers.insertMany([
      legacyAnswer('u1', 'prompt-home', 0, 'pending'),
      legacyAnswer('u1', 'prompt-song', 1),
      legacyAnswer('u1', 'prompt-travel', 2),
      legacyAnswer('u1', 'prompt-sunday', 3),
      legacyAnswer('u1', 'prompt-cooking', 4),
    ]);

    expect(await migratePromptAnswers(client, db)).toEqual({ ...NOTHING_TO_DO, slotted: 3, archived: 2, published: 1 });
    const kept = await answers.find({ ownerId: 'u1' }).sort({ slot: 1 }).toArray();
    expect(kept.map(a => [a.promptId, a.slot])).toEqual([['prompt-song', 0], ['prompt-travel', 1], ['prompt-sunday', 2]]);

    const archived = await archive.find({ ownerId: 'u1' }).sort({ createdAt: 1 }).toArray();
    expect(archived.map(a => a.promptId)).toEqual(['prompt-home', 'prompt-cooking']);
    for (const a of archived) {
      expect(a).toMatchObject({ archiveReason: 'over-limit', revision: 1 });
      expect(a['archivedAt']).toBeInstanceOf(Date);
      expect(a).not.toHaveProperty('slot');
      for (const field of REVIEW_FIELDS) expect(a).not.toHaveProperty(field);
    }
    expect(archived[0]).toMatchObject({ approvedText: 'Answer to prompt-home', publishedRevision: 1 });
  });

  it('changes nothing on a second run', async () => {
    await answers.insertMany([
      ...[0, 1, 2, 3].map(i => legacyAnswer('u1', `prompt-${i}`, i)),
      reviewedAnswer('u2', 'prompt-home', 0, { pendingText: 'Pending', state: 'pending' }),
      reviewedAnswer('u2', 'prompt-song', 1, { approvedText: 'Kept', pendingText: 'Rejected', state: 'rejected', publishedRevision: 1 }),
    ]);
    await migratePromptAnswers(client, db);
    const before = await answers.find({}).sort({ _id: 1 }).toArray();

    expect(await migratePromptAnswers(client, db)).toEqual(NOTHING_TO_DO);
    expect(await answers.find({}).sort({ _id: 1 }).toArray()).toEqual(before);
    expect(await archive.countDocuments()).toBe(1);
  });

  it('settles to the same result when several instances run it at once', async () => {
    const owners = Array.from({ length: 20 }, (_, i) => `u${i}`);
    await answers.insertMany(owners.flatMap(o => [
      ...[0, 1, 2, 3, 4].map(i => legacyAnswer(o, `prompt-${i}`, i)),
      reviewedAnswer(o, 'prompt-pending', 9, { pendingText: 'Pending', state: 'pending' }),
    ]));
    // Give the review-gated answer a slot that no legacy answer can take first
    await answers.updateMany({ promptId: 'prompt-pending' }, { $set: { slot: 2 } });

    const results = await Promise.all([1, 2, 3].map(() => migratePromptAnswers(client, db)));

    const sum = (key: keyof typeof NOTHING_TO_DO) => results.reduce((n, r) => n + r[key], 0);
    expect(sum('published')).toBe(20);
    expect(sum('slotted')).toBe(40);
    expect(sum('archived')).toBe(60);
    for (const o of owners) {
      const kept = await answers.find({ ownerId: o }).toArray();
      expect(kept.map(a => a.slot).sort()).toEqual([0, 1, 2]);
      expect(kept.find(a => a.promptId === 'prompt-pending')).toMatchObject({ approvedText: 'Pending', publishedRevision: 1 });
    }
    expect(await archive.countDocuments()).toBe(60);
    const archivedIds = (await archive.find({}).toArray()).map(a => a._id);
    expect(await answers.countDocuments({ _id: { $in: archivedIds } })).toBe(0);
  });

  it('drops the prompt review queue index left by older builds', async () => {
    await answers.createIndex({ state: 1, updatedAt: 1, _id: 1 });
    await migratePromptAnswers(client, db);
    expect((await answers.indexes()).map(i => i.name)).not.toContain('state_1_updatedAt_1__id_1');
    // Already gone: still fine
    await expect(migratePromptAnswers(client, db)).resolves.toEqual(NOTHING_TO_DO);
  });

  it('leaves migrated answers published and editable through the API', async () => {
    const app = buildApp(createMultiUserAuth(), db);
    const auth = { Authorization: 'Bearer token-legacy' };
    await request(app).post('/v1/me/bootstrap').set(auth);
    const user = await db.collection('users').findOne({ firebaseUid: 'uid-legacy' });
    const userId = user!._id as unknown as string;
    await answers.insertMany([
      legacyAnswer(userId, 'prompt-home', 0),
      reviewedAnswer(userId, 'prompt-song', 1, { pendingText: 'Waiting since before D-13', state: 'pending' }),
    ]);
    await migratePromptAnswers(client, db);

    const preview = await request(app).get('/v1/me/profile/preview').set(auth);
    expect(preview.body.data.promptAnswers.map((a: { text: string }) => a.text))
      .toEqual(['Answer to prompt-home', 'Waiting since before D-13']);

    const edit = await request(app).patch(`/v1/me/prompts/${userId}-prompt-home`).set(auth)
      .send({ expectedRevision: 1, text: 'Coffee ceremony' });
    expect(edit.status).toBe(200);
    expect(edit.body.data).toMatchObject({ text: 'Coffee ceremony', revision: 2, contentVersion: 2 });
  });
});
