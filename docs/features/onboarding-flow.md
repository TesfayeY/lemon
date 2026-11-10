# Feature: Onboarding flow and editable profile (Flutter)

**Branch:** `feat/onboarding-flow`
**Roadmap:** Phase 06 in `docs/progress.md` (complete onboarding and editable profile UI)
**Spec:** `docs/specification.md` §3 (visual direction, navigation, screen inventory, copy), §4.1–4.3, Phase 06 prompt
**Contract:** `contracts/openapi.yaml`, `contracts/openapi/media.yaml`, `contracts/fixtures/`

## Status

Done on the Flutter side, wired to the real API through a typed client. The
server's review service decides when photos and prompt answers are approved,
so a brand-new profile only becomes ready after a person reviews its content
(`scripts/review-photos.ts` for photos; prompt review has no tool yet, see
gaps).

## What was built

### Typed API client (`lib/core/api/`)

- `LemonApiClient`: bootstrap, `GET /v1/me`, `PATCH /v1/me/onboarding`,
  catalogs, own profile, preview, prompt answers, preferences, photo list,
  multipart upload with `Idempotency-Key`, reorder, delete, and authenticated
  media URLs.
- The Firebase ID token in `Authorization` is the only identity. No request
  carries a user ID. A 401 retries once with a force-refreshed token.
- Failures are typed: `ApiException` (contract error body), `NetworkException`
  (offline/timeout), `NotSignedInException`, `MalformedResponseException`.
  `describeFailure` maps them to localized copy; server messages are never
  shown.
- Edits send only changed fields (`changedFields`) plus `expectedRevision`.
- `IdTokenSource` abstracts sign-in. `EmulatorPasswordTokenSource` (dev only)
  signs in against the Firebase Auth emulator REST API; `StaticIdTokenSource`
  takes a token. The Firebase Auth SDK replaces both when sign-in screens land.

### Screens

| Screen | Notes |
| --- | --- |
| App gate | Bootstraps, reads `GET /v1/me`, routes by `accountStatus`: onboarding → flow, active → shell, restricted/deleting → explanation. Signed-out and offline states. |
| Onboarding shell | "Step N of M" title with progress bar, back button (and system back), one step per screen. Resumes at the earliest step whose requirement the server reports missing. |
| Verify email | Only shown while `emailVerified` is missing. Refreshes the token, re-bootstraps, re-checks. |
| Adult gate | Date picker in text-entry mode, adult-only message, privacy note. Local checks for empty/future/under-18 for instant feedback; the server's `AGE_INELIGIBLE` always wins. Sends a date-only `YYYY-MM-DD`. Respectful ineligible screen. |
| Before you join | Audience statement (D-02), respect note, terms checkbox, draft-legal-text note. |
| The basics | First name (grapheme-counted, 40 max), gender from catalog with "show on profile", relationship intention. |
| Location | Search over catalog US cities only, shown as "Seattle, WA"; same-named cities stay distinct; "unknown city" help. No free text, no country picker. |
| Preferences | Interests (multi-select, at least one), age range 18–99, scope city/state/nationwide with explanations and the mutual-scope note, long distance with "doesn't widen where matches live". |
| Photos | Ordered grid (2 columns at large text or narrow screens, 3 otherwise), states processing / in review / approved / not approved with icon + label, upload with retry using the same idempotency key, reorder via an accessible options menu, remove with a below-minimum warning, rejected photos with localized reason and Replace (upload new, then remove rejected). Continue needs 3 non-rejected photos. |
| Prompts | Three slots. Approved text, pending submission ("Waiting for review"), "current answer stays on your profile until the new one is reviewed", rejected with respectful copy and "Write a new answer". Picker with search and category chips, already-answered prompts left out, server `DUPLICATE_PROMPT` explained. |
| More about you | Optional bio, hometown, work, education, height (ft/in with cm), languages, each with "show on my profile". Sensitive fields behind the P-03 flag. Skippable. |
| Readiness | Rendered from `readiness.ready/missing` only. Ready → "Start exploring". Not ready → each missing item with a "Fix" jump, review-time note, "Check again". |
| You tab | Name, city, server visibility status with missing items, paused note, links to preview and every edit section. |
| Edit screens | The same forms and editors as onboarding, with "Save". |
| Profile preview | `GET /v1/me/profile/preview` plus approved photos, in a `PublicProfileView` Discover can reuse. Private fields and pending content are absent. |

### Revision conflicts

`RevisionedFormHost` runs every profile and preferences save through
`saveWithConflictRecovery`: on `409 REVISION_CONFLICT` it reloads from the
server and asks **Keep my edits** (resend only the changed fields on the new
revision) or **Use latest version** (discard local edits, reload the form,
show a snackbar). Prompt replacements use the same helper. A stale photo
reorder refreshes the grid and says so.

### Localization and accessibility

- `flutter_localizations` + `lib/l10n/app_en.arb` (English only). Generated
  code goes to `lib/l10n/generated/` on `flutter pub get` and is gitignored.
- Every user-facing string, tooltip and semantics label is a key. The brand
  comes from `appName` (`APP_NAME` dart-define, default "Lemon").
- Errors are live regions; states use icon + text; headers are marked; all
  pages scroll; tested at 200% text on a 360×690 phone and against the
  tap-target, labeled-target and contrast guidelines.

## Assumptions and open decisions

- **P-03 (sensitive fields):** religion is the only sensitive field the API
  has. It is built but hidden behind `AppConfig.showSensitiveFields`
  (`--dart-define=LEMON_SHOW_SENSITIVE_FIELDS=true`), default **off**. When
  off, the form never sends religion. Family plans and lifestyle need API
  fields first.
- **P-09 (eligibility wording):** no eligibility or self-identification copy
  was invented. "Before you join" states only the confirmed audience (D-02).
  Replace `termsAudience` once the owner picks the wording.
- **Legal text:** no final terms exist; the step says so (`termsDraftNote`).
- **P-02:** the birth date is self-declared and labeled as private; nothing
  claims verification.
- **Sign-in:** Phase 03 shipped the API side only; there are no Flutter sign-in
  screens. Until they exist the app runs with a dev token source.
- Photos and prompt answers that are pending count as "submitted" for the
  Continue buttons (UX only). Readiness is always the server's answer.

## API and contract gaps found

Not changed here; listed for the owners of `apps/api` and `contracts/`.

1. **Prompt rejection reason missing.** `SelfPromptAnswer` has no
   `rejectionReason` (photos do). The client shows one generic respectful
   message. There is also no prompt review service or dev script, so prompts
   can only reach `approved`/`rejected` by editing the database.
2. **Public profile has no photos.** `PublicProfile` omits photos
   (`PublicPhoto` exists in `media.yaml` "once profiles embed photos"). The
   preview stitches in approved photos from `GET /v1/me/photos`; Discover will
   need them in the projection.
3. **No shared media fixtures.** `contracts/fixtures/` has no photo list or
   upload response, so the Dart DTOs are checked against a mobile-only
   fixture (`apps/mobile/test/fixtures/photos.json`).
4. **Error codes not enumerated in `openapi.yaml`:** `AGE_INELIGIBLE`,
   `PROMPT_LIMIT`, `CONCURRENT_EDIT`, `INVALID_STATE`, `NO_UPDATES`,
   `ACCOUNT_RESTRICTED`, `ACCOUNT_NOT_ELIGIBLE`, `PROFILE_UNAVAILABLE` are sent
   by the API but only a few appear as examples.
5. **Terms version and documents.** The server hardcodes terms version `1.0`
   and there is no endpoint for the current version or document links, so the
   client cannot show "what you agreed to".
6. **Gender self-description.** The spec calls for an optional
   self-description next to the gender catalog; `ProfileUpdate` has no field.
7. **Replacing a photo keeps no position.** There is no replace endpoint; a
   replacement is upload + delete and lands at the end of the order.
8. **`GET /v1/me` before bootstrap** answers `403 ACCOUNT_RESTRICTED` rather
   than `404 NOT_FOUND`; the client always bootstraps first, but the code is
   misleading.
9. Contract fixture `self-profile.json` lists language `english`, which the
   catalog fixture lacks (the live catalog has it). The client keeps unknown
   catalog IDs when saving.

## Running locally

```bash
cd apps/mobile
flutter run \
  --dart-define=LEMON_API_BASE_URL=http://localhost:3000 \
  --dart-define=LEMON_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
  --dart-define=LEMON_DEV_EMAIL=someone@example.test \
  --dart-define=LEMON_DEV_PASSWORD=...
```

Android emulators reach the host at `10.0.2.2`. Approve photos with
`scripts/review-photos.ts`.

## Tests

- `test/core/lemon_api_client_test.dart`: request shapes, token handling,
  401 refresh, contract fixtures, 409/422/415, offline, malformed bodies,
  emulator token caching.
- `test/features/domain_test.dart`: adult gate (boundary, leap day, future),
  resume mapping, grapheme limits, photo fixture round-trip.
- `test/features/onboarding/onboarding_widgets_test.dart`: adult gate, terms,
  required fields, server field errors, city search, preferences, readiness.
- `test/features/profile/editing_test.dart`: You status, conflict keep/use
  latest (profile and preferences), preview hides private and pending
  content, P-03 flag.
- `test/features/profile/review_editors_test.dart`: photo states, replace,
  upload/retry with one key, unsupported format, reorder, stale reorder,
  removal below minimum, prompt states, replace rejected, duplicates, empty
  answer, removal.
- `test/journey/onboarding_journey_test.dart`: full happy path to the app
  only after approval, restart midway, back navigation, failed save.
- `test/l10n/localization_test.dart`, `test/accessibility/large_text_test.dart`.
- `integration_test/onboarding_journey_test.dart`: the happy path on a device
  or desktop against the in-memory backend.

## Follow-ups

- Flutter sign-in, verification and recovery screens with the Firebase Auth
  SDK, replacing the dev token source.
- Integration journey against the real Express API + Auth emulator once a
  seeded test account and a prompt review tool exist.
- Persist unsent drafts on device across app restarts (today unsent edits
  live in memory; every completed step is saved server-side).
- Photo crop before upload and upload progress (the multipart client does not
  report progress).
- Wire the shared `PublicProfileView` into Discover (Phase 07).
- Native-review an Ethiopic-capable font before any Amharic work.
