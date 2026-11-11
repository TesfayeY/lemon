import type { Db } from 'mongodb';
import { ensureDiscoveryIndexes } from './modules/discovery/schema.js';
import { ensureQuotaIndexes } from './modules/likes/quota.js';
import { ensureAdminIndexes } from './modules/admin/audit.js';

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
    // One answer per slot caps answers per owner atomically, even under concurrent inserts.
    // Partial, so answers saved before slots existed can't block the build;
    // migratePromptAnswers gives them slots at startup.
    db.collection('promptAnswers').createIndex(
      { ownerId: 1, slot: 1 },
      { unique: true, partialFilterExpression: { slot: { $exists: true } } },
    ),
    db.collection('photos').createIndex({ ownerId: 1, state: 1, order: 1 }),
    db.collection('photos').createIndex(
      { ownerId: 1, idempotencyKey: 1 },
      { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
    ),
    ensureDiscoveryIndexes(db),
    // Likes: one per direction ever in v1, sender-scoped idempotency, incoming list
    db.collection('likes').createIndex({ fromUserId: 1, toUserId: 1 }, { unique: true }),
    db.collection('likes').createIndex({ fromUserId: 1, idempotencyKey: 1 }, { unique: true }),
    db.collection('likes').createIndex({ toUserId: 1, state: 1, createdAt: -1 }),
    ensureQuotaIndexes(db),
    ensureAdminIndexes(db),
  ]);
}

export function isDuplicateKeyError(err: unknown): boolean {
  return (err as { code?: number }).code === 11000;
}
