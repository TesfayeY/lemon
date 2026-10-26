import type { Db } from 'mongodb';
import type { MediaStorage } from '../../adapters/media/storage.js';
import { isDuplicateKeyError } from '../../indexes.js';
import { allObjectKeys, PhotoState, type PhotoDocument, type PhotoSetDocument } from './schema.js';

/** Fetch the owner's photo set, creating it at revision 1 on first access. */
export async function findOrCreatePhotoSet(db: Db, ownerId: string): Promise<PhotoSetDocument> {
  const photoSets = db.collection<PhotoSetDocument>('photoSets');
  const existing = await photoSets.findOne({ _id: ownerId });
  if (existing) return existing;

  const now = new Date();
  const created: PhotoSetDocument = { _id: ownerId, ownerId, revision: 1, createdAt: now, updatedAt: now };
  try {
    await photoSets.insertOne(created);
    return created;
  } catch (err: unknown) {
    // Concurrent first access created it — use the stored set
    if (!isDuplicateKeyError(err)) throw err;
    return (await photoSets.findOne({ _id: ownerId }))!;
  }
}

/** Server-side membership change (delete, reject, failed upload): invalidate client orderings. */
export async function bumpPhotoSetRevision(db: Db, ownerId: string): Promise<number> {
  const photoSets = db.collection<PhotoSetDocument>('photoSets');
  await photoSets.updateOne({ _id: ownerId }, { $inc: { revision: 1 }, $set: { updatedAt: new Date() } });
  return (await findOrCreatePhotoSet(db, ownerId)).revision;
}

/**
 * Delete a removed or failed photo's objects, then record it.
 * Never throws: on storage errors it returns false and the cleanup worker retries.
 */
export async function purgePhotoObjects(db: Db, storage: MediaStorage, photo: PhotoDocument): Promise<boolean> {
  const photos = db.collection<PhotoDocument>('photos');
  try {
    for (const key of allObjectKeys(photo)) {
      await storage.deleteObject(key);
    }
  } catch (err) {
    console.error(`Media cleanup failed for photo ${photo._id}: ${(err as Error).message}`);
    return false;
  }

  if (photo.state === PhotoState.FAILED) {
    // A failed upload was never visible to anyone; nothing to keep
    await photos.deleteOne({ _id: photo._id, state: PhotoState.FAILED });
  } else {
    // Keep the deleted tombstone (like context, stale-retry protection) without objects
    await photos.updateOne({ _id: photo._id }, { $set: { objectsPurgedAt: new Date() } });
  }
  return true;
}
