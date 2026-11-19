# Rate limits and upload bounds

**Branch:** `fix/rate-limits`
**Spec:** `docs/specification.md` §7 "Proposed abuse limits and validation boundaries"
**Code:** `apps/api/src/modules/rate-limit/`, used by `auth/middleware.ts`, `media/routes.ts` and `discovery/routes.ts`

Before this change, nothing limited a signed-in account, so one free sign-up could tie up the server with uploads or Discover rebuilds. All values below are **proposed pilot values pending owner confirmation**. Each can be changed with an environment variable (`apps/api/.env.example`).

## Limits

| Limit | Default | Scope | Where it is kept | Over the limit |
|-------|---------|-------|------------------|----------------|
| Photo upload attempts | 10 per hour (`PHOTO_UPLOADS_PER_HOUR`) | per account | MongoDB `rateLimits`, shared by all processes | 429 `RATE_LIMITED` |
| Uploads in progress | 4 (`MEDIA_MAX_CONCURRENT_UPLOADS`) | per API process | memory | 503 `UPLOADS_BUSY` |
| New Discover sessions (`GET /v1/discovery` without `cursor`) | 30 per hour (`DISCOVERY_SESSIONS_PER_HOUR`) | per account | MongoDB `rateLimits` | 429 `RATE_LIMITED` |
| Any authenticated request | burst of 60, then 2 per second (`REQUEST_RATE_LIMIT_BURST`, `REQUEST_RATE_LIMIT_PER_SECOND`) | per account, **per process** | memory (token bucket) | 429 `RATE_LIMITED` |
| New likes (existing, unchanged) | 8 per UTC day (`LIKES_PER_UTC_DAY`) | per account | MongoDB `quotas` | 429 `QUOTA_EXHAUSTED` |

Every refusal uses the usual error envelope, is `retryable: true`, and sends a `Retry-After` header in whole seconds. The same number is in `error.retryAfterSeconds`:

```json
{ "error": { "code": "RATE_LIMITED", "message": "…", "retryable": true, "retryAfterSeconds": 3000 }, "requestId": "…" }
```

The client should show localized copy for `RATE_LIMITED` and `UPLOADS_BUSY`, and retry no sooner than `Retry-After`.

## How each limit works

**Hourly counters (uploads, Discover sessions).** These use the same pattern as the like quota: one document per (action, account, hour), an `_id` upsert, then an `$inc` that only applies while `count < limit`. Concurrent requests on any number of processes can't go over the limit. Windows are fixed clock hours in UTC, so `Retry-After` points to the top of the next hour. A burst that straddles the hour can reach twice the limit in a short span. A TTL index on `expiresAt` deletes each document one hour after its window ends. The index is registered in `src/indexes.ts`.

**Photo uploads** (`POST /v1/me/photos`). Order of checks: token, account status, `Idempotency-Key` header, upload slot, attempt count. Only then is the multipart body read. A client over either limit never makes the server buffer (up to `MEDIA_MAX_BYTES`) or decode (up to 40 MP) its file.
- Every attempt counts, including ones later rejected as invalid images.
- A request whose `Idempotency-Key` is already on a stored photo doesn't count. It can only replay the original result or answer 409, and it is never decoded again. A client that lost a `201` can always retry, even after reaching the limit.
- A slot is held from the moment the body starts arriving until the response is sent. That bounds memory per process to about `MEDIA_MAX_CONCURRENT_UPLOADS × (MEDIA_MAX_BYTES + decode working set)`. A slot is released on every outcome, including client disconnects. When every slot is taken, the request gets `503 UPLOADS_BUSY` with `Retry-After: 5` and spends no attempt. There is no waiting queue.

**Discover sessions** (`GET /v1/discovery`). A request without a cursor scans up to 2,000 profiles and stores a session snapshot, so each one counts, whatever its outcome (even `empty` or `403`). Requests with a cursor don't count against this limit, only against the generic request limit.

**Generic request limit.** `createAuthMiddleware` checks it right after the Firebase token is verified, keyed by the verified UID. Failed authentications don't consume it, and `/v1/catalogs` isn't authenticated, so it isn't limited. This is a coarse safety net:
- It lives in process memory. With N API processes an account can get up to N times the budget, and a restart resets it. Anything that has to hold exactly belongs in MongoDB.
- At most 10,000 accounts are tracked per process. When the map is full, the least recently seen account is dropped and starts over with a full bucket.
- `src/index.ts` installs it from config (`installRequestRateLimit`). Routers built without it, such as tests and scripts, have no generic limit. A router or test can pass its own limiter, or `null`, to `createAuthMiddleware(auth, { requestLimiter })`.

The default allows a full Discover page with its photos (around 20 requests) at once, and steady scrolling at 2 requests per second. Media reads revalidate on every display (`Cache-Control: private, no-cache`), so they count too. If pilot data shows ordinary use reaching the limit, raise the refill rate first.

## Not covered

- **Unauthenticated bursts** (bad or missing tokens, sign-in and recovery) are not limited by the API. They rely on Firebase Auth protections plus IP-level limits at the edge, which belong to hosting (not decided).
- **Slow clients.** An upload that sends its body very slowly holds a slot until it finishes, disconnects, or hits Node's request timeout (300 s by default). In production, a reverse proxy that buffers request bodies before forwarding them would close this gap.
- Message (30/min) and report (5/hour) limits wait for those features. Use `createAccountRateLimiter` with a new action name.
