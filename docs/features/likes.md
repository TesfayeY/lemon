# Feature: Content likes (server)

**Branch:** `feat/likes` (from `main`)
**Roadmap:** Phase 08 in `docs/progress.md` (server side; the Flutter composer and Likes screen are separate)
**Spec:** `docs/specification.md` §4.4, §4.5, §6 (`likes`, `quotas`), §7
**Requirements:** R-LIKE-01, R-LIKE-02, R-LIKE-03, R-LIKE-04
**Decision:** P-10 in `docs/product-decisions.md` (8 new likes per UTC day). The owner still has to confirm it, so the number comes from config.
**Builds on:** `docs/features/likes-quota.md` (the quota module)

## Files

- `apps/api/src/modules/likes/`: `schema.ts` (document shape), `validation.ts` (body, comment, cursor), `service.ts` (send, decline, list), `dto.ts` (allowlisted responses), `pair-guard.ts` (block/pair hook), `routes.ts`, `index.ts`. `quota.ts` is unchanged.
- `apps/api/test/likes.test.ts`: 48 tests, all against the real local MongoDB replica set.
- `contracts/openapi.yaml`: the likes paths, the `LikeError` response and the `Like*` schemas.
- Shared files (small additive edits): `src/index.ts` (route registration), `src/indexes.ts` (likes indexes plus `ensureQuotaIndexes`), `src/config.ts` and `.env.example` (`LIKES_PER_UTC_DAY`).

## Endpoints

All of these need `Authorization: Bearer <Firebase ID token>`. The sender and recipient always come from the token. User IDs in a request body are ignored.

| Endpoint | Behavior |
| --- | --- |
| `POST /v1/likes` | Body `{ toUserId, target: { kind: 'photo' \| 'prompt', id, contentVersion }, comment? }` plus an `Idempotency-Key` header. Returns `201 { like, quota }`, or `200` with the original like when the same key and payload are retried. |
| `GET /v1/likes/quota` | `{ limit, used, remaining, resetAt }` for the composer. `resetAt` is the next UTC midnight. |
| `GET /v1/likes/incoming?cursor=&limit=` | Pending likes from senders who are currently available, newest first. Uses an opaque keyset cursor in `meta.nextCursor`. |
| `POST /v1/likes/:id/decline` | Recipient only. Idempotent and terminal. Charges nothing. |
| `POST /v1/likes/:id/accept` | Recipient only. Returns `501 ACCEPT_NOT_AVAILABLE` until Phase 09 and creates nothing. Incoming items carry `canAccept: false`. |

Errors use `{ error: { code, message, retryable, ... }, requestId }`:

| Status | Codes |
| --- | --- |
| 400 | `IDEMPOTENCY_KEY_REQUIRED`, `INVALID_CURSOR` |
| 403 | `ACCOUNT_NOT_ELIGIBLE` (sender or viewer not active and ready), `ACCOUNT_PAUSED` (paused sender), `ACCOUNT_RESTRICTED` |
| 404 | `PROFILE_UNAVAILABLE` (recipient missing, inactive, unready, paused or blocked; all identical), `LIKE_NOT_FOUND`, `NOT_FOUND` (no account) |
| 409 | `TARGET_STALE` (version mismatch), `TARGET_UNAVAILABLE` (unknown, not owned by the recipient, unpublished, rejected or deleted), `ALREADY_LIKED`, `INCOMING_LIKE_PENDING`, `IDEMPOTENCY_KEY_REUSED`, `LIKE_ALREADY_DECIDED` |
| 422 | `VALIDATION_ERROR` (`fieldErrors`), `SELF_LIKE` |
| 429 | `QUOTA_EXHAUSTED` with `limit`, `resetAt` and a `Retry-After` header |
| 501 | `ACCEPT_NOT_AVAILABLE` |

## Data (shared contract, also read by discovery)

Collection `likes`: `{ _id, fromUserId, toUserId, target: { kind, id, contentVersion }, comment?, contextSnapshot, state: 'pending' | 'declined' | 'accepted', idempotencyKey, createdAt, updatedAt, decidedAt? }`.

Indexes, created in `src/indexes.ts`:

- unique `{ fromUserId: 1, toUserId: 1 }`: one like per direction ever in v1
- unique `{ fromUserId: 1, idempotencyKey: 1 }`
- `{ toUserId: 1, state: 1, createdAt: -1 }`: the incoming list

`contextSnapshot` is `{ kind: 'photo', width, height }` or `{ kind: 'prompt', promptId, promptText, answerText }`. It holds only the recipient's own published content. It never holds storage keys, media URLs or moderation data.

## How sending works

1. Check the Idempotency-Key format, then the body. Unknown fields are stripped.
2. If the sender already used this key, return the original like (`200`) when the payload matches, or `409 IDEMPOTENCY_KEY_REUSED` when it doesn't. A replay works even after the target changed or the allowance ran out.
3. Sender checks: active, profile-ready and not paused. A self like is rejected.
4. One MongoDB transaction (snapshot reads, majority writes):
   - the recipient is active, ready and not paused
   - `pairGuard.check` passes
   - the target belongs to the recipient, is published (an approved photo, or a prompt answer with `approvedText`), and its version matches
   - there is no existing like in this direction and no pending like in the other direction
   - `consumeLikeQuota(..., session)` succeeds
   - insert the like
   - `pairGuard.touch`
5. Every rejection throws inside the transaction, so nothing is charged. A failure after the charge rolls the charge back (tested). Concurrent charges conflict and the driver retries them. The callback re-reads everything, including the idempotency key, on each retry. A duplicate-key error from a committed competitor is resolved to a replay or `ALREADY_LIKED`.

Comments are NFC-normalized and whitespace-collapsed, then checked against 200 grapheme clusters with `Intl.Segmenter`. That means an emoji ZWJ sequence, a flag or a letter with combining marks counts as one. A blank comment becomes no comment. A raw cap of 4000 UTF-16 code units rejects combining-mark floods before segmentation.

## Incoming list

- Pending likes only. Senders who are paused, inactive, unready or refused by `pairGuard.check` are hidden but stay stored, so a sender who resumes reappears.
- Pagination is keyset on `(createdAt desc, _id desc)`. Each request scans at most 200 likes while skipping hidden senders. The cursor marks the last scanned like, so hidden likes never cause skips or repeats. A page can be short, so keep paging until `nextCursor` is `null`.
- Each item has a sender summary (`userId, displayName, age, cityName, stateCode, photo`, where photo is the first approved photo through the public photo allowlist), the target, the rendered context, `targetChanged`, the comment, `createdAt` and `canAccept`.
- Context rules:
  - The photo is still approved at the liked version: media paths are included and `targetChanged` is false.
  - The photo was removed, rejected or changed: `media: null`, `targetChanged: true`. The client shows "This profile item changed".
  - The prompt answer is still published at the liked version: snapshot text, unchanged.
  - The prompt answer was edited and republished: the liked words from the snapshot, `targetChanged: true`.
  - The prompt answer was deleted or unpublished: `answerText: null`, `targetChanged: true`.
- A paused recipient can still review and decline. Viewing requires an active, ready account (R-AUTH-08).

## Decisions and assumptions (please review)

- **P-10 (open):** the allowance is `LIKES_PER_UTC_DAY` (default 8). `QUOTA_POLICY_VERSION` is fixed at 1 in `routes.ts`. Bump it if the meaning of the policy changes.
- **Recipient availability** uses the fields that exist today: `users.accountStatus === 'active'`, `profileReady` and `!discoverPaused`. There is no pause endpoint until Phase 15, so `discoverPaused` is only set by tests and seeds for now.
- **Unknown body fields are ignored, not rejected.** This matches the profile and media routes and the Phase 08 "body UID spoof ignored" test. §7's "reject unknown fields" is read as applying to privileged and admin DTOs.
- **Error choices:** a stale version is `409 TARGET_STALE`. Every other unusable target, including a target owned by someone else, is `409 TARGET_UNAVAILABLE`, so a sender can't probe other users' content IDs. Blocks look exactly like any other unavailable profile (`404 PROFILE_UNAVAILABLE`).
- **Reverse pending like:** if the recipient already has a pending like to the sender, sending one back returns `409 INCOMING_LIKE_PENDING` ("answer their like in Likes") and charges nothing. The recipient's availability is checked first, so this can't reveal a hidden like. A declined like in the other direction doesn't block a new like.
- **No decline leak:** the sender's DTO has no state, and a second like to someone who declined returns the same `ALREADY_LIKED` as any duplicate.
- **Accept** returns `501` instead of pretending to work. Other users get `404`, so the endpoint can't be used to probe like IDs.
- **Context snapshot** stores the recipient's own published prompt text so they recognize the like after edits. Removed content is never rendered. Phase 15 deletion must purge `likes` for both directions.
- **Incoming cursor** is unsigned base64url JSON. It is only applied inside the caller's own list (the query always filters on `toUserId`), so forging one reveals nothing. Ties on `createdAt` are broken by `_id`. The contract index has no `_id`, so ties are sorted in memory. That's fine at pilot volumes. Measure in Phase 17.

## Gaps for other agents

- **Prompt `contentVersion` is not in the public profile DTO yet.** `PromptAnswerDTO` (profiles module) exposes `id, promptId, promptText, text` but not `publishedRevision`. For a client to like a prompt it must send `contentVersion = publishedRevision`. The discovery card DTO should include it, and `GET /v1/profiles/:id` needs it too. That's a small additive change in the profiles module plus its contract, which this branch doesn't own. Photos already expose `contentVersion`.
- The read checks inside the send transaction (recipient, target) don't write to those documents. So a photo deleted, or a user paused, in the same instant can still race a like. Phase 09's pair write and guardVersion checks are the place to close this if needed.

## Follow-ups

**Phase 09 (matches):**

- Implement `PairGuard.touch` as a write to the canonical pair record (`pairKey` = sorted member IDs) in the send and decline transactions. Then opposite likes, accept and decline conflict and retry. Make `check` refuse matched or closed pairs.
- Replace the `INCOMING_LIKE_PENDING` rejection with mutual-like matching. Simultaneous opposite likes must create exactly one match. Today two concurrent opposite likes can both be stored as pending.
- `POST /v1/likes/:id/accept`: recipient only, idempotent, in one transaction. Compare-and-set the like `pending → accepted` with `decidedAt`, touch the pair, create the match and outbox event, and set `canAccept`. It must not consume quota. `declineLike` already compare-and-sets on `pending` and returns `LIKE_ALREADY_DECIDED` against an accepted like.

**Phase 12 (safety):** `PairGuard.check` returns `{ ok: false, reason: 'blocked' }` for either-direction blocks, terminal unmatches and report hides. Sends then get `PROFILE_UNAVAILABLE` and the senders disappear from incoming lists automatically.

**Phase 15 (lifecycle):** a pause endpoint that sets `discoverPaused`. Account deletion purges likes and quotas.
