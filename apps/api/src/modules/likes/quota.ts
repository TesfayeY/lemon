/**
 * Daily like allowance (P-10: 8 new likes per UTC day, configurable).
 *
 * - The day boundary is UTC midnight on the server clock; device time and
 *   timezone are never consulted, so travel cannot reset the allowance.
 * - Consumption is a conditional increment on one document per (userId,
 *   utcDay), so concurrent requests across API processes cannot exceed it.
 * - Pass the like transaction's session so a rejected or rolled-back like
 *   consumes nothing. Accepting an incoming like must not call this.
 */

import type { ClientSession, Collection, Db } from 'mongodb';

export interface QuotaPolicy {
  dailyLikes: number;
  policyVersion: number;
}

export const DEFAULT_QUOTA_POLICY: QuotaPolicy = { dailyLikes: 8, policyVersion: 1 };

export interface QuotaDocument {
  _id: string; // `${userId}:${utcDay}`
  userId: string;
  utcDay: string; // YYYY-MM-DD
  usedLikes: number;
  policyVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface QuotaStatus {
  limit: number;
  used: number;
  remaining: number;
  resetAt: Date;
}

export type ConsumeResult =
  | ({ ok: true } & QuotaStatus)
  | { ok: false; code: 'QUOTA_EXHAUSTED'; limit: number; resetAt: Date };

export const QUOTAS_COLLECTION = 'quotas';

/** UTC calendar day of an instant, e.g. "2026-10-25" */
export function utcDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Next UTC midnight strictly after `now` — when the allowance resets */
export function nextResetAt(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

function quotaId(userId: string, utcDay: string): string {
  return `${userId}:${utcDay}`;
}

function assertValidPolicy(policy: QuotaPolicy): void {
  if (!Number.isInteger(policy.dailyLikes) || policy.dailyLikes < 0) {
    throw new Error(`Invalid like quota policy: dailyLikes=${policy.dailyLikes}`);
  }
}

/**
 * Atomically consume one like from today's allowance.
 *
 * Two steps, neither of which can raise a write error (so it is safe inside a
 * transaction): ensure today's document exists via an _id-only upsert, then
 * increment it only while usedLikes < limit. No match means "exhausted".
 */
export async function consumeLikeQuota(
  quotas: Collection<QuotaDocument>,
  userId: string,
  now: Date,
  policy: QuotaPolicy = DEFAULT_QUOTA_POLICY,
  session?: ClientSession,
): Promise<ConsumeResult> {
  assertValidPolicy(policy);
  const utcDay = utcDayKey(now);
  const _id = quotaId(userId, utcDay);
  const resetAt = nextResetAt(now);
  const opts = session ? { session } : {};

  // Equality-on-_id upserts are retried by the server on concurrent inserts
  await quotas.updateOne(
    { _id },
    { $setOnInsert: { userId, utcDay, usedLikes: 0, policyVersion: policy.policyVersion, createdAt: now, updatedAt: now } },
    { upsert: true, ...opts },
  );

  const doc = await quotas.findOneAndUpdate(
    { _id, usedLikes: { $lt: policy.dailyLikes } },
    { $inc: { usedLikes: 1 }, $set: { updatedAt: now, policyVersion: policy.policyVersion } },
    { returnDocument: 'after', ...opts },
  );
  if (!doc) return { ok: false, code: 'QUOTA_EXHAUSTED', limit: policy.dailyLikes, resetAt };

  return {
    ok: true,
    limit: policy.dailyLikes,
    used: doc.usedLikes,
    remaining: Math.max(policy.dailyLikes - doc.usedLikes, 0),
    resetAt,
  };
}

/** Read-only allowance for the like composer ("3 likes left, resets at …") */
export async function getQuotaStatus(
  quotas: Collection<QuotaDocument>,
  userId: string,
  now: Date,
  policy: QuotaPolicy = DEFAULT_QUOTA_POLICY,
  session?: ClientSession,
): Promise<QuotaStatus> {
  assertValidPolicy(policy);
  const doc = await quotas.findOne(
    { _id: quotaId(userId, utcDayKey(now)) },
    session ? { session } : {},
  );
  const used = Math.min(doc?.usedLikes ?? 0, policy.dailyLikes);
  return {
    limit: policy.dailyLikes,
    used,
    remaining: policy.dailyLikes - used,
    resetAt: nextResetAt(now),
  };
}

/** Indexes for the quotas collection; call from ensureIndexes at startup */
export async function ensureQuotaIndexes(db: Db): Promise<void> {
  // _id already makes (userId, utcDay) unique; this supports per-user cleanup/history
  await db.collection(QUOTAS_COLLECTION).createIndex({ userId: 1, utcDay: -1 });
}
