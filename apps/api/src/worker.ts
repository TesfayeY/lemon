/**
 * Background worker entry point (D-06: one Express app plus one worker process).
 *
 *   npm run worker               # dev, via tsx; needs the same environment as the API
 *   npm run start:worker         # built: node dist/worker.js
 *   npm run worker -- --once     # run every job once and exit (non-zero if one failed)
 *
 * Runs each job on its own interval until SIGINT or SIGTERM, then lets running
 * jobs finish and closes MongoDB before exiting.
 */

import { ConfigError, loadConfig } from './config.js';
import { connectDb, closeDb } from './db.js';
import { LocalMediaStorage } from './adapters/media/local.js';
import { describeError } from './logging.js';
import { createMediaCleanupJob } from './workers/media-cleanup.js';
import { runJobsOnce, startWorker } from './workers/runner.js';

async function main() {
  const config = loadConfig();
  const { db } = await connectDb(config);
  console.log(`Connected to MongoDB: ${config.MONGO_DB_NAME}`);

  // The same storage the API writes to (media and admin routes); change both when P-04 lands
  const storage = new LocalMediaStorage(config.MEDIA_LOCAL_DIR);
  const jobs = [createMediaCleanupJob(db, storage)];

  if (process.argv.includes('--once')) {
    const ok = await runJobsOnce(jobs);
    await closeDb();
    process.exitCode = ok ? 0 : 1;
    return;
  }

  startWorker({ jobs, close: closeDb });
  console.log(`Lemon worker running: ${jobs.map((job) => `${job.name} every ${job.intervalMs / 1000}s`).join(', ')}`);
}

main().catch((err: unknown) => {
  console.error(`Worker failed to start: ${err instanceof ConfigError ? err.message : describeError(err)}`);
  process.exit(1);
});
