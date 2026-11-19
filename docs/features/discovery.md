# Feature brief: Discovery API

**Branch:** `feat/discovery` (from `main`)
**Roadmap:** Phase 07, server side, in `docs/progress.md`. The Flutter Discover screen and filter sheet are not built yet.
**Spec:** `docs/specification.md` §4.4 "Discovery and preferences", "US community and location rules", the `passes` and `discoverySessions` rows of §6, and the `/v1/discovery` and `/v1/passes` rows of §7
**Requirements:** R-DISC-01 to R-DISC-07. R-DISC-02 is partial: blocks, unmatches and matches go through a provider interface (see Follow-ups).
**Decisions:** D-08, city-based discovery (confirmed). P-07, launch metros (open, see Assumptions).

## Files this feature owns

- `apps/api/src/modules/discovery/**`
- `apps/api/test/discovery-rules.test.ts` (pure rules) and `apps/api/test/discovery.test.ts` (real MongoDB and routes)
- The `/v1/discovery` and `/v1/passes` paths and the `Discovery*`/`Pass*` schemas in `contracts/openapi.yaml`
- This brief

Shared files have small additive edits only: `src/index.ts` (route), `src/indexes.ts` (`ensureDiscoveryIndexes`), `src/config.ts` (two env vars) and `apps/api/.env.example`.

## Done on this branch

- **Mutual eligibility as a hard filter** (§4.4 items 1–9), in pure functions with an injected clock (`eligibility.ts`):
  - The viewer must be able to browse: active, profile-ready, not paused, with preferences, a birth date and a valid US residence.
  - The candidate must be a different person who is active, profile-ready and not paused.
  - Gender/interest must match both ways, and so must the age ranges (inclusive, computed from the injected clock).
  - The US location scopes must be compatible both ways (see Location policy).
- **Pair-state exclusions** are rechecked on every page:
  - Any like from the viewer, in any state.
  - A pending like from the candidate. These show in Likes, not Discover.
  - A like from the candidate that the viewer declined. A decline is final, so the liker never comes back into the viewer's Discover.
  - An unexpired pass. The query always checks `expiresAt > now`, so a pass that has expired but that TTL hasn't deleted yet never hides anyone.
  - A pluggable `PairExclusionProvider` for blocks, terminal pairs, report hides and matches. The default `noPairExclusions` excludes nobody.
- **Sessions:**
  - `GET /v1/discovery` without a cursor builds a bounded session. Sessions hold at most 200 IDs and last 30 minutes. The build has three steps:
    1. One aggregation on `profiles` (`candidatePoolPipeline`) reads at most `poolScanLimit` (2,000) candidates:
       - It applies the viewer-side pre-filter (gender, scope, US) on the profile indexes.
       - In the same query, before the limit, it leaves out the viewer and everyone their likes and passes hide: sent likes in any state, received pending or declined likes, and unexpired passes.
       - It joins `users` on `_id` and drops accounts that can't be shown: not active, not profile-ready, or paused.
       - So hidden and unshowable people never use up the budget.
    2. The full mutual check (`eligibleAmong`) runs on what was read, including the provider exclusions.
    3. A seeded Fisher–Yates shuffle sets the order.
  - If more candidates match than the budget, the aggregation keeps the `poolScanLimit` with the lowest hash of (user ID, session seed), using `$toHashedIndexKey`. Each new session has a new random seed, so it reads a different, roughly uniform sample, and nobody stays past the cutoff. If everyone fits, every seed reads the same whole set, so the result is exactly the seeded shuffle of the full pool.
  - Each session stores the seed, the viewer's preferences revision and the viewer's residence city. The seed decides both which candidates are read and their order. Changing the preferences or the city invalidates the session.
  - The seed and clock can be injected.
  - Nothing is ranked. Order is a uniform permutation, and the hash sample depends only on the user ID and the seed.
- **Signed cursors:**
  - Format: `v1.<payload>.<HMAC-SHA256>`, where the payload is `{sessionId, nextOffset, expiresAt}`. The secret comes from `DISCOVERY_CURSOR_SECRET`.
  - Malformed, tampered and other people's cursors all get the same 400 `INVALID_CURSOR`.
  - Expiry is checked twice: against the cursor and against the stored session. A session that TTL has already removed counts as expired.
- **Scanned offsets:**
  - Each page rechecks candidates in batches of `pageSize` (10) and stops right after the last candidate it returns. The cursor then points to the next unscanned position, so filtering never repeats or skips anyone.
  - One request scans at most 50 positions. If that budget runs out, the page can come back short or even empty, with status `more`.
- **Explicit statuses:**
  - `more`: follow the cursor.
  - `end`: the session is fully scanned.
  - `empty`: nobody matches the current filters.
  - The server never widens age or geography.
- **`POST /v1/passes`:**
  - Idempotent: a retry or a parallel request keeps one pass with its original expiry. A pass whose cooldown has ended is renewed.
  - Cooldown is `PASS_COOLDOWN_DAYS` (default 30).
  - Any existing user can be passed, so the response never reveals whether someone is blocked or unavailable. An unknown ID gets 404 `PROFILE_UNAVAILABLE`, and passing yourself gets 422.
- **Responses:** each card is `{profile}`.
  - `profile` is the shared public projection (`loadPublicProfiles`), the same one `GET /v1/profiles/:id` returns. Its `photos` list only approved photos, which link to the authenticated `/v1/media/{id}/{variant}` route that rechecks access on every read. See `public-profile-projection.md`.
  - Live responses are validated against the OpenAPI schemas, which use `additionalProperties: false`.
- **Indexes** (`ensureDiscoveryIndexes`):
  - `passes {viewerId, candidateId}` unique, and a TTL on `passes.expiresAt`.
  - A TTL on `discoverySessions.expiresAt`.
  - `profiles {genderIdentity, cityId}` and `profiles {genderIdentity, stateCode}` for the candidate pre-filter. Nationwide uses the `genderIdentity` prefix.
  - The session pool needs no index of its own:
    - The `users` join is an indexed loop join on `_id`.
    - The viewer's sent likes use `likes {fromUserId, toUserId}` and received likes use `likes {toUserId, state, createdAt}`, both owned by the likes module.
    - Active passes use the `passes {viewerId, candidateId}` prefix.
  - Tests use `explain` on the actual pool aggregation, for city, metro, state and nationwide. They confirm a profile index, the `_id` join and no collection scan. Other explain tests cover the like and pass lists and the per-page pass check.
- **`isDiscoverable(viewer, candidateId)`:** exported from the service for rechecking discovery-context actions.
- **Tests:** 114 in total: 59 pure rule tests, and 55 integration tests against the local replica set. Each integration run uses an isolated `lemon_test_discovery_<pid>_<ts>` database that is dropped afterwards.
  - The pool tests use small `poolScanLimit` and `maxSessionSize` values. Hidden people are seeded first and sort first by ID, so the old read in index order would have used the budget on them.
  - They prove that liked, passed, declined, inactive, not-ready and paused profiles don't use up the budget. A viewer who passed many people still gets the remaining eligible ones, not `empty`.
  - They prove that an oversubscribed pool reads different subsets across seeds and that everyone is eventually read, while the same seed reproduces the same subset.
  - They prove that a pool that fits is exactly `stableShuffle(sorted ids, seed)`.

## Endpoints

| Endpoint | Result | Errors |
| --- | --- | --- |
| `GET /v1/discovery[?cursor=]` | `{data: {items: DiscoveryCard[], status, preferencesRevision}, meta: {requestId, nextCursor}}` | 400 `INVALID_CURSOR`; 401; 403 `ACCOUNT_NOT_ELIGIBLE` / `DISCOVERY_PAUSED`; 404 no account; 409 `DISCOVERY_SESSION_EXPIRED` / `DISCOVERY_SESSION_INVALIDATED` (retryable: restart without a cursor) |
| `POST /v1/passes` `{candidateId}` | `{data: {candidateId, passedAt, expiresAt}}` | 401; 403; 404 `PROFILE_UNAVAILABLE`; 422 `VALIDATION_ERROR` (unknown fields rejected) |

## Configuration

- `DISCOVERY_CURSOR_SECRET` must be at least 32 characters.
  - Production refuses to start without it.
  - Development and tests fall back to a random secret for each process, so cursors stop working after a restart.
  - No secret is in code.
- `PASS_COOLDOWN_DAYS` defaults to 30.
- Page size, scan budget, session size and TTL, pool limits, catalog, exclusions, clock and seed are options of `createDiscoveryService`. Production uses the defaults in `DISCOVERY_DEFAULTS`.

## Assumptions

- **Location policy (proposed in the spec, awaiting owner confirmation):** a pair is eligible only if each person's scope includes the other's current residence.
  - `city`: the same catalog city ID, or the same explicit catalog `metroId`.
  - `state`: the same state code.
  - `nationwide`: any US residence. It must be chosen explicitly.
  - `longDistance` is stored but never overrides a hard scope.
  - Hometown is never read.
  - A residence must resolve in the catalog with `countryCode: 'US'` and a matching state. If not, that person is out of the pool, as viewer or as candidate.
- **P-07 (launch metros) is open.**
  - The catalog is injectable (`LocationCatalog`).
  - Metro membership is explicit per city, and no mileage is inferred.
  - The shared seed catalog defines no metros, so `city` scope means the exact city.
  - Tests use fictional cities and states (`springfield-xa`, `XA`/`XB`, …).
- **Paused viewers** can't browse (403 `DISCOVERY_PAUSED`). Pausing hides you from others, and §4.4 disables sending likes while paused, so browsing would be one-sided.
- **Viewer moving city** invalidates the session, like a preferences change.
- **Incoming likes:** pending and declined ones hide the liker (owner decision, 2026-11-10). Accepted likes become matches, which the Phase 09 provider will exclude.
- **Pool bound:** a session build reads at most 2,000 showable, not-yet-acted-on candidates before the mutual check and shuffle. At pilot density this is the whole pool.
  - A larger pool is sampled per session seed, as described under Sessions.
  - The `$nin` list of people the viewer acted on stays small. Sent likes are capped per day, passes expire after the cooldown, and each person can have at most one like to the viewer.
  - Cost: a sampled build reads every matching profile and its `users` entry, so the sample is uniform, then keeps the top 2,000 by hash in a bounded sort. The old build stopped after 2,000 profiles in index order (see Phase 17).

## Follow-ups

- **Phase 09 (matches):**
  - Add a provider that excludes active matches and terminal pairs from `pairs`, in both directions.
  - Pass it with `combineExclusions` in `src/index.ts`, through the `overrides` argument of `createDiscoveryRoutes`.
  - Provider exclusions only answer per batch (`excludedAmong`), so the session pool can't leave them out before the budget. They are still applied by the mutual check, so they are never shown. If matches or blocks grow large enough to matter, add a "list everyone hidden from this viewer" method to `PairExclusionProvider` and add its result to the pool's `$nin`.
- **Phase 12 (safety):**
  - Add providers for blocks in either direction, permanent for the pair, and for `reportHides`.
  - Same wiring as Phase 09.
- **Profile reads:**
  - `GET /v1/profiles/:id` still only checks that the viewer is active and ready.
  - When contextual access lands, it should allow a candidate the viewer can discover (`isDiscoverable`), an incoming liker or a match.
  - This lives in the profiles module, which this branch doesn't change.
- **Phase 08 (likes):**
  - Like creation should recheck `isDiscoverable`, or an equivalent pair check, at action time.
  - The `likes` indexes owned by that branch (unique `{fromUserId, toUserId}`) serve both discovery like queries.
- **Phase 15 (account lifecycle):** pausing already removes people from discovery. Deletion should remove the person's `passes` and `discoverySessions`.
- **Phase 17 (reliability and query plans):**
  - Measure with 10k+ synthetic profiles, especially a nationwide build, which reads every matching profile and its `users` entry.
  - If that is too slow:
    - Replace the hash sample with a random start point on the user ID (uniform UUIDs) and an index ending in `userId`, so a build reads only about the budget.
    - Or denormalize discovery fields (status, readiness, pause, birth date) onto profiles. Every writer of those fields would have to keep the copy in sync, so it was not done in the pool fix.
  - Reverse-direction mismatches still use the budget: the candidate's own gender, age and scope preferences, and the viewer's age range, since birth date is on `users`. If yields drop, these could move into the pool join.
  - Keep one active session per viewer if session churn shows up.
- **Flutter Discover screen:**
  - Card stack from `items`, with Pass (`POST /v1/passes`).
  - Follow `nextCursor` and keep fetching while `status` is `more`, even when `items` is empty.
  - On `end`, offer a refresh.
  - On `empty`, offer a user-triggered filter change, quoting the exact scope.
  - On any 409, restart without a cursor.
  - Load photos through authenticated media requests.
