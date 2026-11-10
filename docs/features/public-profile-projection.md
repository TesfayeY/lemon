# Feature: Public profile projection and contract fixes

**Branch:** `fix/public-profile-projection`
**Spec:** `docs/specification.md` §4.2 (fields, public DTO), §4.3 (approved photos only), §4.4 (discovery rules), §4.5 (likes target versions), §7 (`GET /v1/profiles/:id`, errors)
**Contract:** `contracts/openapi.yaml`, `contracts/openapi/media.yaml`, `contracts/fixtures/`
**Fixes:** "API and contract gaps" 2, 3, 4, 6, 8 and 9 in the onboarding flow brief (`feat/onboarding-flow`)

## What changed

### One public projection

`profiles/dto.ts` owns what other people see. `toPublicProfileDTO` filters
its own inputs, so a caller that passes too much can't leak anything:

- **Photos:** only the owner's `approved` photos, ordered by `order` and
  capped at 6, as `{ id, order, width, height, contentVersion, media }`.
  `media` holds the authenticated `/v1/media/{id}/{thumb|display}` paths. Storage
  keys, idempotency keys and review data are never included, and neither are
  pending, rejected, processing, failed or deleted photos.
- **Prompt answers:** only published text (`approvedText`), in slot order,
  with `contentVersion` set to the answer's `publishedRevision`. The likes
  service checks prompt likes against this value. A pending edit leaves both
  the text and the version unchanged. Publishing a new revision bumps both.
- `loadPublicProfiles(db, ids)` builds projections in four batched reads.
  `GET /v1/profiles/:id`, `GET /v1/me/profile/preview` and every Discover card
  use it.

**Discover card shape change:** a card is now `{ profile }` (it used to be
`{ profile, photos }`). Photos live in `profile.photos`, so the contract has
one `PublicPhoto` schema (renamed from `DiscoveryPhoto`).

### Contextual access for `GET /v1/profiles/:id`

The route gets a `ProfileAccess` from the discovery service
(`canViewProfile`). `src/index.ts` builds one discovery service and shares
it with the discovery routes.

| Viewer → target | Result |
| --- | --- |
| Own profile | 200, the same projection as the preview (any status that can sign in) |
| Viewer not active and ready | 403 `ACCOUNT_NOT_ELIGIBLE` |
| Target discoverable right now (`isDiscoverable`: every discovery rule) | 200 |
| Target has a pending like to the viewer; sender is active, ready, not paused and not pair-excluded | 200 (the Likes list needs it; preferences are not rechecked) |
| Anyone else: missing, inactive, unready, paused, passed, blocked, outside filters, already liked by the viewer | 404 `PROFILE_UNAVAILABLE`, byte-for-byte the same as an unknown ID |

### Gender self-description (owner-only)

- `PATCH /v1/me/profile` accepts `genderSelfDescription`: string or null, at
  most 100 grapheme clusters after whitespace normalization. Blank clears it.
- `GET /v1/me/profile` returns it.
- It is **not** in the public projection, whatever `genderDisplay` says. §4.3
  calls for manual text review in the pilot, and free text about identity
  shouldn't go public before a review path exists.
- Discovery never reads it (it is outside the participant projection), and it
  doesn't bump `guardVersion`. The catalog `genderIdentity` stays the only
  matching category.

### `GET /v1/me` before bootstrap

It now answers 404 `NOT_FOUND`, like every other own-resource route. Before,
it answered 403 `ACCOUNT_RESTRICTED`, which still applies to suspended and
deleting accounts.

### Contract accuracy

- New `ErrorCode` enum lists every code the API sends: profiles, auth,
  discovery, media, and likes (PR #12). `ErrorResponse.error.code` references
  it. `contract.test.ts` scans `src/` and fails when a sent code is missing.
- `GET /v1/me` documents 403 and 404. `GET /v1/profiles/{id}` documents its
  access rules.
- New fixtures, registered in `contract.test.ts`: `photos.json`
  (`GET /v1/me/photos`, validated against `media.yaml`) and `photo-upload.json`
  (`POST /v1/me/photos` 201). `public-profile.json` now has photos and
  `contentVersion`. `self-profile.json` now has `genderSelfDescription`.
- `catalogs.json` now has `english` and `prompt-sunday`. A test checks that
  every catalog ID the profile fixtures use is in the catalog fixture.

## Tests

- `test/public-profile.test.ts` (real MongoDB, isolated `lemon_test_public_profile_*` database, dropped afterwards):
  - Approved, ordered photos only, and `contentVersion` equals `publishedRevision`.
  - Leak checks: no DOB, UID, storage keys, moderation data, pending text or self-description.
  - The Discover card equals the profile read, which equals the preview.
  - `contentVersion` bumps only when a revision is published.
  - 404s identical to a missing profile for every non-discoverable case.
  - Self is always visible.
  - Pending likers are visible; paused, blocked and declined likers are not.
  - The self-description never changes discoverability.
- `test/profiles.test.ts`:
  - Exact key allowlist at every DTO level.
  - Photo filtering, ordering and the cap of 6.
  - Answer versioning through the preview.
  - Self-description validation, privacy and no guard bump.
- `test/contract.test.ts`:
  - The new fixtures and the catalog-ID consistency check.
  - Leak guards on photos, the self-description and `contentVersion`.
  - Error-code drift detection.
  - Live checks: `/v1/me` 404, profile photos, self view.
- `test/auth-routes.test.ts`: `/v1/me` 404 before bootstrap and 403 for a suspended account.
- `test/discovery.test.ts`: the card is `{ profile }`, with photos inside the profile.

## Follow-ups and open questions

- **Flutter DTOs:** `apps/mobile/test/contracts/fixtures_test.dart` round-trips
  fixtures exactly. It needs these additions before it passes again:
  - `PublicProfile.photos` and `PromptAnswer.contentVersion`
  - `SelfProfile.genderSelfDescription`
  - the Discover card is now `{ profile }`

  The preview no longer needs to stitch in photos from `GET /v1/me/photos`.
- **Matches (Phase 09):** matched pairs are pair-excluded from Discover, so
  `canViewProfile` must allow them once matches exist (TODO in the discovery service).
- **Outgoing likes:** a person the viewer liked is no longer discoverable, so
  their profile now answers 404 to the viewer. Should a "sent likes" view or a
  post-like screen keep access?
- **Declined likes:** someone whose like the viewer declined stays visible
  until discovery hides them (PR #14).
- **Media route:** `GET /v1/media/:id/:variant` still lets any active, ready
  viewer read any approved photo by ID. It doesn't apply the discoverability
  recheck. IDs are unguessable UUIDs, but tightening it is a media-module decision.
- **Self-description publication:** once text review exists, decide whether it
  follows `genderDisplay` and goes through the same pending/approved split as prompt answers.
- **Error codes:** new codes (for example from admin moderation) must be added to
  `ErrorCode`, or the drift test fails.
