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
| `GET /v1/media/:assetId/:variant` | Streams `thumb` or `display`. Re-checks on every request: viewer is the owner, **or** the asset is `approved` and the owner is `active` + `profileReady`, and the viewer is active + ready. Originals and quarantine are never served. No permanent public URLs. |
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

_Not started._
