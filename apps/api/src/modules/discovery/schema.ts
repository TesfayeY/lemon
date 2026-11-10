import type { Db } from 'mongodb';

export const PASSES_COLLECTION = 'passes';
export const DISCOVERY_SESSIONS_COLLECTION = 'discoverySessions';
/** Owned by the likes module; discovery only reads it. */
export const LIKES_COLLECTION = 'likes';

/**
 * A pass hides the candidate from the viewer until `expiresAt`.
 * TTL deletion is asynchronous, so every read also checks `expiresAt > now`.
 */
export interface PassDocument {
  _id: string;
  viewerId: string;
  candidateId: string;
  passedAt: Date;
  expiresAt: Date;
}

/**
 * A short-lived, bounded, ordered snapshot of eligible candidate IDs.
 * Eligibility is rechecked per page; the order never changes.
 */
export interface DiscoverySessionDocument {
  _id: string;
  ownerId: string;
  /** Viewer's preferences revision at creation; any change invalidates the session. */
  preferencesRevision: number;
  /** Viewer's residence city at creation; moving invalidates the session. */
  viewerCityId: string;
  seed: number;
  candidateIds: string[];
  createdAt: Date;
  expiresAt: Date;
}

/** Read-only view of the likes contract owned by the likes module. */
export interface LikeView {
  fromUserId: string;
  toUserId: string;
  state: 'pending' | 'declined' | 'accepted';
}

export async function ensureDiscoveryIndexes(db: Db): Promise<void> {
  await Promise.all([
    db.collection(PASSES_COLLECTION).createIndex({ viewerId: 1, candidateId: 1 }, { unique: true }),
    db.collection(PASSES_COLLECTION).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection(DISCOVERY_SESSIONS_COLLECTION).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    // Candidate pre-filters: gender plus the viewer's city, metro cities or state.
    // Nationwide uses the genderIdentity prefix of either.
    db.collection('profiles').createIndex({ genderIdentity: 1, cityId: 1 }),
    db.collection('profiles').createIndex({ genderIdentity: 1, stateCode: 1 }),
  ]);
}
