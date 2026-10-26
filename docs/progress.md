# Lemon App - Progress Tracker

## Phase Status

| Phase | Name | Status | Date |
|-------|------|--------|------|
| 00 | Decisions and acceptance map | Done | 2026-10-22 |
| 01 | Repository and local test harness | Done | 2026-10-22 |
| 02 | UI system and component gallery | Done | 2026-10-22 |
| 03 | Auth, adult gate, guarded routes | Done | 2026-10-22 |
| 04 | Profiles, preferences, public projection | In Progress (awaiting P-03) | 2026-10-25 |
| 05 | Private media and moderation foundation | Not Started | |
| 06 | Complete onboarding and profile editing | Not Started | |
| 07 | Discovery API and Flutter experience | Not Started | |
| 08 | Likes, quota, incoming-like UI | Not Started | |
| 09 | Transactional matches and outbox | Not Started | |
| 10 | Firestore rooms, access rules, provisioning | Not Started | |
| 11 | Reliable messaging and conversation UI | Not Started | |
| 12 | Block, unmatch, report with race safety | Not Started | |
| 13 | Moderation/admin workflow | Not Started | |
| 14 | Notifications and push adapter | Not Started | |
| 15 | Pause, deletion, account lifecycle | Not Started | |
| 16 | Localization, accessibility, network polish | Not Started | |
| 17 | Race testing, reconciliation, performance | Not Started | |
| 18 | Full local beta acceptance review | Not Started | |

## Current Focus

Phases 00-03 complete. Phase 04 deliverables are built and tested; it stays open until the owner answers P-03 (which sensitive fields ship at launch) and reviews the seed languages catalog. Next: Phase 05 (private media and moderation foundation).

## Toolchains Installed

- Flutter 3.47.7 (Dart 3.13.5)
- Node.js 25.9.0
- MongoDB 9.0.4 with replica set `rs0`
- Firebase CLI 15.34.1
- Express 5.3, MongoDB driver 7.7, Firebase Admin 14.5, Zod 4.6

## Phase 02 Results

### Built
- Lemon theme: ivory canvas, berry primary, copper accents, soft accent chips
- Typography: display/title/section/body/caption scale
- Spacing & radius tokens
- Core widgets: LemonButton (loading/outlined), LemonTextField (password toggle), LemonCard, PromptTile (with like), PhotoFrame (with like), state views (loading/empty/error)
- Bottom navigation: Discover, Likes, Chats, You with badge support
- App shell with tab switching

### Tests (21 passing)
- App renders nav, switches tabs
- Button: label/tap, loading/disabled, outlined variant
- TextField: label, error, password toggle
- Card: renders child
- PromptTile: question/answer, like show/hide
- State views: loading spinner, empty action, error retry
- BottomNav: all tabs, selection callback, badges
- Theme: primary color, scaffold background

## Phase 03 Results

### Built
- Firebase token verification middleware (checks revocation)
- POST /v1/me/bootstrap: idempotent Firebase→app user mapping
- GET /v1/me: private account snapshot
- PATCH /v1/me/onboarding: birth date validation with adult gate
- Adult gate: server-side DOB parsing, age calculation, leap day handling
- Account status model with guards (onboarding, active, suspended, deletion_pending, deleted)

### Tests (50 API tests passing)
- Token auth: missing, invalid, revoked, non-Bearer
- Bootstrap: new user creation, idempotent duplicate, suspended rejection, UID spoofing prevention
- Account: GET /v1/me authenticated, rejected without auth
- Onboarding: valid adult DOB, underage rejection, invalid format, future date, empty body, wrong state
- Adult gate unit: 18 tests covering birthday boundaries, leap day (Feb 29), age calculation, format validation

## Phase 04 Results

### Built
- Catalogs: states, seed cities, prompts, intentions, gender categories, languages (seed set, owner review pending)
- `PATCH /v1/me/profile`: expected-revision compare-and-set; Unicode names (1-40 grapheme clusters); catalog-checked gender, city, intention and languages; 100-grapheme limit on hometown/occupation/education/religion; per-field visibility
- `GET /v1/me/profile` (owner view incl. answers awaiting review) and `GET /v1/me/profile/preview` (exactly what others see)
- Prompt answers keep `approvedText` separate from `pendingText`: new answers and edits wait for review and never auto-publish; edits need `expectedRevision`
- `GET/PATCH /v1/me/preferences`: ages 18-99, min <= max, at least one interest, revisioned
- `GET /v1/me` returns server-computed `readiness { ready, missing }` as the resumable onboarding checklist
- Bootstrap syncs `emailVerified` from the verified token; onboarding steps re-run readiness; birth date bumps `guardVersion`
- `GET /v1/profiles/:id`: active, ready viewers only; public DTO allowlist with private fields null
- OpenAPI contract `contracts/openapi.yaml` + shared fixtures `contracts/fixtures/`
- Dart DTOs: `core/api/api_error.dart`, `core/catalogs/catalogs.dart`, `features/onboarding/data/account.dart`, `features/profile/data/{profile,preferences}.dart`
- Fictional seed profiles: `scripts/seed.sh` (8 people, refuses production, idempotent)

### Tests (146 API + 30 Flutter passing)
- Validation: Ethiopic/combining-character names at the 40-grapheme limit, whitespace-only and non-string names, unknown catalog IDs (city, gender, intention, language, prompt), text limits, heights, age bounds
- Prompts: pending on create, approved text stays published during an edit, stale edit conflict, other user's answer edit/delete denied, only published answers count toward readiness
- Two-device profile, preference and answer edits; server-owned fields ignored
- Readiness: every requirement; resumable missing list across devices
- Contract: every fixture validates against the schema; live responses for every Phase 03-04 endpoint (incl. errors) validate; leaked private field and pending text are rejected
- Dart: every fixture round-trips through its DTO; unknown readiness values tolerated; unknown visibility rejected
- Seed data passes the same validators as real edits; seed run verified against local MongoDB

### Open
- P-03: confirm which sensitive fields (religion, family plans, lifestyle) ship at launch
- Languages catalog is a proposal; needs owner review
- API route tests use an in-memory collection stand-in; real-Mongo race tests are Phase 17
- `npm run lint` has no `eslint.config.*` yet

## Total: 176 tests passing (146 API + 30 Flutter)
