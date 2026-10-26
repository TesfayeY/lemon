# Lemon App

Ethiopian and Eritrean dating app for the US community. Built with Flutter + Express/TypeScript + MongoDB + Firebase.

## Key Rules

- All confirmed decisions are in `docs/product-decisions.md`
- Build one phase at a time per `docs/progress.md`
- Never commit to `main`; each feature gets its own branch per `docs/git-workflow.md`
- Requirements map is in `docs/requirements.md`
- Never add subscriptions, AI matching, ethnicity scoring, or features marked "explicitly later"
- Keep business rules server-side; Flutter is never trusted for authorization
- Firebase Auth tokens are the sole identity; never trust client-supplied UIDs
- MongoDB owns profiles, preferences, likes, matches, quotas, safety jobs
- Firestore owns chat rooms/messages only; all writes go through Express
- Use explicit public DTO allowlists; never expose DOB, email, Firebase UID, moderation data
- No secrets in code; use environment variables
- English UI only at launch; use localization keys for all strings
- App name: Lemon (use APP_NAME constant where referenced)
