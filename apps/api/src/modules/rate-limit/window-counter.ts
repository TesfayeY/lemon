/**
 * Per-account limits that must hold across API processes (photo uploads, new
 * Discover sessions), counted in MongoDB. Same pattern as the like quota
 * (likes/quota.ts); no Redis or other new infrastructure.
 *
 * - One document per (action, account, window). Consumption is an `_id`-only
 *   upsert, then an increment conditioned on `count < limit`, so concurrent
 *   requests on any number of processes can never exceed the limit.
 * - Windows are fixed and aligned to the epoch: an hourly window starts on the
 *   UTC hour. A burst straddling a boundary can reach twice the limit in a
 *   short span, which is acceptable for an abuse limit.
 * - A TTL index removes each document one window after its window ends, so the
 *   monitor never races a request still counting in that window.
 */

import type { Collection, Db } from 'mongodb';

export const RATE_LIMITS_COLLECTION = 'rateLimits';
export const HOUR_MS = 60 * 60 * 1000;

export type RateLimitAction = 'photo_upload' | 'discovery_session';

export interface WindowPolicy {
  action: RateLimitAction;
  /** Attempts allowed per window */
  limit: number;
  windowMs: number;
}

export interface RateLimitDocument {
  _id: string; // `${action}:${accountId}:${windowStart ISO}`
  action: RateLimitAction;
  accountId: string;
  windowStart: Date;
  count: number;
  createdAt: Date;
  updatedAt: Date;
  /** TTL field: one window after the window ends */
  expiresAt: Date;
}

export type RateLimitDecision =
  | { ok: true; limit: number; remaining: number; resetAt: Date }
  | { ok: false; limit: number; resetAt: Date; retryAfterSeconds: number };

/** Start of the fixed window containing `now` */
export function windowStartOf(now: Date, windowMs: number): Date {
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}

/** Whole seconds from `now` until `until`, at least 1 (the Retry-After value) */
export function secondsUntil(until: Date, now: Date): number {
  return Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000));
}

function assertValidPolicy(policy: WindowPolicy): void {
  if (!Number.isInteger(policy.limit) || policy.limit < 1) {
    throw new Error(`Invalid rate limit for ${policy.action}: limit=${policy.limit}`);
  }
  if (!Number.isInteger(policy.windowMs) || policy.windowMs < 1000) {
    throw new Error(`Invalid rate limit for ${policy.action}: windowMs=${policy.windowMs}`);
  }
}

/** Atomically count one attempt in the current window, unless the limit is reached. */
export async function consumeRateLimit(
  collection: Collection<RateLimitDocument>,
  accountId: string,
  policy: WindowPolicy,
  now: Date,
): Promise<RateLimitDecision> {
  assertValidPolicy(policy);
  const { action, limit, windowMs } = policy;
  const windowStart = windowStartOf(now, windowMs);
  const resetAt = new Date(windowStart.getTime() + windowMs);
  const _id = `${action}:${accountId}:${windowStart.toISOString()}`;

  // Equality-on-_id upserts are retried by the server on concurrent inserts
  await collection.updateOne(
    { _id },
    {
      $setOnInsert: {
        action, accountId, windowStart, count: 0, createdAt: now, updatedAt: now,
        expiresAt: new Date(resetAt.getTime() + windowMs),
      },
    },
    { upsert: true },
  );

  const doc = await collection.findOneAndUpdate(
    { _id, count: { $lt: limit } },
    { $inc: { count: 1 }, $set: { updatedAt: now } },
    { returnDocument: 'after' },
  );
  if (!doc) return { ok: false, limit, resetAt, retryAfterSeconds: secondsUntil(resetAt, now) };
  return { ok: true, limit, remaining: Math.max(limit - doc.count, 0), resetAt };
}

export interface AccountRateLimiter {
  readonly policy: WindowPolicy;
  /** Count one attempt for `accountId` (the app's user ID) */
  consume(accountId: string): Promise<RateLimitDecision>;
}

export function createAccountRateLimiter(
  db: Db,
  policy: WindowPolicy,
  now: () => Date = () => new Date(),
): AccountRateLimiter {
  assertValidPolicy(policy);
  const collection = db.collection<RateLimitDocument>(RATE_LIMITS_COLLECTION);
  return { policy, consume: (accountId) => consumeRateLimit(collection, accountId, policy, now()) };
}

/** Indexes for the rateLimits collection; called from ensureIndexes at startup */
export async function ensureRateLimitIndexes(db: Db): Promise<void> {
  // Lookups are by _id; this only expires finished windows
  await db.collection(RATE_LIMITS_COLLECTION).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
}
