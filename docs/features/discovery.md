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
  - An unexpired pass. The query always checks `expiresAt > now`, so a pass that has expired but that TTL hasn't deleted yet never hides anyone.
  - A pluggable `PairExclusionProvider` for blocks, terminal pairs, report hides and matches. The default `noPairExclusions` excludes nobody.
- **Sessions:**
  - `GET /v1/discovery` without a cursor builds a bounded session: an index-backed pre-filter on the viewer's side, the full mutual check, then a seeded Fisher–Yates shuffle. Sessions hold at most 200 IDs and last 30 minutes.
  - Each session stores the seed, the viewer's preferences revision and the viewer's residence city. Changing either invalidates the session.
  - The seed and clock can be injected.
  - Nothing is ranked. Order is a uniform permutation.
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
- **Responses:** each card is `{profile, photos}`.
  - `profile` reuses the profiles public projection (`toPublicProfileDTO`).
  - `photos` lists only approved photos (`toPublicPhotoDTO`), which link to the authenticated `/v1/media/{id}/{variant}` route that rechecks access on every read.
  - Live responses are validated against the OpenAPI schemas, which use `additionalProperties: false`.
- **Indexes** (`ensureDiscoveryIndexes`):
  - `passes {viewerId, candidateId}` unique, and a TTL on `passes.expiresAt`.
  - A TTL on `discoverySessions.expiresAt`.
  - `profiles {genderIdentity, cityId}` and `profiles {genderIdentity, stateCode}` for the candidate pre-filter.
  - Tests use `explain` to confirm the pre-filters and pass lookups use these indexes.
- **`isDiscoverable(viewer, candidateId)`:** exported from the service for rechecking discovery-context actions.
- **Tests:** 107 in total, 59 pure rule tests and 48 integration tests against the local replica set, each run in an isolated `lemon_test_discovery_<pid>_<ts>` database that is dropped afterwards.

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
- **Incoming likes that are declined or accepted** don't hide the candidate in Discover. Only pending ones do, per the shared likes contract. Accepted likes become matches, which the Phase 09 provider will exclude. Whether a like the viewer declined should also hide the liker is an open product question.
- **Pool bound:** a session build reads at most 2,000 pre-filtered profiles in index order before the mutual check and shuffle. At pilot density this is the whole pool. For very large pools the sample leans towards the index order (see Phase 17).

## Follow-ups

- **Phase 09 (matches):**
  - Add a provider that excludes active matches and terminal pairs from `pairs`, in both directions.
  - Pass it with `combineExclusions` in `src/index.ts`, through the `overrides` argument of `createDiscoveryRoutes`.
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
  - Measure with 10k+ synthetic profiles.
  - Consider denormalizing discovery fields (status, readiness, pause, birth date) onto profiles, and random sampling in the database for very large pools.
  - Keep one active session per viewer if session churn shows up.
- **Flutter Discover screen:**
  - Card stack from `items`, with Pass (`POST /v1/passes`).
  - Follow `nextCursor` and keep fetching while `status` is `more`, even when `items` is empty.
  - On `end`, offer a refresh.
  - On `empty`, offer a user-triggered filter change, quoting the exact scope.
  - On any 409, restart without a cursor.
  - Load photos through authenticated media requests.
