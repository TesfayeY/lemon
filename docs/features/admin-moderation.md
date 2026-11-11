# Feature brief: Audited moderation and admin review

**Branch:** `feat/admin-moderation`
**Roadmap:** Phase 13 foundation in `docs/progress.md` (reports and blocks are Phase 12 and not built yet)
**Spec:** `docs/specification.md` §4.3, §4.7, §4.9, §6–7 and the Phase 13 prompt
**Requirements:** R-ADMIN-01, R-ADMIN-03, R-ADMIN-04, R-ADMIN-05 (R-ADMIN-02, the report queue, waits for Phase 12)

## Done

- **Staff identity.** A staff member is identified only by the `staffRole` custom claim (`moderator` or `admin`) in a Firebase ID token. The Admin SDK verifies the token on every `/v1/admin` route, including the revocation and disabled-account checks. Only an exact known role string counts; `admin: true`, `role`, `roles`, `'Admin'` and arrays are all ignored. Request bodies, headers and query strings are never read for identity or role, and there is no email allowlist. Staff tokens must also have a verified email.
- **Separate permissions (spec §4.9).** Moderators get `content.review`. Admins also get `account.manage` and `audit.read`.
- **Recent sign-in** is required for suspend and restore. `auth_time` must be within `ADMIN_RECENT_AUTH_MAX_AGE_SECONDS` (default 900).
- **Review queues.** Pending photos are listed oldest upload first. Pending prompt answers are listed oldest submission first, and an owner edit moves the answer to the back. Both use keyset pagination on `(submittedAt, id)`, so deciding an item already listed doesn't shift later pages.
- **Item detail** gives only what a reviewer needs: the item, the owner's app user ID, display name and account status, and for photos, the owner's other current photos. It never includes DOB, email or Firebase UID.
- **Quarantine media.** Pending photos are streamed through a staff-only route with `Cache-Control: private, no-store`. Only the metadata-free `thumb`/`display` variants are served, never the private master. Deleted, failed and processing photos return 404.
- **Decisions.** Each decision is one Mongo transaction. It compare-and-sets the target on the state/version the reviewer acted on and appends one `adminAuditLog` entry. When reviewers race, one wins and the others get `409 REVIEW_CONFLICT` and write nothing. If the transaction aborts for any reason, including after the audit insert, neither the decision nor the entry survives. Readiness and photo-set follow-ups run after commit through `recomputeReadiness` and `finishPhotoDecision`.
  - **Photos** reuse `media/review-service.ts`. It is now split into `applyPhotoDecision` (session-aware CAS) and `finishPhotoDecision`. `reviewPhoto` keeps its old behavior for the dev script.
  - **Prompt answers** use the new `profiles/prompt-review.ts`, a CAS on `state: 'pending'` plus the `expectedRevision` the reviewer saw.
    - Approve publishes `pendingText` and increments `publishedRevision`.
    - Reject keeps any previously approved text live and stores a catalog `rejectionReason`.
    - If the owner edits during review, the decision gets 409 with `currentRevision`, so text the reviewer never saw is never published.
- **Owner prompt DTO** (`GET /v1/me/profile`): `rejectionReason: { code, messageKey, message, action: 'replace' }` appears only while the answer is rejected. Replacing the text resubmits it and hides the old reason. The public DTO is unchanged and never carries it.
- **Suspend and restore** (spec Phase 13 lists them):
  - Each runs in one transaction: a CAS on account status plus `guardVersion`, a `guardVersion` increment, and the audit entry.
  - Suspension stops new actions immediately: `/v1/me` returns 403, the profile is unavailable and photos aren't served. Readiness is recomputed and cleared.
  - Restore returns the account to its previous status (`active` or `onboarding`) and recomputes readiness. It reopens nothing else.
  - Staff can't act on their own account or content (`SELF_ACTION_FORBIDDEN`).
- **Audit log** (`adminAuditLog`, append-only by service contract: the module exposes append and per-target reads only). Each entry records actor UID and role, action, target type/id/owner, catalog reason, optional internal note, before/after state, request ID and timestamp. Entries never carry tokens, emails, DOB or answer text; prompt decisions store a SHA-256 of the decided text instead. IDs are UUIDv7, so entries with the same timestamp still list in insertion order.

### Endpoints

| Endpoint | Role | Notes |
|----------|------|-------|
| `GET /v1/admin/me` | moderator | Verified role and permissions |
| `GET /v1/admin/reasons` | moderator | All reason catalogs |
| `GET /v1/admin/content/photos?cursor&limit` | moderator | Pending queue, `limit` 1–50 (default 20) |
| `GET /v1/admin/content/photos/:id` | moderator | Review detail |
| `GET /v1/admin/content/photos/:id/media/:variant` | moderator | `thumb` or `display`, any reviewable state |
| `POST /v1/admin/content/photos/:id/review` | moderator | `{ decision, reason?, note? }` |
| `GET /v1/admin/content/prompt-answers?cursor&limit` | moderator | Pending queue |
| `GET /v1/admin/content/prompt-answers/:id` | moderator | Published and pending text |
| `POST /v1/admin/content/prompt-answers/:id/review` | moderator | `{ decision, expectedRevision, reason?, note? }` |
| `GET /v1/admin/users/:id` | admin | Account summary |
| `POST /v1/admin/users/:id/suspend` | admin + recent sign-in | `{ reason, note? }` |
| `POST /v1/admin/users/:id/restore` | admin + recent sign-in | `{ reason, note? }` |
| `GET /v1/admin/audit-log?targetType&targetId` | admin | One target's history; no bulk export |

All are in `contracts/openapi.yaml`, and the tests validate live responses against it. Request bodies are strict: unknown fields get 422.

### Error codes the admin API sends

New codes: `STAFF_ONLY`, `STAFF_EMAIL_UNVERIFIED`, `INSUFFICIENT_ROLE`, `RECENT_AUTH_REQUIRED` and `SELF_ACTION_FORBIDDEN` (all 403), plus `REVIEW_CONFLICT` and `ACCOUNT_STATE_CONFLICT` (both 409).
Codes that already exist: `UNAUTHENTICATED`, `TOKEN_REVOKED`, `NOT_FOUND`, `VALIDATION_ERROR`, `INVALID_CURSOR`, `MEDIA_UNAVAILABLE`, `STORAGE_UNAVAILABLE`.
Once PR #16's `ErrorCode` enum is on `main`, the new codes must be added to it.

## Reason catalogs

| Catalog | Codes | Shown to |
|---------|-------|----------|
| Photo rejection (existing, `media/review-service.ts`) | `face_not_clear`, `multiple_people`, `low_quality`, `contact_details`, `community_guidelines` | Owner |
| Prompt rejection (`profiles/prompt-review.ts`) | `contact_details`, `sexual_content`, `hateful_or_harassing`, `promotional`, `community_guidelines`; localization keys `promptRejection.*` | Owner |
| Account suspension | `harassment`, `scam_or_spam`, `impersonation`, `underage_concern`, `hateful_conduct`, `community_guidelines` | Staff only |
| Account restore | `appeal_upheld`, `decision_error`, `concern_resolved` | Staff only |

The copy is proposed. It needs owner review, and native review if Amharic is added later. Mobile needs `promptRejection.*` localization keys; until then it can fall back to `message`.

## Granting a staff claim locally

The Auth emulator must be running (`scripts/start-emulators.sh`). Run these from `apps/api`:

```bash
# Create a fictional emulator account and grant a role (password via env, not argv)
LEMON_STAFF_PASSWORD='choose-a-local-password' \
  npx tsx --env-file=.env ../../scripts/admin-claims.ts grant mod@lemon.test moderator --create
npx tsx --env-file=.env ../../scripts/admin-claims.ts grant admin@lemon.test admin
npx tsx --env-file=.env ../../scripts/admin-claims.ts show mod@lemon.test
# Revoke: removes the claim and revokes refresh tokens, so old tokens fail with TOKEN_REVOKED
npx tsx --env-file=.env ../../scripts/admin-claims.ts revoke mod@lemon.test
```

The script refuses to run when `NODE_ENV=production` or when `FIREBASE_AUTH_EMULATOR_HOST` is unset. Claims take effect on the next sign-in.

Review from the terminal (`scripts/admin-review.ts`, which talks to the API):

```bash
export LEMON_STAFF_EMAIL=mod@lemon.test LEMON_STAFF_PASSWORD='…' FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099
npx tsx ../../scripts/admin-review.ts photos
npx tsx ../../scripts/admin-review.ts photo <id> --save /tmp/photo.webp
npx tsx ../../scripts/admin-review.ts reject-photo <id> --reason low_quality
npx tsx ../../scripts/admin-review.ts prompts
npx tsx ../../scripts/admin-review.ts approve-prompt <id> --revision <n>
```

## Verification

- `scripts/check-api.sh` passes: typecheck, lint, 400 tests (354 existing + 46 new).
- `test/admin.test.ts` has 40 tests against the real local replica set in an isolated `lemon_test_admin_<pid>_<ts>` database, dropped afterwards. It covers:
  - Every admin route against: no token, forged token, revoked token, member token, five look-alike claims, and role hints in body, header or query.
  - Moderator versus admin access, recent sign-in, unverified staff email, and self-action.
  - Queue order and stable paging.
  - Publishing and readiness, rejection visibility for the owner and public, and stale revisions.
  - Races: 5 rounds each for photos and prompts, plus owner-edit-versus-review and suspension races.
  - Rollback when the audit write fails, and when the transaction aborts after the audit write.
  - Log redaction, quarantine media access, and suspend/restore.
- The whole file ran 6+ times in a row green after fixing a same-millisecond ordering bug (now UUIDv7). Mutation check: moving the audit insert out of the transaction makes the abort test fail.
- `test/admin-units.test.ts` has 6 unit tests: claim parsing, cursors, the prompt rejection catalog, and owner vs public DTO.
- Manual end-to-end run with the real Auth emulator and the API:
  - Both scripts created staff and granted claims.
  - A member got `STAFF_ONLY`.
  - A moderator rejected a prompt through the CLI. A second decision got 409, and a moderator got `INSUFFICIENT_ROLE` on a user lookup.
  - The owner saw the reason, and the admin read the audit entry.
  - After revoke, the old token got `TOKEN_REVOKED` and a fresh token got `STAFF_ONLY`.

## Decisions (please confirm)

- **Claim name `staffRole`** with values `moderator` and `admin`. The spec asks for separate moderator and admin permissions but doesn't name a claim.
- **Audit collection `adminAuditLog`** holds only verified staff actions. The dev-only `scripts/review-photos.ts` still writes its old `auditLog` entries with a free-form actor. I suggest retiring that script in favor of `admin-review.ts` so there's a single trail.
- **Recent sign-in** is required for account actions only, not content review. "Evidence access" belongs to the Phase 12 report evidence.
- **Readiness follow-ups run after commit.** `recomputeReadiness` and the photo-set bump take no session, so a crash between commit and follow-up leaves readiness stale until the next recompute, which is idempotent.
- **Approving a prompt doesn't bump the owner's edit `revision`**, only `publishedRevision`.

## Open questions

- **P-08 (moderation staffing):** who reviews at launch, in which languages, and with what response times. Nothing here invents staffing.
- **Admin UI:** the spec suggests an internal Flutter admin route or build, but D-03 rules out a public web client and this phase builds no mobile admin UI. For now: the API plus `scripts/admin-review.ts`. Owner to choose a separate internal Flutter build, an internal web tool, or the CLI for the pilot.
- **Suspension copy:** what a suspended member sees. Today `/v1/me` returns `ACCOUNT_RESTRICTED` (403).

## Follow-ups

- **Phase 12:** the report queue and case workflow (new → assigned → in review → resolved/dismissed, case revisions, restricted evidence access with recent sign-in). These reuse `requireStaff`, `appendAuditEntry` and the queue cursor. Suspension should also be callable from a case.
- **Phase 12/13:** route suspension through the durable safety-operation protocol: revoke Firestore `chatAccess`, close rooms, revoke or disable Firebase Auth sessions, and handle "suspension racing send/accept" once matches and chat exist. The account guard bump is already in place for those CAS checks.
- **Phase 13:** synthetic staff fixtures in the seed script. Today `admin-claims.ts --create` does this on demand. Also an optional `If-Match`-style `expectedGuardVersion` on account actions.
- **Phase 15:** deletion must erase or anonymize `adminAuditLog` references according to P-06, keeping only what the retention policy allows.
- **Rate limiting** on staff routes, and an alert on unusual decision volume.
- **Mobile:** `promptRejection.*` localization keys and the "replace answer" flow. The DTO already carries `action: 'replace'`.
