import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { MongoClient, type Collection, type Db } from 'mongodb';
import type { Auth } from 'firebase-admin/auth';
import { loadConfig } from '../src/config.js';
import { ensureIndexes } from '../src/indexes.js';
import { createAuthMiddleware } from '../src/modules/auth/middleware.js';
import {
  ConcurrencyLimiter,
  consumeRateLimit,
  createAccountRateLimiter,
  getRequestRateLimiter,
  HOUR_MS,
  installRequestRateLimit,
  RATE_LIMITS_COLLECTION,
  setRequestRateLimiter,
  TokenBucketLimiter,
  windowStartOf,
  type RateLimitDocument,
  type WindowPolicy,
} from '../src/modules/rate-limit/index.js';
import { buildApp, createMultiUserAuth } from './support.js';

/** Manual monotonic clock in milliseconds */
function manualClock(start = 1_000) {
  const clock = { ms: start, now: () => clock.ms, advance: (ms: number) => { clock.ms += ms; } };
  return clock;
}

describe('TokenBucketLimiter', () => {
  it('allows the burst, then refuses with the seconds until the next token', () => {
    const clock = manualClock();
    const limiter = new TokenBucketLimiter({ burst: 3, refillPerSecond: 0.5 }, clock.now);

    for (let i = 0; i < 3; i++) expect(limiter.take('a')).toEqual({ ok: true });
    expect(limiter.take('a')).toEqual({ ok: false, retryAfterSeconds: 2 });

    clock.advance(1_000); // half a token back
    expect(limiter.take('a')).toEqual({ ok: false, retryAfterSeconds: 1 });
    clock.advance(1_000);
    expect(limiter.take('a')).toEqual({ ok: true });
    expect(limiter.take('a')).toMatchObject({ ok: false });
  });

  it('refills at the sustained rate and never above the burst', () => {
    const clock = manualClock();
    const limiter = new TokenBucketLimiter({ burst: 5, refillPerSecond: 2 }, clock.now);
    for (let i = 0; i < 5; i++) limiter.take('a');

    clock.advance(1_000); // two tokens
    expect(limiter.take('a').ok).toBe(true);
    expect(limiter.take('a').ok).toBe(true);
    expect(limiter.take('a').ok).toBe(false);

    clock.advance(60_000); // capped at the burst
    for (let i = 0; i < 5; i++) expect(limiter.take('a').ok).toBe(true);
    expect(limiter.take('a').ok).toBe(false);
  });

  it('keeps a separate bucket per account', () => {
    const limiter = new TokenBucketLimiter({ burst: 1, refillPerSecond: 1 }, manualClock().now);
    expect(limiter.take('a').ok).toBe(true);
    expect(limiter.take('a').ok).toBe(false);
    expect(limiter.take('b').ok).toBe(true);
  });

  it('never tracks more accounts than its bound, dropping the least recently seen', () => {
    const clock = manualClock();
    const limiter = new TokenBucketLimiter({ burst: 1, refillPerSecond: 0.001, maxTrackedAccounts: 3 }, clock.now);

    for (const key of ['a', 'b', 'c']) expect(limiter.take(key).ok).toBe(true);
    expect(limiter.take('a').ok).toBe(false); // 'a' becomes most recently seen
    for (let i = 0; i < 1_000; i++) limiter.take(`flood-${i}`);
    expect(limiter.trackedAccounts).toBe(3);

    // A recent account keeps its state while the bound holds
    const fresh = new TokenBucketLimiter({ burst: 1, refillPerSecond: 0.001, maxTrackedAccounts: 3 }, clock.now);
    for (const key of ['a', 'b', 'c']) fresh.take(key);
    fresh.take('a'); // refused, now most recent
    fresh.take('d'); // evicts 'b', the least recently seen
    expect(fresh.take('a').ok).toBe(false);
    expect(fresh.take('b').ok).toBe(true); // forgotten, so it starts with a full bucket
    expect(fresh.trackedAccounts).toBe(3);
  });

  it('ignores a clock that goes backwards', () => {
    const clock = manualClock(10_000);
    const limiter = new TokenBucketLimiter({ burst: 1, refillPerSecond: 1 }, clock.now);
    limiter.take('a');
    clock.advance(-5_000);
    expect(limiter.take('a')).toEqual({ ok: false, retryAfterSeconds: 1 });
  });

  it('rejects invalid settings', () => {
    expect(() => new TokenBucketLimiter({ burst: 0, refillPerSecond: 1 })).toThrow(/burst/);
    expect(() => new TokenBucketLimiter({ burst: 1.5, refillPerSecond: 1 })).toThrow(/burst/);
    expect(() => new TokenBucketLimiter({ burst: 1, refillPerSecond: 0 })).toThrow(/refillPerSecond/);
    expect(() => new TokenBucketLimiter({ burst: 1, refillPerSecond: 1, maxTrackedAccounts: 0 })).toThrow(/maxTrackedAccounts/);
  });
});

describe('ConcurrencyLimiter', () => {
  it('hands out at most `max` slots and never queues', () => {
    const slots = new ConcurrencyLimiter(2);
    const first = slots.tryAcquire();
    const second = slots.tryAcquire();
    expect(first).toBeTypeOf('function');
    expect(second).toBeTypeOf('function');
    expect(slots.tryAcquire()).toBeNull();
    expect(slots.inFlight).toBe(2);

    first!();
    first!(); // a second release is a no-op
    expect(slots.inFlight).toBe(1);
    expect(slots.tryAcquire()).toBeTypeOf('function');
    expect(slots.tryAcquire()).toBeNull();
  });

  it('rejects an invalid limit', () => {
    expect(() => new ConcurrencyLimiter(0)).toThrow('Invalid concurrency limit: 0');
    expect(() => new ConcurrencyLimiter(2.5)).toThrow('Invalid concurrency limit: 2.5');
  });
});

// --- Generic limit in the auth middleware ---

function tinyApp(auth: Auth, options: Parameters<typeof createAuthMiddleware>[1]) {
  const app = express();
  app.use((req: Request, _res: Response, next) => {
    req.requestId = 'req-1';
    next();
  });
  app.get('/ping', createAuthMiddleware(auth, options), (_req: Request, res: Response) => {
    res.json({ data: { ok: true } });
  });
  return app;
}

describe('createAuthMiddleware request limit', () => {
  afterEach(() => setRequestRateLimiter(null));

  it('answers 429 RATE_LIMITED with Retry-After once the account bucket is empty', async () => {
    const clock = manualClock();
    const limiter = new TokenBucketLimiter({ burst: 2, refillPerSecond: 0.25 }, clock.now);
    const app = tinyApp(createMultiUserAuth(), { requestLimiter: limiter });
    const ping = (name: string) => request(app).get('/ping').set('Authorization', `Bearer token-${name}`);

    expect((await ping('alice')).status).toBe(200);
    expect((await ping('alice')).status).toBe(200);
    const limited = await ping('alice');
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('4');
    expect(limited.body).toEqual({
      error: { code: 'RATE_LIMITED', message: expect.any(String), retryable: true, retryAfterSeconds: 4 },
      requestId: 'req-1',
    });

    // Keyed by the verified UID: another account is unaffected
    expect((await ping('bob')).status).toBe(200);

    clock.advance(4_000);
    expect((await ping('alice')).status).toBe(200);
  });

  it('spends nothing on requests that fail authentication', async () => {
    const limiter = new TokenBucketLimiter({ burst: 1, refillPerSecond: 0.01 }, manualClock().now);
    const take = vi.spyOn(limiter, 'take');
    const auth = {
      verifyIdToken: vi.fn().mockRejectedValue(Object.assign(new Error('bad'), { code: 'auth/argument-error' })),
    } as unknown as Auth;
    const app = tinyApp(auth, { requestLimiter: limiter });

    for (let i = 0; i < 3; i++) {
      expect((await request(app).get('/ping').set('Authorization', 'Bearer nope')).status).toBe(401);
    }
    expect((await request(app).get('/ping')).status).toBe(401);
    expect(take).not.toHaveBeenCalled();
  });

  it('uses the process-wide limiter when none is passed, and none at all by default', async () => {
    const app = tinyApp(createMultiUserAuth(), {});
    const ping = () => request(app).get('/ping').set('Authorization', 'Bearer token-alice');

    expect(getRequestRateLimiter()).toBeNull();
    for (let i = 0; i < 5; i++) expect((await ping()).status).toBe(200);

    setRequestRateLimiter(new TokenBucketLimiter({ burst: 1, refillPerSecond: 0.01 }, manualClock().now));
    expect((await ping()).status).toBe(200);
    expect((await ping()).status).toBe(429);

    // null opts a router out even when a process-wide limiter is installed
    const exempt = tinyApp(createMultiUserAuth(), { requestLimiter: null });
    expect((await request(exempt).get('/ping').set('Authorization', 'Bearer token-alice')).status).toBe(200);
  });

  it('applies the installed limit to the real routers, across modules, per account', async () => {
    const limiter = installRequestRateLimit({ REQUEST_RATE_LIMIT_BURST: 3, REQUEST_RATE_LIMIT_PER_SECOND: 0.01 });
    expect(getRequestRateLimiter()).toBe(limiter);
    expect(limiter).toMatchObject({ burst: 3, refillPerSecond: 0.01 });

    const app = buildApp(createMultiUserAuth());
    const as = (name: string) => `Bearer token-${name}`;
    await request(app).post('/v1/me/bootstrap').set('Authorization', as('alice'));
    await request(app).get('/v1/me').set('Authorization', as('alice'));
    await request(app).get('/v1/me/preferences').set('Authorization', as('alice'));

    const limited = await request(app).get('/v1/me/profile').set('Authorization', as('alice'));
    expect(limited.status).toBe(429);
    expect(limited.body.error).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(limited.body.requestId).toEqual(expect.any(String));

    // The public catalog is not authenticated, so it is not limited
    expect((await request(app).get('/v1/catalogs')).status).toBe(200);
    expect((await request(app).post('/v1/me/bootstrap').set('Authorization', as('bob'))).status).toBe(201);
  });
});

// --- Config ---

describe('rate limit settings', () => {
  const KEYS = [
    'PHOTO_UPLOADS_PER_HOUR', 'MEDIA_MAX_CONCURRENT_UPLOADS', 'DISCOVERY_SESSIONS_PER_HOUR',
    'REQUEST_RATE_LIMIT_BURST', 'REQUEST_RATE_LIMIT_PER_SECOND',
  ];
  const saved = new Map(KEYS.map((k) => [k, process.env[k]]));

  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('defaults to the proposed pilot values', () => {
    for (const k of KEYS) delete process.env[k];
    expect(loadConfig()).toMatchObject({
      PHOTO_UPLOADS_PER_HOUR: 10,
      MEDIA_MAX_CONCURRENT_UPLOADS: 4,
      DISCOVERY_SESSIONS_PER_HOUR: 30,
      REQUEST_RATE_LIMIT_BURST: 60,
      REQUEST_RATE_LIMIT_PER_SECOND: 2,
    });
  });

  it('reads overrides, including a fractional refill rate', () => {
    process.env['PHOTO_UPLOADS_PER_HOUR'] = '3';
    process.env['REQUEST_RATE_LIMIT_PER_SECOND'] = '0.5';
    expect(loadConfig()).toMatchObject({ PHOTO_UPLOADS_PER_HOUR: 3, REQUEST_RATE_LIMIT_PER_SECOND: 0.5 });
  });

  it.each([
    ['PHOTO_UPLOADS_PER_HOUR', '0'],
    ['MEDIA_MAX_CONCURRENT_UPLOADS', '1.5'],
    ['DISCOVERY_SESSIONS_PER_HOUR', '-1'],
    ['REQUEST_RATE_LIMIT_BURST', 'lots'],
    ['REQUEST_RATE_LIMIT_PER_SECOND', '0'],
  ])('rejects %s=%s', (key, value) => {
    process.env[key] = value;
    expect(() => loadConfig()).toThrow(key);
  });
});

// --- MongoDB window counters (real local replica set, isolated database) ---

describe('consumeRateLimit (MongoDB)', () => {
  const uri = process.env['MONGO_URI']!;
  const dbName = `lemon_test_rate_limit_${process.pid}_${Date.now()}`;
  let client: MongoClient;
  let db: Db;
  let counters: Collection<RateLimitDocument>;
  const policy: WindowPolicy = { action: 'photo_upload', limit: 3, windowMs: HOUR_MS };
  const at = (iso: string) => new Date(iso);

  beforeAll(async () => {
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
    try {
      await client.connect();
    } catch (err) {
      throw new Error(`Rate limit tests need MongoDB at ${uri} (run the local replica set)`, { cause: err });
    }
    db = client.db(dbName);
    await ensureIndexes(db);
    counters = db.collection<RateLimitDocument>(RATE_LIMITS_COLLECTION);
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await client?.close();
  });

  beforeEach(async () => {
    await counters.deleteMany({});
  });

  it('allows the limit per window, then refuses until the window ends', async () => {
    const now = at('2026-11-10T12:15:30Z');
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await consumeRateLimit(counters, 'user-1', policy, now));

    expect(results.slice(0, 3).map((r) => r.ok && r.remaining)).toEqual([2, 1, 0]);
    expect(results[3]).toEqual({
      ok: false, limit: 3, resetAt: at('2026-11-10T13:00:00Z'), retryAfterSeconds: 44 * 60 + 30,
    });

    // Still refused one second before the boundary; allowed again on it
    expect((await consumeRateLimit(counters, 'user-1', policy, at('2026-11-10T12:59:59Z'))).ok).toBe(false);
    expect(await consumeRateLimit(counters, 'user-1', policy, at('2026-11-10T13:00:00Z'))).toMatchObject({
      ok: true, remaining: 2, resetAt: at('2026-11-10T14:00:00Z'),
    });
  });

  it('never exceeds the limit under concurrent requests, including the first of the window', async () => {
    const now = at('2026-11-10T12:00:00Z');
    const results = await Promise.all(
      Array.from({ length: 25 }, () => consumeRateLimit(counters, 'user-1', { ...policy, limit: 10 }, now)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(10);
    expect(results.filter((r) => !r.ok)).toHaveLength(15);
    const docs = await counters.find().toArray();
    expect(docs).toHaveLength(1);
    expect(docs[0]!.count).toBe(10);
  });

  it('counts each account and each action separately', async () => {
    const now = at('2026-11-10T12:00:00Z');
    for (let i = 0; i < 3; i++) await consumeRateLimit(counters, 'user-1', policy, now);
    expect((await consumeRateLimit(counters, 'user-1', policy, now)).ok).toBe(false);
    expect((await consumeRateLimit(counters, 'user-2', policy, now)).ok).toBe(true);
    expect((await consumeRateLimit(counters, 'user-1', { ...policy, action: 'discovery_session' }, now)).ok).toBe(true);
  });

  it('stores one document per window that the TTL index removes one window after it ends', async () => {
    const now = at('2026-11-10T12:15:00Z');
    await consumeRateLimit(counters, 'user-1', policy, now);
    const doc = await counters.findOne({});
    expect(doc).toMatchObject({
      _id: 'photo_upload:user-1:2026-11-10T12:00:00.000Z',
      action: 'photo_upload',
      accountId: 'user-1',
      windowStart: at('2026-11-10T12:00:00Z'),
      count: 1,
      expiresAt: at('2026-11-10T14:00:00Z'),
    });

    const ttl = (await counters.indexes()).find((i) => i.key['expiresAt'] === 1);
    expect(ttl?.expireAfterSeconds).toBe(0);
  });

  it('builds limiters with a clock and rejects invalid policies', async () => {
    const clock = { now: at('2026-11-10T12:00:00Z') };
    const limiter = createAccountRateLimiter(db, { ...policy, limit: 1 }, () => clock.now);
    expect((await limiter.consume('user-1')).ok).toBe(true);
    expect((await limiter.consume('user-1')).ok).toBe(false);
    clock.now = at('2026-11-10T13:00:00Z');
    expect((await limiter.consume('user-1')).ok).toBe(true);

    expect(() => createAccountRateLimiter(db, { ...policy, limit: 0 })).toThrow(/limit/);
    expect(() => createAccountRateLimiter(db, { ...policy, windowMs: 10 })).toThrow(/windowMs/);
  });

  it('aligns windows to the clock hour in UTC', () => {
    expect(windowStartOf(at('2026-11-10T12:59:59.999Z'), HOUR_MS)).toEqual(at('2026-11-10T12:00:00Z'));
    expect(windowStartOf(at('2026-11-10T13:00:00Z'), HOUR_MS)).toEqual(at('2026-11-10T13:00:00Z'));
  });
});
