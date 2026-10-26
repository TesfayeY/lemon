import type { Db } from 'mongodb';

/**
 * Unique indexes that enforce one-per-owner invariants.
 * Route handlers rely on these duplicate-key errors (code 11000) to resolve
 * concurrent first-time inserts, so they must exist before serving traffic.
 */
export async function ensureIndexes(db: Db): Promise<void> {
  await Promise.all([
    db.collection('users').createIndex({ firebaseUid: 1 }, { unique: true }),
    db.collection('profiles').createIndex({ userId: 1 }, { unique: true }),
    db.collection('preferences').createIndex({ userId: 1 }, { unique: true }),
    db.collection('promptAnswers').createIndex({ ownerId: 1, promptId: 1 }, { unique: true }),
  ]);
}

export function isDuplicateKeyError(err: unknown): boolean {
  return (err as { code?: number }).code === 11000;
}
