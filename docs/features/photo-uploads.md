# Feature brief: Photo uploads and private media

**Branch:** `feat/photo-uploads` (stacked on `feat/profiles-preferences`; rebase onto `main` once that merges)
**Roadmap:** Phase 05 in `docs/progress.md`
**Spec:** `docs/specification.md` §4.3 "Photos and text moderation", the `photos` row of the data model, and the Phase 05 prompt
**Requirements:** R-MEDIA-01 … R-MEDIA-05 in `docs/requirements.md`

Read `CLAUDE.md`, `docs/product-decisions.md` and `docs/git-workflow.md` before starting.

## Goal

A person uploads 3–6 photos. The server validates and strips them, holds them in private quarantine, a reviewer approves or rejects them, and only approved display variants are streamed to other eligible users through an authenticated endpoint. Approved photos count toward profile readiness.

## Scope

### Endpoints

| Endpoint | Behavior |
|----------|----------|
| `POST /v1/me/photos` | Authenticated multipart upload, one image, max 10 MB (configurable). Server-generated asset ID and object path. Idempotent on a client `Idempotency-Key` header so retries don't create duplicates. Max 6 non-rejected photos per user. Returns `{ id, state: "pending", order, revision }`. |
| `GET /v1/me/photos` | Owner's photos with state (`processing`, `pending`, `approved`, `rejected` + respectful `rejectionReason`), order, and the photo-set `revision`. |
| `PATCH /v1/me/photos/order` | Body `{ expectedRevision, photoIds: [...] }`. Must list exactly the owner's current non-rejected photo IDs. Compare-and-set on revision; `409 REVISION_CONFLICT` with `currentRevision`. |
| `DELETE /v1/me/photos/:id` | Owner only (`404` for anyone else). Removes access immediately, schedules object cleanup, recomputes readiness. |
| `GET /v1/media/:assetId/:variant` | Streams `thumb` or `display`. Re-checks on every request: viewer is the owner, **or** the asset is `approved`, the owner is `active` + `profileReady`, the viewer is active + ready, and the viewer may see the owner's profile (`canViewProfile`, the same check as `GET /v1/profiles/:id`). Originals and quarantine are never served. No permanent public URLs. |
| Review service (no admin UI) | `reviewPhoto(photoId, decision, reason, actorId)` in the module, plus a dev-only script `scripts/review-photos.ts` to approve/reject. Records actor, target, reason, before/after state and timestamp in an `auditLog` collection. **Do not auto-approve.** |

### Processing

- Decode the actual bytes. Accept JPEG, PNG, WebP. Respond `415 UNSUPPORTED_MEDIA_TYPE` with a clear message for HEIC/HEIF, GIF and anything else. Never trust the client MIME type or the file extension.
- Reject corrupt files, fake MIME types, extreme dimensions (proposed: min 320 px short side, max 8000 px long side, max 40 megapixels) and decompression bombs.
- Normalize orientation, strip **all** EXIF/XMP/IPTC metadata (GPS included), and re-encode.
- Produce `thumb` (e.g. 320 px) and `display` (e.g. 1080 px) variants.
- If any step fails, delete the partial objects. Orphans get removed by a retryable cleanup worker in `apps/api/src/workers/`.
- Never fetch remote URLs.

### Storage

Product decision **P-04 (media storage) is still open**. Build against a `MediaStorage` interface in `apps/api/src/adapters/media/` (`putObject`, `getObjectStream`, `deleteObject`, keyed by server-owned paths such as `quarantine/<ownerId>/<assetId>` and `public-variants/<assetId>/<variant>`). Ship:
- `LocalMediaStorage`, writing to a gitignored directory set by the `MEDIA_LOCAL_DIR` env var
- `InMemoryMediaStorage` for tests

Do **not** wire Firebase Storage until P-04 is approved. Leave a stub with a TODO.

### Mongo `photos` collection

`_id`, `ownerId`, `state`, `originalPrivateKey`, `variantKeys`, `width`, `height`, `order`, `contentVersion` (used by likes later), `moderationReason`, `idempotencyKey`, `createdAt`, `updatedAt`. Keep the per-user photo-set `revision` on a small `photoSets` document keyed by `ownerId`.

## Files you own (create freely)

- `apps/api/src/modules/media/**`
- `apps/api/src/adapters/media/**`
- `apps/api/src/workers/media-cleanup.ts`
- `apps/api/test/media*.test.ts` and `apps/api/test/fixtures/images/**` (fictional or generated images only, including one JPEG with GPS EXIF)
- `contracts/openapi/media.yaml`
- `scripts/review-photos.ts`
- `docs/features/photo-uploads.md` (this file: keep the status section updated)

## Shared files: touch only the lines listed

Another agent is finishing profiles/preferences in parallel and owns `apps/api/src/modules/profiles/**`, `apps/api/src/modules/preferences/**`, `apps/api/src/modules/catalogs/**`, `apps/api/test/profiles.test.ts`, `contracts/openapi/profiles.yaml`, `apps/mobile/**`, `scripts/seed*` and `docs/progress.md`. **Do not edit those**, except for the one line below.

| File | Allowed change |
|------|----------------|
| `apps/api/src/modules/profiles/readiness-service.ts` | Replace only the `approvedPhotos: 0, // Photos not yet implemented — Phase 05` line with a count of the owner's `approved` photos. |
| `apps/api/src/index.ts` | Add one import and one `createMediaRoutes(...)` entry to the `routes` array. |
| `apps/api/src/indexes.ts` | Append `photos` indexes (`{ ownerId: 1, state: 1, order: 1 }` and unique `{ ownerId: 1, idempotencyKey: 1 }`, sparse/partial) to the `Promise.all` list. |
| `apps/api/src/config.ts` | Add `MEDIA_MAX_BYTES` (default 10 MB) and `MEDIA_LOCAL_DIR`. |
| `apps/api/.env.example`, `apps/api/.env.test` | Add the two variables above. |
| `apps/api/package.json` / lockfile | Add an image library (e.g. `sharp`) and a multipart parser (e.g. `multer` or `busboy`). Pin exact versions. |
| `.gitignore` | Ignore the local media directory. |

If you need any other change outside your owned files, stop and note it under "Status" instead of editing.

## Tests first

Follow the patterns in `apps/api/test/profiles.test.ts` (in-memory Db fake plus supertest), but write your own helpers in your own test file. Cover:
- oversized input, fake MIME type, corrupt image, extreme dimensions and HEIC handling
- EXIF GPS removed from stored variants (read the variant back and assert there's no metadata)
- upload failure deletes partial objects; a duplicate retry with the same `Idempotency-Key` returns the same photo
- wrong owner on delete/reorder; quarantine and originals never served; pending/rejected/deleted assets denied to others; a viewer who isn't active and ready is denied
- reorder with a stale revision returns 409; reorder with missing or extra IDs returns 422
- approving the 3rd photo (with everything else complete) makes the profile ready; deleting one drops readiness
- review writes an audit log entry; nothing auto-approves

## Definition of done

- A fictional photo can be uploaded, reviewed and streamed as an approved variant. Private originals and pending content are inaccessible to other users.
- `npx tsc --noEmit` and `npm test` pass in `apps/api`.
- `contracts/openapi/media.yaml` describes every endpoint and error code.
- A PR is opened into `main` (or into `feat/profiles-preferences` if that hasn't merged yet) using Conventional Commits, e.g. `feat(media): …`.

## Status

**Implemented, pending review** (2026-10-26). Rebased onto `main` after #4 merged profiles/preferences. `tsc --noEmit` and `npm test` pass (195 tests, 73 of them new in `test/media.test.ts` and `test/media-processing.test.ts`), and every file this branch adds or changes passes `oxlint --deny-warnings`. Also checked end to end against the local MongoDB replica set with `LocalMediaStorage`, the real `scripts/review-photos.ts` and the cleanup worker. Firebase token verification was stubbed for that run because the Firebase CLI wasn't on PATH.

### Decisions made inside the brief (please confirm)

- `Idempotency-Key` is **required** on upload (`400 IDEMPOTENCY_KEY_REQUIRED`). Same key + same bytes → `200` with the original photo. Same key + different bytes → `409 IDEMPOTENCY_KEY_REUSED`.
- The raw upload is never stored. The quarantine object (`originalPrivateKey`) is the orientation-normalized, metadata-free full-size re-encode, so GPS never reaches disk.
- The private master is JPEG (quality 90). The served `thumb` and `display` variants are **WebP**, which is smaller than JPEG at similar quality and decoded natively by Flutter (AVIF would need a plugin). Transparent PNGs are flattened onto white. Variants are fit-inside without upscaling: `thumb` ≤ 320×640, `display` ≤ 1080×2160. Animated images get a 415.
- The 6-photo limit holds under concurrency without transactions: insert as `processing`, then compare-and-set the `photoSets.revision`; losers roll back and recount. Uploads, deletes, rejections and failed uploads all bump the revision.
- Deleting keeps a `deleted` tombstone (objects purged, `objectsPurgedAt` set). That way a stale retry can't resurrect the photo, and likes can later show "This profile item changed". Failed uploads are removed entirely once their objects are purged.
- Owners can view their own `pending`/`rejected` photos (needed for the editor). Others only see `approved` photos, and only while both owner and viewer are `active` + `profileReady`.
- Media responses use `Cache-Control: private, no-cache` plus an `ETag`. A `304` is returned only after the access check passes, so revocation is immediate.
- Rejection reason codes: `face_not_clear`, `multiple_people`, `low_quality`, `contact_details`, `community_guidelines`. The API returns `{ code, message }`, and Flutter should map `code` to a localization key.

### Needs a change outside this brief's files (not made)

1. ~~**Run the cleanup worker.**~~ Done in `fix/api-hardening`: the worker entry point `src/worker.ts` (D-06) runs the cleanup every minute. See "Running the cleanup worker" below. Delete still purges objects inline; the worker catches storage failures and uploads left in `processing` by a crash, which would otherwise hold one of the owner's 6 photo slots for good.
2. **Index for worker queries.** The cleanup scans `{ state, objectsPurgedAt }` and `{ state, createdAt }`, which the allowed `{ ownerId, state, order }` index doesn't cover. Suggest adding `photos: { state: 1, objectsPurgedAt: 1 }` before data grows.
3. **Profiles integration (profiles owner).** `toPublicPhotoDTO()` is ready for the public profile and preview DTOs. Load only `approved` photos sorted by `order`.

### Follow-ups (out of scope here)

- ~~Upload rate limit~~ Done in `fix/rate-limits`: 10 upload attempts per hour per account (MongoDB counter) and at most 4 uploads decoding at once per process, both checked before the body is read. See `docs/features/rate-limits.md`.
- Phase 15 (account deletion): erase the user's `photos` records, including `deleted` ones (metadata only, no images), plus `photoSets` and any remaining objects. Retention period depends on P-06.
- Phase 13: write the review state change and its `auditLog` entry in one Mongo transaction, and move review behind the role-checked admin API.
- P-04 is still open: `FirebaseMediaStorage` is a stub that throws.
- Pre-existing on `main`: `npm run lint` fails on two unused imports in profiles-owned files (`findCity` in `src/modules/profiles/validation.ts`, `beforeEach` in `test/profiles.test.ts`). Not touched here because the profiles owner owns them. Also, `tsconfig.json` doesn't cover `test/` or `scripts/`.

### Using it locally

```bash
cd apps/api
npx tsx --env-file=.env ../../scripts/review-photos.ts list            # pending photos + local file to view
npx tsx --env-file=.env ../../scripts/review-photos.ts approve <id> --actor <you>
npx tsx --env-file=.env ../../scripts/review-photos.ts reject <id> --actor <you> --reason low_quality
npx tsx --env-file=.env src/worker.ts --once                           # one cleanup pass, then exit
```

### Running the cleanup worker

`src/worker.ts` is the background worker entry point: a separate process next to the API, with the same environment (`MONGO_URI`, `MONGO_DB_NAME`, `MEDIA_LOCAL_DIR`, ...). It runs `runMediaCleanup()` once at startup and then one minute after each pass finishes, so passes never overlap. Each pass expires uploads stuck in `processing` for over 15 minutes, which frees the slot and the `Idempotency-Key`, and purges the objects of failed and deleted photos.

```bash
cd apps/api
npm run worker                  # development, via tsx (export the env first, as for `npm run dev`)
npm run build && npm run start:worker    # production: node dist/worker.js
npm run worker -- --once        # a single pass, then exit (non-zero if it failed), e.g. from cron
```

On `SIGINT` or `SIGTERM` the worker starts no new pass, lets the running one finish, closes MongoDB and exits 0. A second signal exits at once. Every step is idempotent, so a forced stop only delays cleanup to the next pass. Run one worker per environment. A second one is safe (updates are compare-and-set) but does nothing useful. While media uses `LocalMediaStorage` (P-04 is open), the worker must see the same `MEDIA_LOCAL_DIR` as the API: same machine or a shared volume. Logs show counts only, and only for passes that changed something.
