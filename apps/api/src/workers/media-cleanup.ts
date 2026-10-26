/**
 * Retryable orphan cleanup for media objects.
 *
 * Each run:
 * 1. Expires uploads stuck in `processing` (process crashed mid-upload) to `failed`
 *    and frees their slot and Idempotency-Key.
 * 2. Deletes the objects of `failed` and `deleted` photos that still have them.
 *    Failed photos are then removed; deleted photos keep a tombstone.
 *
 * Every step is idempotent, so a crash or storage outage only delays cleanup to
 * the next run. Run directly with `tsx src/workers/media-cleanup.ts [--once]`.
 *
 * TODO: start this from the shared worker entry point (D-06) once it exists.
 */

import { fileURLToPath } from 'node:url';
import type { Db } from 'mongodb';
import type { MediaStorage } from '../adapters/media/storage.js';
import { bumpPhotoSetRevision, purgePhotoObjects } from '../modules/media/photo-set.js';
import { PhotoState, type PhotoDocument } from '../modules/media/schema.js';

export interface MediaCleanupOptions {
  now?: Date;
  /** Uploads still processing after this long are treated as abandoned. */
  processingTimeoutMs?: number;
  batchSize?: number;
}

export interface MediaCleanupResult {
  expired: number;
  purged: number;
  retryLater: number;
}

const DEFAULT_PROCESSING_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 100;

export async function runMediaCleanup(
  db: Db,
  storage: MediaStorage,
  options: MediaCleanupOptions = {},
): Promise<MediaCleanupResult> {
  const now = options.now ?? new Date();
  const timeoutMs = options.processingTimeoutMs ?? DEFAULT_PROCESSING_TIMEOUT_MS;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const photos = db.collection<PhotoDocument>('photos');
  const result: MediaCleanupResult = { expired: 0, purged: 0, retryLater: 0 };

  const stale = await photos
    .find({ state: PhotoState.PROCESSING, createdAt: { $lt: new Date(now.getTime() - timeoutMs) } })
    .limit(batchSize)
    .toArray();
  for (const photo of stale) {
    const expired = await photos.updateOne(
      { _id: photo._id, state: PhotoState.PROCESSING },
      { $set: { state: PhotoState.FAILED, updatedAt: now }, $unset: { idempotencyKey: '' } },
    );
    if (expired.matchedCount === 1) {
      await bumpPhotoSetRevision(db, photo.ownerId);
      result.expired++;
    }
  }

  const removable = await photos
    .find({ state: { $in: [PhotoState.FAILED, PhotoState.DELETED] }, objectsPurgedAt: null })
    .limit(batchSize)
    .toArray();
  for (const photo of removable) {
    if (await purgePhotoObjects(db, storage, photo)) result.purged++;
    else result.retryLater++;
  }

  return result;
}

async function main() {
  const { loadConfig } = await import('../config.js');
  const { connectDb, closeDb } = await import('../db.js');
  const { LocalMediaStorage } = await import('../adapters/media/local.js');

  const config = loadConfig();
  const { db } = await connectDb(config);
  const storage = new LocalMediaStorage(config.MEDIA_LOCAL_DIR);
  const once = process.argv.includes('--once');
  const intervalMs = 60_000;

  const tick = async () => {
    const result = await runMediaCleanup(db, storage);
    console.log(`Media cleanup: ${JSON.stringify(result)}`);
  };

  await tick();
  if (once) {
    await closeDb();
    return;
  }
  const timer = setInterval(() => {
    tick().catch((err: Error) => console.error(`Media cleanup run failed: ${err.message}`));
  }, intervalMs);
  process.on('SIGINT', () => {
    clearInterval(timer);
    closeDb().finally(() => process.exit(0));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: Error) => {
    console.error('Media cleanup worker failed:', err.message);
    process.exit(1);
  });
}
