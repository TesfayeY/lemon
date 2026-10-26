# Feature brief: Chat rooms (Firestore access)

**Branch:** `feat/chat-rooms` (from `main`)
**Roadmap:** Phase 10 in `docs/progress.md`
**Spec:** `docs/specification.md` "Firestore documents" table and the Phase 10 prompt
**Requirements:** R-CHAT-01, R-CHAT-02

## Files this feature owns

- `firebase/**` (rules, indexes, emulator config, rules tests, the `@lemon/firebase` test package)
- `scripts/test-firebase-rules.sh`
- `docs/features/chat-rooms.md`

Later, room provisioning will add `apps/api/src/modules/chat/**` and `apps/api/src/adapters/firestore/**`. Until then, this branch touches nothing under `apps/`.

## Done on this branch

- Deny-by-default rules. Clients can read a room, its messages and their own read state only when:
  - the room is `active`
  - the room has exactly two distinct participant UIDs
  - the reader is one of them
  - **both** participants' `chatAccess` documents exist with `enabled == true`
- Every client write is denied. Listing `rooms` is denied: clients attach listeners to explicit room IDs returned by Express. The bounded message history query (`orderBy sequence desc, limit 30`) is allowed for members.
- 24 rules tests using `@firebase/rules-unit-testing` against the emulator. They cover anonymous, nonmember, disabled participant (self or other), missing access doc, closed/provisioning rooms, malformed participant shapes, read-state isolation, listener queries and every client write.

Run them with `scripts/test-firebase-rules.sh`. This needs a Java runtime; on macOS, run `brew install openjdk@21`.

## Remaining (blocked on `feat/matches`)

- Express provisioning: create-only active room per match, closed tombstones that prevent later creation, reconciliation that can't reopen terminal states.
- Backend authorization tests that don't rely on rules, since Admin SDK writes bypass them.
- Emulator integration tests: duplicate provisioning, tombstone before creation, dependency outage, reversed stale events.
