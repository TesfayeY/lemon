# Product Decisions

Last updated: 2026-11-10

## Confirmed Decisions

| # | Decision | Choice | Date |
|---|----------|--------|------|
| D-01 | App name | Lemon | 2026-10-22 |
| D-02 | Launch audience | English-speaking Ethiopians and Eritreans living in the United States | 2026-10-19 |
| D-03 | Platform | Flutter mobile for iOS and Android; no public web client | 2026-10-19 |
| D-04 | Launch UI language | English only; Amharic possible later, not in launch scope | 2026-10-19 |
| D-05 | Stack | Flutter + Express/TypeScript + MongoDB + Firebase Auth + Cloud Firestore chat | 2026-10-19 |
| D-06 | Architecture | Modular monolith; one Express app + worker entry point | 2026-10-19 |
| D-07 | Sign-in method | Email/password with Firebase Auth verification and recovery | 2026-10-19 |
| D-08 | Location mode | City-based discovery (US cities/states); no GPS required at launch | 2026-10-19 |
| D-09 | Chat backend | Cloud Firestore for rooms/messages; Express authorizes all writes | 2026-10-19 |
| D-10 | Declined likers in Discover | A person whose like you declined never returns to your Discover. Pending likers are hidden too; they appear in Likes instead | 2026-11-10 |
| D-11 | Sent likes | No "sent likes" list. After you like someone, their profile is unavailable to you until you match (Phase 09). This matches the major dating apps and keeps who-liked-whom private until it's mutual | 2026-11-10 |
| D-12 | Photo access | Another member's photos load only while their profile is viewable to you (`canViewProfile`, the same check as `GET /v1/profiles/:id`), rechecked on every request | 2026-11-10 |

## Pending Decisions (Owner Input Needed)

| # | Decision | Proposal | Blocks Phase | Question for Owner |
|---|----------|----------|--------------|-------------------|
| P-01 | Brand assets | Placeholder "Lemon" branding for dev | 02 | Final logo, wordmark, app icon? |
| P-02 | Age assurance policy | Self-declared DOB with server-side adult gate; not identity verification | 03 | Acceptable for pilot? Separate launch assurance needed? |
| P-03 | Sensitive fields | Optional religion, family plans, lifestyle with per-field visibility | 04 | Which fields to include at launch? |
| P-04 | Media storage | Firebase Storage adapter proposed | 05 | Approve Firebase Storage or alternative? |
| P-05 | Push notifications | Firebase Cloud Messaging proposed | 14 | Approve FCM? |
| P-06 | Retention/deletion policy | Remove user data; retain only report evidence under bounded policy | 15 | Exact retention periods and scope? |
| P-07 | Launch metro areas | Configurable US city catalog; no specific metros chosen | 07 | Which cities/metros for pilot? |
| P-08 | Moderation staffing | Manual photo/text review for pilot | 13 | Who reviews content at launch? |
| P-09 | Eligibility wording | Community self-identification; no proof required | 03 | Exact onboarding copy for community connection? |
| P-10 | Like allowance | 8 new likes per UTC day | 08 | Acceptable pilot limit? |

## Out of Scope (Do Not Build)

- Subscriptions, paid tiers, boosts
- AI matching or compatibility scoring
- Video calls, voice notes, photo messages
- Social feeds, events
- Identity/age verification badges
- Contact imports
- Ethnicity scoring or inference
- Travel mode
- Microservices, Redis, Elasticsearch, GraphQL, vector DB, LLM
- Hosting, deployment, production infrastructure
