/**
 * Seed fictional development profiles into the local MongoDB.
 * Re-running replaces the same seed documents; other data is untouched.
 *
 * Usage: npm run seed   (or scripts/seed.sh)
 */

import { loadConfig } from '../config.js';
import { connectDb, closeDb } from '../db.js';
import { ensureIndexes } from '../indexes.js';
import { migratePromptAnswers } from '../modules/profiles/prompt-answer-migration.js';
import { recomputeReadiness } from '../modules/profiles/readiness-service.js';
import { buildSeedDocuments } from './seed-data.js';

async function main() {
  const config = loadConfig();
  if (config.NODE_ENV === 'production') {
    throw new Error('Refusing to seed fictional profiles in production');
  }

  const { client, db } = await connectDb(config);
  await ensureIndexes(db);
  await migratePromptAnswers(client, db);

  const docs = buildSeedDocuments();
  for (const [name, list] of Object.entries(docs) as [keyof typeof docs, { _id: string }[]][]) {
    const collection = db.collection<{ _id: string }>(name);
    for (const doc of list) {
      await collection.replaceOne({ _id: doc._id }, doc, { upsert: true });
    }
  }

  for (const user of docs.users) {
    await recomputeReadiness(db, user._id);
  }

  console.log(`Seeded ${docs.users.length} fictional profiles into ${config.MONGO_DB_NAME}`);
}

main()
  .catch((err) => {
    console.error('Seeding failed:', err.message);
    process.exitCode = 1;
  })
  .finally(closeDb);
