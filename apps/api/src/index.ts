import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { connectDb, checkMongo } from './db.js';
import { initFirebase, checkFirebase } from './firebase.js';

async function main() {
  const config = loadConfig();

  // Connect to dependencies
  const { db } = await connectDb(config);
  console.log(`Connected to MongoDB: ${config.MONGO_DB_NAME}`);

  initFirebase(config);
  console.log(`Firebase initialized: ${config.FIREBASE_PROJECT_ID}`);

  // Create and start the Express app
  const app = createApp({
    mongoCheck: checkMongo,
    firebaseCheck: checkFirebase,
  });

  app.listen(config.PORT, () => {
    console.log(`Lemon API listening on port ${config.PORT} [${config.NODE_ENV}]`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err.message);
  process.exit(1);
});
