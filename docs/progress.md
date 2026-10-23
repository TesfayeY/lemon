# Lemon App - Progress Tracker

## Phase Status

| Phase | Name | Status | Date |
|-------|------|--------|------|
| 00 | Decisions and acceptance map | Done | 2026-10-22 |
| 01 | Repository and local test harness | Done | 2026-10-22 |
| 02 | UI system and component gallery | Done | 2026-10-22 |
| 03 | Auth, adult gate, guarded routes | Done | 2026-10-22 |
| 04 | Profiles, preferences, public projection | Not Started | |
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

Phases 00-03 complete. Next: Phase 04 (profiles, preferences, public projection).

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

## Total: 71 tests passing (50 API + 21 Flutter)
