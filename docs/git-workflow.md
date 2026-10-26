# Git Workflow

Lemon uses **GitHub Flow**: `main` is always releasable, and every change lands through a short-lived branch merged by pull request.

## Rules

- Never commit directly to `main`. Branch from the latest `main` for every task.
- One branch = one phase or one focused change. Don't mix unrelated work.
- Create a branch when work starts, not in advance — pre-made branches drift from `main`.
- Keep branches short-lived; rebase on `main` (`git pull --rebase origin main`) before opening a PR.
- Merge with **squash merge** so `main` has one commit per branch, then delete the branch.
- A branch merges only when API tests (`npm test` in `apps/api`), `tsc --noEmit`, and Flutter tests/analyze pass.

## Branch names

`<type>/<short-kebab-description>`, with the phase number for roadmap work.

| Type | Use for | Example |
|------|---------|---------|
| `feat/` | New phase or user-facing feature | `feat/phase-05-private-media` |
| `fix/` | Bug fix | `fix/onboarding-leap-day-age` |
| `chore/` | Tooling, deps, config | `chore/upgrade-firebase-admin` |
| `docs/` | Documentation only | `docs/api-contracts-profiles` |
| `refactor/` | Behavior-preserving code changes | `refactor/profile-dto-builder` |
| `test/` | Tests only | `test/like-quota-concurrency` |
| `hotfix/` | Urgent fix for a released build | `hotfix/chat-room-access` |

## Planned roadmap branches

Create each from `main` when its phase starts (see `docs/progress.md`):

| Phase | Branch |
|-------|--------|
| 04 | `feat/phase-04-profiles-preferences` |
| 05 | `feat/phase-05-private-media` |
| 06 | `feat/phase-06-onboarding-profile-editing` |
| 07 | `feat/phase-07-discovery` |
| 08 | `feat/phase-08-likes-quota` |
| 09 | `feat/phase-09-matches-outbox` |
| 10 | `feat/phase-10-firestore-rooms` |
| 11 | `feat/phase-11-messaging` |
| 12 | `feat/phase-12-block-unmatch-report` |
| 13 | `feat/phase-13-moderation-admin` |
| 14 | `feat/phase-14-notifications` |
| 15 | `feat/phase-15-account-lifecycle` |
| 16 | `feat/phase-16-l10n-a11y-polish` |
| 17 | `test/phase-17-race-reconciliation-perf` |
| 18 | `chore/phase-18-beta-acceptance` |

A large phase may be split into stacked sub-branches, e.g. `feat/phase-07-discovery-api` then `feat/phase-07-discovery-ui`.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/): `<type>(<scope>): <summary>` in the imperative mood.

```
feat(profiles): add public profile DTO allowlist
fix(auth): reject bootstrap for suspended accounts
test(preferences): cover age range validation
```

Scopes match modules: `auth`, `profiles`, `preferences`, `catalogs`, `media`, `discovery`, `likes`, `matches`, `chat`, `safety`, `admin`, `mobile`, `firebase`.

## Releases

Tag releases on `main` with semantic versions (`v0.1.0`, `v0.2.0`, …). Hotfixes branch from the release tag and merge back to `main`.

## Starting a task

```bash
git switch main
git pull --rebase origin main   # once a remote exists
git switch -c feat/phase-05-private-media
```
