# Git Workflow

Lemon uses **GitHub Flow**: `main` is always releasable, and every change lands through a short-lived branch merged by pull request.

## Rules

- Never commit directly to `main`. Branch from the latest `main` for every task.
- One branch = one feature or one focused change. Don't mix unrelated work.
- Create a branch when work starts, not in advance — pre-made branches drift from `main`.
- Keep branches short-lived; rebase on `main` (`git pull --rebase origin main`) before opening a PR.
- Merge with **squash merge** so `main` has one commit per branch, then delete the branch.
- A branch merges only when API tests (`npm test` in `apps/api`), `tsc --noEmit`, and Flutter tests/analyze pass.

## Branch names

`<type>/<short-kebab-feature-name>`. Name the feature, never the phase number.

| Type | Use for | Example |
|------|---------|---------|
| `feat/` | New user-facing feature | `feat/photo-uploads` |
| `fix/` | Bug fix | `fix/onboarding-leap-day-age` |
| `chore/` | Tooling, deps, config | `chore/upgrade-firebase-admin` |
| `docs/` | Documentation only | `docs/api-contracts-profiles` |
| `refactor/` | Behavior-preserving code changes | `refactor/profile-dto-builder` |
| `test/` | Tests only | `test/like-quota-concurrency` |
| `hotfix/` | Urgent fix for a released build | `hotfix/chat-room-access` |

## Feature branches

Branches are named for the **feature**, not the roadmap phase. A phase in `docs/progress.md` may span several feature branches, and one feature branch may finish work across phases. Create each from `main` when work on it starts:

| Feature | Branch |
|---------|--------|
| Profiles, prompts, preferences, catalogs | `feat/profiles-preferences` |
| Photo upload and private media | `feat/photo-uploads` |
| Photo and content moderation queue | `feat/content-moderation` |
| Onboarding flow (Flutter) | `feat/onboarding-flow` |
| Profile editing (Flutter) | `feat/profile-editing` |
| Discovery feed | `feat/discovery` |
| Likes and daily quota | `feat/likes` |
| Matches | `feat/matches` |
| Chat rooms and messaging | `feat/chat` |
| Block, unmatch, report | `feat/safety-actions` |
| Admin moderation tools | `feat/admin-moderation` |
| Push notifications | `feat/notifications` |
| Pause and account deletion | `feat/account-lifecycle` |
| Localization and accessibility | `feat/localization-accessibility` |
| Race and performance tests | `test/race-conditions` |

Split a large feature into smaller branches that each merge on their own, e.g. `feat/discovery-api` then `feat/discovery-ui`.

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
git switch -c feat/photo-uploads
```
