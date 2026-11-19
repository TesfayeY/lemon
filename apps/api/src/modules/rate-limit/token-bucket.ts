/**
 * Generic per-account request limit: an in-process token bucket per Firebase
 * UID, checked by createAuthMiddleware after the token is verified.
 *
 * A coarse safety net, not an exact quota:
 * - State lives in this process only. With N API processes an account can get
 *   up to N times the budget, and a restart refills every bucket. Limits that
 *   must hold across processes (photo uploads, new Discover sessions, likes)
 *   are MongoDB counters instead.
 * - The map is bounded by `maxTrackedAccounts`. Each request moves its account
 *   to the end; when the map is full, the least recently seen account is
 *   dropped. That bucket has usually refilled already (a bucket refills fully
 *   in burst / refillPerSecond seconds); if not, the account starts again
 *   with a full bucket.
 */

import type { Env } from '../../config.js';

export interface TokenBucketSettings {
  /** Requests an idle account can make at once */
  burst: number;
  /** Sustained requests per second once the burst is used */
  refillPerSecond: number;
  /** Most accounts tracked at once; bounds memory */
  maxTrackedAccounts?: number;
}

export const DEFAULT_MAX_TRACKED_ACCOUNTS = 10_000;

export type RequestDecision = { ok: true } | { ok: false; retryAfterSeconds: number };

export interface RequestRateLimiter {
  /** Spend one request for `accountKey`, or say how long to wait */
  take(accountKey: string): RequestDecision;
}

interface Bucket {
  tokens: number;
  updatedAtMs: number;
}

export class TokenBucketLimiter implements RequestRateLimiter {
  readonly burst: number;
  readonly refillPerSecond: number;
  readonly maxTrackedAccounts: number;
  private readonly buckets = new Map<string, Bucket>();

  /** `clockMs` must be monotonic; tests inject one */
  constructor(settings: TokenBucketSettings, private readonly clockMs: () => number = () => performance.now()) {
    const { burst, refillPerSecond, maxTrackedAccounts = DEFAULT_MAX_TRACKED_ACCOUNTS } = settings;
    if (!Number.isInteger(burst) || burst < 1) throw new Error(`Invalid request rate limit: burst=${burst}`);
    if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
      throw new Error(`Invalid request rate limit: refillPerSecond=${refillPerSecond}`);
    }
    if (!Number.isInteger(maxTrackedAccounts) || maxTrackedAccounts < 1) {
      throw new Error(`Invalid request rate limit: maxTrackedAccounts=${maxTrackedAccounts}`);
    }
    this.burst = burst;
    this.refillPerSecond = refillPerSecond;
    this.maxTrackedAccounts = maxTrackedAccounts;
  }

  /** Accounts currently tracked (never more than maxTrackedAccounts) */
  get trackedAccounts(): number {
    return this.buckets.size;
  }

  take(accountKey: string): RequestDecision {
    const now = this.clockMs();
    const previous = this.buckets.get(accountKey);
    let tokens = this.burst;
    if (previous) {
      const elapsedSeconds = Math.max(0, now - previous.updatedAtMs) / 1000;
      tokens = Math.min(this.burst, previous.tokens + elapsedSeconds * this.refillPerSecond);
      // Re-inserted below, which marks the account as most recently seen
      this.buckets.delete(accountKey);
    }

    const allowed = tokens >= 1;
    this.buckets.set(accountKey, { tokens: allowed ? tokens - 1 : tokens, updatedAtMs: now });
    while (this.buckets.size > this.maxTrackedAccounts) {
      const oldest = this.buckets.keys().next().value as string;
      this.buckets.delete(oldest);
    }

    if (allowed) return { ok: true };
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / this.refillPerSecond)) };
  }
}

// --- Process-wide limiter used by createAuthMiddleware ---

let installed: RequestRateLimiter | null = null;

/** Replace (or with null, remove) the limiter every auth middleware uses by default. */
export function setRequestRateLimiter(limiter: RequestRateLimiter | null): void {
  installed = limiter;
}

export function getRequestRateLimiter(): RequestRateLimiter | null {
  return installed;
}

export type RequestRateLimitConfig = Pick<Env, 'REQUEST_RATE_LIMIT_BURST' | 'REQUEST_RATE_LIMIT_PER_SECOND'>;

/**
 * Install the process-wide limiter from config. Called once by the API entry
 * point (src/index.ts) before it serves traffic. Routers built without it
 * (tests, scripts) have no generic request limit.
 */
export function installRequestRateLimit(config: RequestRateLimitConfig): TokenBucketLimiter {
  const limiter = new TokenBucketLimiter({
    burst: config.REQUEST_RATE_LIMIT_BURST,
    refillPerSecond: config.REQUEST_RATE_LIMIT_PER_SECOND,
  });
  setRequestRateLimiter(limiter);
  return limiter;
}
