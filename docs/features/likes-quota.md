# Feature brief: Daily like quota

**Branch:** `feat/likes-quota` (from `main`)
**Roadmap:** part of Phase 08 in `docs/progress.md`
**Spec:** `docs/specification.md` §4.5 "Likes and matching" and the `quotas` row of the data model
**Requirements:** R-LIKE-02. This module is the quota building block for R-LIKE-03.
**Decision:** P-10 in `docs/product-decisions.md` (8 new likes per UTC day, still open for owner confirmation)

## Files this feature owns

- `apps/api/src/modules/likes/quota.ts`
- `apps/api/test/likes-quota.test.ts`
- `docs/features/likes-quota.md`

It touches no shared files. The like service, routes and incoming-likes list will live alongside it in `apps/api/src/modules/likes/`.

## Done on this branch

- `utcDayKey` / `nextResetAt`: the UTC day boundary from the server clock only. Device timezone never affects the allowance, so travel can't reset it.
- `consumeLikeQuota(quotas, userId, now, policy?, session?)` consumes one like atomically, in two steps that never raise write errors:
  1. Ensure the day's document exists (`_id = userId:utcDay`, an `_id`-equality upsert that the server retries on concurrent inserts).
  2. Increment it only while `usedLikes < limit`.

  It returns `{ ok: true, used, remaining, limit, resetAt }` or `{ ok: false, code: 'QUOTA_EXHAUSTED', limit, resetAt }`. Pass the like transaction's session so a rejected or rolled-back like consumes nothing.
- `getQuotaStatus` gives a read-only allowance for the like composer.
- `ensureQuotaIndexes(db)` adds the per-user history index.
- 16 tests: unit tests for the day boundary, month, year and leap-day rollovers, and timezones; integration tests against the real local MongoDB replica set for the limit, 25 parallel requests including the first like of the day, independent users, UTC-midnight reset, transaction abort and commit, exhaustion without aborting the transaction, configured, zero and lowered policies, and invalid policy.

## To wire up when the like service is built

- Call `ensureQuotaIndexes(db)` from `src/indexes.ts`. That file lands with `feat/profiles-preferences`, so it isn't edited here to avoid a conflict.
- Read the policy from config (e.g. `LIKES_PER_UTC_DAY`) rather than `DEFAULT_QUOTA_POLICY`.
- Call `consumeLikeQuota` inside the like transaction, **after** validation (self-like, blocked or paused recipient, stale target) and only for new outgoing likes. Accepting or declining an incoming like must not consume quota. An idempotent retry must return the original like without calling it again.
- Map `QUOTA_EXHAUSTED` to `429`, with `resetAt` so the app can show the reset time in local time.
