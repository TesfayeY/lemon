# Lemon App - Progress Tracker

## Phase Status

| Phase | Name | Status | Date |
|-------|------|--------|------|
| 00 | Decisions and acceptance map | Done | 2026-10-22 |
| 01 | Repository and local test harness | Done (API only) | 2026-10-22 |
| 02 | UI system and component gallery | Not Started | |
| 03 | Auth, adult gate, guarded routes | Not Started | |
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

Phase 01 complete for API side. Flutter scaffold pending toolchain install.

## Phase 01 Results

### What was built
- Express/TypeScript API with strict compiler config
- Environment validation (Zod) with fail-fast on invalid config
- Health endpoint (`GET /health`) — always responds
- Readiness endpoint (`GET /ready`) — checks MongoDB + Firebase
- Request ID middleware (from header or auto-generated UUID)
- 404 handler for unknown routes with standard error envelope
- MongoDB connection module with ping check
- Firebase Admin SDK initialization (emulator-aware)
- Firestore security rules (deny-by-default, chat room structure)
- Firebase emulator configuration (Auth port 9099, Firestore port 8080)
- Vitest test harness with env overrides

### Tests (14 passing)
- Health: returns 200/ok, respects request ID header
- Readiness: 200 when healthy, 503 when MongoDB down, 503 when Firebase down, 503 when check throws
- Unknown routes: 404 with NOT_FOUND code for GET and POST
- Config: loads valid config, throws on missing MONGO_URI, missing FIREBASE_PROJECT_ID, invalid NODE_ENV, coerces PORT, defaults PORT

### Missing Toolchains
- **Flutter**: Not installed. Needed for Phase 02+. Install: https://docs.flutter.dev/get-started/install/macos
- **MongoDB**: Not installed locally. Needed for integration tests. Install: `brew install mongodb-community` or use Docker
- MongoDB replica set required for transaction tests (Phase 03+)

## Notes

- Building incrementally, one phase at a time
- Each phase produces working code with tests before moving on
- Express 5.3.0, MongoDB driver 7.7, Firebase Admin 14.5, Zod 4.6
