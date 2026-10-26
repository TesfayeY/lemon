import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient, type Collection, type Db } from 'mongodb';
import {
  consumeLikeQuota,
  ensureQuotaIndexes,
  getQuotaStatus,
  nextResetAt,
  utcDayKey,
  DEFAULT_QUOTA_POLICY,
  QUOTAS_COLLECTION,
  type QuotaDocument,
} from '../src/modules/likes/quota.js';

describe('utcDayKey', () => {
  it('uses the UTC calendar day', () => {
    expect(utcDayKey(new Date('2026-10-25T23:59:59.999Z'))).toBe('2026-10-25');
    expect(utcDayKey(new Date('2026-10-26T00:00:00.000Z'))).toBe('2026-10-26');
  });

  it('ignores the timezone an instant was written in', () => {
    // 2026-10-25 18:30 in Seattle (UTC-7) is already 01:30 on the 26th in UTC
    expect(utcDayKey(new Date('2026-10-25T18:30:00-07:00'))).toBe('2026-10-26');
    // 2026-10-26 02:00 in Addis Ababa (UTC+3) is still the 25th in UTC
    expect(utcDayKey(new Date('2026-10-26T02:00:00+03:00'))).toBe('2026-10-25');
  });
});

describe('nextResetAt', () => {
  it('is the next UTC midnight', () => {
    expect(nextResetAt(new Date('2026-10-25T13:00:00Z')).toISOString()).toBe('2026-10-26T00:00:00.000Z');
  });

  it('moves to the following day exactly at midnight', () => {
    expect(nextResetAt(new Date('2026-10-26T00:00:00Z')).toISOString()).toBe('2026-10-27T00:00:00.000Z');
  });

  it('rolls over month, year and leap day boundaries', () => {
    expect(nextResetAt(new Date('2026-10-31T12:00:00Z')).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(nextResetAt(new Date('2026-12-31T23:59:59Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(nextResetAt(new Date('2028-02-28T08:00:00Z')).toISOString()).toBe('2028-02-29T00:00:00.000Z');
    expect(nextResetAt(new Date('2028-02-29T08:00:00Z')).toISOString()).toBe('2028-03-01T00:00:00.000Z');
  });
});

// Mongo integration: real local replica set, isolated database per run
describe('like quota (MongoDB)', () => {
  const uri = process.env['MONGO_URI']!;
  const dbName = `lemon_test_quota_${process.pid}_${Date.now()}`;
  const NOW = new Date('2026-10-25T15:00:00Z');
  let client: MongoClient;
  let db: Db;
  let quotas: Collection<QuotaDocument>;

  beforeAll(async () => {
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
    try {
      await client.connect();
    } catch (err) {
      throw new Error(`Quota integration tests need MongoDB at ${uri} (run the local replica set)`, { cause: err });
    }
    db = client.db(dbName);
    await ensureQuotaIndexes(db);
    quotas = db.collection<QuotaDocument>(QUOTAS_COLLECTION);
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await client?.close();
  });

  beforeEach(async () => {
    await quotas.deleteMany({});
  });

  it('allows 8 likes per UTC day by default, then reports exhaustion with the reset time', async () => {
    for (let i = 1; i <= 8; i++) {
      const res = await consumeLikeQuota(quotas, 'alice', NOW);
      expect(res).toMatchObject({ ok: true, used: i, remaining: 8 - i, limit: 8 });
    }
    const ninth = await consumeLikeQuota(quotas, 'alice', NOW);
    expect(ninth).toEqual({
      ok: false,
      code: 'QUOTA_EXHAUSTED',
      limit: 8,
      resetAt: new Date('2026-10-26T00:00:00Z'),
    });
    expect((await quotas.findOne({ userId: 'alice' }))?.usedLikes).toBe(8);
  });

  it('never exceeds the allowance under parallel requests, including the first like of the day', async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, () => consumeLikeQuota(quotas, 'alice', NOW)),
    );
    expect(results.filter(r => r.ok)).toHaveLength(8);
    expect(results.filter(r => !r.ok)).toHaveLength(17);
    expect(results.flatMap(r => (r.ok ? [r.used] : [])).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(await quotas.countDocuments({ userId: 'alice' })).toBe(1);
    expect((await quotas.findOne({ userId: 'alice' }))?.usedLikes).toBe(8);
  });

  it('keeps users independent', async () => {
    for (let i = 0; i < 8; i++) await consumeLikeQuota(quotas, 'alice', NOW);
    const bob = await consumeLikeQuota(quotas, 'bob', NOW);
    expect(bob).toMatchObject({ ok: true, used: 1, remaining: 7 });
  });

  it('resets at UTC midnight', async () => {
    const lastMs = new Date('2026-10-25T23:59:59.999Z');
    for (let i = 0; i < 8; i++) await consumeLikeQuota(quotas, 'alice', lastMs);
    expect((await consumeLikeQuota(quotas, 'alice', lastMs)).ok).toBe(false);

    const midnight = new Date('2026-10-26T00:00:00.000Z');
    expect(await consumeLikeQuota(quotas, 'alice', midnight)).toMatchObject({ ok: true, used: 1, remaining: 7 });
  });

  it('consumes nothing when the surrounding like transaction aborts', async () => {
    const session = client.startSession();
    try {
      await expect(
        session.withTransaction(async () => {
          const res = await consumeLikeQuota(quotas, 'alice', NOW, DEFAULT_QUOTA_POLICY, session);
          expect(res.ok).toBe(true);
          throw new Error('like rejected: stale target');
        }),
      ).rejects.toThrow('stale target');
    } finally {
      await session.endSession();
    }
    expect(await getQuotaStatus(quotas, 'alice', NOW)).toMatchObject({ used: 0, remaining: 8 });
  });

  it('commits with the like transaction', async () => {
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        await consumeLikeQuota(quotas, 'alice', NOW, DEFAULT_QUOTA_POLICY, session);
      });
    } finally {
      await session.endSession();
    }
    expect(await getQuotaStatus(quotas, 'alice', NOW)).toMatchObject({ used: 1, remaining: 7 });
  });

  it('reports exhaustion inside a transaction without aborting it', async () => {
    for (let i = 0; i < 8; i++) await consumeLikeQuota(quotas, 'alice', NOW);
    const session = client.startSession();
    try {
      const outcome = await session.withTransaction(async () => {
        const res = await consumeLikeQuota(quotas, 'alice', NOW, DEFAULT_QUOTA_POLICY, session);
        // The like service can still read inside the same transaction
        await quotas.findOne({ userId: 'alice' }, { session });
        return res;
      });
      expect(outcome).toMatchObject({ ok: false, code: 'QUOTA_EXHAUSTED' });
    } finally {
      await session.endSession();
    }
  });

  it('honors a configured policy', async () => {
    const policy = { dailyLikes: 2, policyVersion: 2 };
    expect((await consumeLikeQuota(quotas, 'alice', NOW, policy)).ok).toBe(true);
    expect((await consumeLikeQuota(quotas, 'alice', NOW, policy)).ok).toBe(true);
    expect((await consumeLikeQuota(quotas, 'alice', NOW, policy)).ok).toBe(false);
    expect((await quotas.findOne({ userId: 'alice' }))?.policyVersion).toBe(2);

    expect((await consumeLikeQuota(quotas, 'bob', NOW, { dailyLikes: 0, policyVersion: 3 })).ok).toBe(false);
  });

  it('caps remaining at zero when the policy is lowered mid-day', async () => {
    for (let i = 0; i < 5; i++) await consumeLikeQuota(quotas, 'alice', NOW);
    const lowered = { dailyLikes: 3, policyVersion: 2 };
    expect(await getQuotaStatus(quotas, 'alice', NOW, lowered)).toMatchObject({ used: 3, remaining: 0 });
    expect((await consumeLikeQuota(quotas, 'alice', NOW, lowered)).ok).toBe(false);
  });

  it('rejects an invalid policy', async () => {
    await expect(consumeLikeQuota(quotas, 'alice', NOW, { dailyLikes: -1, policyVersion: 1 })).rejects.toThrow('Invalid like quota policy');
    await expect(consumeLikeQuota(quotas, 'alice', NOW, { dailyLikes: 2.5, policyVersion: 1 })).rejects.toThrow('Invalid like quota policy');
  });

  it('reports a fresh allowance before any likes', async () => {
    expect(await getQuotaStatus(quotas, 'alice', NOW)).toEqual({
      limit: 8,
      used: 0,
      remaining: 8,
      resetAt: new Date('2026-10-26T00:00:00Z'),
    });
  });
});
