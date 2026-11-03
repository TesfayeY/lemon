import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { connectDb, checkMongo } from './db.js';
import { initFirebase, checkFirebase, getAuth } from './firebase.js';
import { ensureIndexes } from './indexes.js';
import { migratePromptAnswers } from './modules/profiles/prompt-answer-migration.js';
import { createAuthRoutes } from './modules/auth/routes.js';
import { createProfileRoutes } from './modules/profiles/routes.js';
import { createPreferencesRoutes } from './modules/preferences/routes.js';
import { createCatalogRoutes } from './modules/catalogs/routes.js';
import { createMediaRoutes } from './modules/media/routes.js';

async function main() {
  const config = loadConfig();

  // Connect to dependencies
  const { client, db } = await connectDb(config);
  console.log(`Connected to MongoDB: ${config.MONGO_DB_NAME}`);

  await ensureIndexes(db);
  const migrated = await migratePromptAnswers(client, db);
  if (migrated.slotted > 0 || migrated.archived > 0) {
    console.log(`Upgraded prompt answers: ${migrated.slotted} slotted, ${migrated.archived} archived over the limit`);
  }

  const firebaseApp = initFirebase(config);
  console.log(`Firebase initialized: ${config.FIREBASE_PROJECT_ID}`);
  const auth = getAuth(firebaseApp);

  // Create and start the Express app
  const app = createApp({
    mongoCheck: checkMongo,
    firebaseCheck: checkFirebase,
    routes: [
      createAuthRoutes(db, auth),
      createProfileRoutes(db, auth),
      createPreferencesRoutes(db, auth),
      createCatalogRoutes(),
      createMediaRoutes(db, auth, config),
    ],
  });

  app.listen(config.PORT, () => {
    console.log(`Lemon API listening on port ${config.PORT} [${config.NODE_ENV}]`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err.message);
  process.exit(1);
});
