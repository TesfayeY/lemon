# Ethiopian and Eritrean dating app: product, design, engineering, and agent implementation plan

Prepared 19 October 2026. Status: proposed specification for review and incremental implementation. No application code has been built or tested as part of this planning document.

## 1. Product direction and decisions to confirm

Build an adult dating app for English-speaking Ethiopians and Eritreans living in the United States, centered on intentional introductions, rich profiles, and conversations that start from something specific. The client is a cross-platform Flutter mobile app for iOS and Android. English is the launch UI language; Amharic is a possible later addition, not part of launch scope. A person can like a photo or prompt, add a comment, match when interest is mutual, and chat privately. Use these familiar interaction patterns with original branding, copy, layouts, and assets.

The confirmed stack is **Flutter + Express + MongoDB + Firebase Authentication and chat**. Hosting, infrastructure vendors, domains, deployment, production sizing, and production infrastructure configuration are outside this plan. Firebase services remain part of the requested application architecture. Local development and test environments are included.

### Decisions that remain open

Audience, mobile platforms, and launch language are confirmed. Record them in `docs/product-decisions.md` and do not ask for them again. Other choices below remain proposals for owner review. The agent may scaffold configurable interfaces while those choices are pending.

| Decision | Confirmed choice or proposal | What it changes |
| --- | --- | --- |
| Launch audience | **Confirmed:** English-speaking Ethiopians and Eritreans living in the United States | US city/state catalog, US-only discovery and inclusive community copy |
| Platform | **Confirmed:** Flutter mobile for iOS and Android | Native setup and QA on both platforms; no public web client in launch scope |
| Eligibility | Adults within the confirmed Ethiopian and Eritrean US audience; exact self-identification and invitation wording needs owner input | Onboarding and community policy; never infer identity from photos, names, language or citizenship |
| Launch UI languages | **Confirmed:** English at launch, localization structure immediately | English UI does not restrict names or profile answers to Latin characters |
| Additional languages | **Confirmed future possibility:** Amharic only if needed later | No launch translation workload; keep stable localization keys and native-review requirements for later |
| Sign in | Verified email and password initially | Recovery and verification UX; phone, Google, and Apple are separate decisions |
| Brand | Name and logo remain unset | Use `APP_NAME` and neutral development branding until selected |
| Distance | City based discovery first; optional approximate distance later | GPS permissions, geospatial data, privacy |
| Sensitive fields | Optional religion, family plans, and relationship intentions, with visibility controls | Consent, discovery filters and sensitive data handling |
| Age assurance | Self declared date of birth and adult gate for development | This is not identity or age verification; choose a launch assurance policy before public release |
| Media storage | Firebase Storage adapter is proposed | An extra Firebase service; confirm before wiring a real account. Local fake remains available |
| Push | Firebase Cloud Messaging adapter is proposed | Device permissions and native setup; app still works with in-app notifications |
| Moderation | Minimal local admin interface plus human review workflow | Staffing, language coverage, response process and public launch readiness |

Do not silently add subscriptions, paid filters, identity verification, contact imports, AI matching, ethnicity scoring, video calls, or social feeds.

### Product principles

1. Give people enough context to start a thoughtful conversation.
2. Let people describe their Ethiopian or Eritrean background and connection in their own words. Never require proof of ancestry or immigration status.
3. Keep sensitive information optional and control its visibility.
4. Keep matching understandable: no fabricated compatibility percentages.
5. Make reporting, blocking, unmatching, pausing, and deleting easy to find.
6. Work well on slow connections and modest phones.
7. Prefer a small usable community over a feed full of irrelevant distant profiles.

## 2. Scope: first usable release and later expansion

### First usable release

| Area | Included behavior | Acceptance summary |
| --- | --- | --- |
| Accounts | Sign up, sign in, email verification, recovery, sign out | Identity comes from verified Firebase token; incomplete users cannot browse |
| Onboarding | Adult gate, identity, dating interests, location, photos, prompts, preferences, terms | Progress resumes; required fields are validated on the server |
| Profile | Three to six photos, three prompts, basic details, preview, editing | A profile cannot go live without valid approved content |
| Discover | One vertically scrolling profile at a time, photo/prompt likes, pass, filter sheet | Only mutually eligible active adults appear |
| Likes | Incoming likes with context, accept, decline, outgoing like state | Duplicate likes and self likes are prevented |
| Matches | Mutual likes or explicit acceptance; match list | Exactly one match per pair; chat opens only after authorization is provisioned |
| Chat | Text, real-time messages, history, read state, local pending state, retry | Only participants in active rooms can receive messages; server authorizes sends |
| Notifications | In-app activity list; optional push integration | Push is a hint; canonical state comes from server |
| Safety | Block, report, unmatch, account suspension, photo/prompt moderation | Safety actions remove access and cannot be undone by stale jobs |
| Settings | Preferences, pause discovery, notifications, account deletion | Private fields stay private; deletion has visible job state |
| Admin | Report queue, evidence, photo review, suspend/restore, audit log | Staff access is server checked; access to evidence is audited |
| Quality | Accessibility, localized string structure, slow-network states | Complete core journey without gestures, with text scaling and screen readers |

### Explicitly later

Voice notes, video profiles, calls, photo messages, reactions, presence, typing indicators, disappearing messages, social feeds, events, paid tiers, boosts, AI icebreakers, travel mode, compatibility questionnaires, paid identity providers, verified badges, contact blocking, and recommendation ML. Keep seams for these without implementing empty services for all of them.

### Pilot focus

Choose launch communities with the owner. A small beta should test whether onboarding is understandable, enough mutually eligible profiles exist, people send meaningful likes, and matches lead to replies. Do not invent a national launch date or active user count.

## 3. Fresh visual direction

### Personality

Warm, calm, contemporary, and intentional. Large photography and readable prompt answers carry the screen. References to Ethiopian and Eritrean communities appear through restrained woven-line accents, thoughtful community prompts, and warm colors. Neither community is one language, religion, region, political identity, or lifestyle. Avoid national-flag shorthand and political symbolism in core UI; invite feedback from people in both communities. Do not copy Hinge's exact UI, illustrations, wording, or brand assets.

### Proposed design tokens

| Token | Proposed value | Usage |
| --- | --- | --- |
| Canvas | `#FBF7F1` | Warm ivory app background |
| Surface | `#FFFFFF` | Cards, sheets, inputs |
| Main text | `#251C19` | Headings and body copy |
| Secondary text | `#675A54` | Captions; verify contrast at final size |
| Primary | `#6F263D` | Deep berry actions and selected states |
| Primary on color | `#FFFFFF` | Button text; verify contrast |
| Accent | `#B98046` | Decorative copper detail, not small text |
| Soft accent | `#EFE3D4` | Chips and prompt backgrounds |
| Success | `#24624D` | Clear confirmed feedback |
| Error | `#A52B35` | Validation plus text/icon, never color alone |
| Spacing | 4, 8, 12, 16, 24, 32, 40 | Consistent layout rhythm |
| Radius | 12 inputs, 20 cards, 28 sheets | Soft edges without excessive pill shapes |
| Touch target | At least 48 logical pixels | Every interactive control |
| Typography | 32 display, 26 title, 20 section, 16 body, 14 caption | Scale with accessibility settings |
| Motion | About 150–220 ms | Short transitions; honor reduced motion |

Use a bundled licensed typeface with script coverage confirmed for every enabled language. A proposed Latin display serif may appear in headings, with a simple sans serif for body text. For Ethiopic languages, use a reviewed compatible font family such as a Noto Ethiopic variant. Avoid decorative fonts for long text. Keep copy in localization resources, including accessibility labels, date formats, plurals, and error messages.

### Navigation

Four bottom destinations: **Discover**, **Likes**, **Chats**, **You**. Each has a text label and icon. Badges communicate unseen items and have accessible names. Settings live inside You. No social feed in the first release.

### Screen inventory and behavior

| Screen | Content and interaction | Required states |
| --- | --- | --- |
| Welcome | Original wordmark placeholder, one inclusive photo composition, short value statement, create/sign-in actions | Offline, reduced motion, legal links |
| Authentication | Email, password, visibility toggle, recovery; explain verification | Invalid field, loading, account recovery, verification pending |
| Adult gate | Date picker, clear adult-only message, privacy note | Birthday boundary, invalid future date, ineligible age |
| Onboarding shell | Back, step heading, labeled progress, save and continue | Draft restored, unsaved step, server error |
| Location | US state and city search; no GPS requirement for initial city mode | Unknown city, denied permission if later GPS is enabled |
| Photo editor | Ordered 3–6 photo grid; crop, replace, remove, upload progress | Draft, uploading, processing, approved, rejected, retry |
| Prompt picker | Category tabs, searchable prompt catalog, preview before choosing | Duplicate prompt, long text, empty answer |
| Profile preview | Exact discover presentation of self, with edit shortcuts | Private fields absent, pending content explained |
| Discover | Header, filters, full profile scroll, fixed pass action; like button at each photo/prompt | Loading skeleton, card ready, submitting, no results, offline, retry |
| Like composer | Selected content excerpt, optional comment, remaining allowance, submit | Too long, target changed, quota exhausted, retry |
| Incoming likes | Unblurred cards in first release; who liked which item and their comment | Empty, loading, unavailable sender, accept/decline in progress |
| Match reveal | Two photo crops, restrained animation, “You both wanted to connect” | Chat provisioning, ready, retry; no forced celebration |
| Chats inbox | New connections section, latest conversation list, unread state | Empty, loading, room closing, deleted/unavailable user |
| Conversation | Name, menu, bubbles, timestamps, input, send state | Sending, sent, read if enabled, failed, offline, closed |
| You | Own profile, completeness, preview/edit, pause status, settings | Draft, pending moderation, active, paused, suspended |
| Preferences | Age range, interests, US city/state scope, long-distance interest | No results explanation; hard limits never relaxed silently |
| Safety menu | Report, block, unmatch as distinct actions | Confirmation, explanation, processing, completion |
| Report form | Reason, optional text, selected evidence, optional block | Submit pending, success, recoverable failure |
| Settings | Notifications, privacy controls, legal pages, export request if implemented, delete | Permission denied, recent sign-in required, deletion status |
| Admin | Queue, case details, evidence, reasoned actions, audit trail | Unauthorized, no cases, processing, stale case version |

### Discover layout in detail

Use a spacious top bar with the app name, Discover label, and filters. The first image occupies roughly half a normal phone viewport, while large text scaling may push content naturally downward. Below it: first name and age, city/state, a relationship intention chip, then alternating prompt answers and photos. Give each photo or prompt its own labeled heart action. Show optional facts in small readable rows rather than a dense wall of icons.

The bottom pass action is easy to reach and clearly labeled. Do not place a second ambiguous global heart next to item hearts. If a global like is later added, specify what content it targets. Scrolling should not trigger a pass. Likes require a deliberate tap and a composer confirmation. Show the next profile only after the result is confirmed, or after a deliberate optimistic action with exact rollback.

### Cultural prompt ideas

- “A tradition I would love to share with you…”
- “My ideal Sunday looks like…”
- “A place that feels like home…”
- “Something my family taught me…”
- “The song I always come back to…”
- “A small thing that makes me feel cared for…”
- “A part of my background I would love to share…”
- “A conversation I could have for hours…”
- “A first date I would enjoy…”
- “Something I am learning about myself…”

Make cultural prompts optional within a broader catalog. Do not require a religious, political, regional, or cultural answer. Store stable prompt IDs independently of translated text.

### Copy examples

Empty Discover: “You have seen everyone who fits these preferences for now.” Actions: Review preferences, Try again later. Offline send: “You are offline. Your draft is saved on this device.” Pending match: “Your connection is ready. We are setting up your chat.” Failed upload: “This photo did not finish uploading. Try again.” Do not falsely report a message, like, block, or deletion as completed.

## 4. Detailed feature rules

### 4.1 Account and adult gate

Use Firebase Authentication as the sole password and sign-in authority. Express verifies Firebase ID tokens with the Admin SDK. Never store passwords in MongoDB or trust an actor UID sent in a request body. A Firebase identity maps to exactly one app user through a unique `firebaseUid` index.

Recommended first auth method is email/password with verification and password recovery, pending the owner's choice. Verification occurs through Firebase, not a client Boolean. Check verification and account status on protected endpoints. Require recent authentication for deletion and other sensitive account changes. Enforce token revocation on these operations and on staff access. Never treat normal token signature verification alone as proof that a disabled user is still authorized.

The backend calculates adult eligibility from a validated birth date, not from an age field supplied by the client. Define a calendar policy, including 29 February birthdays, before implementing it. A development proposal is ISO Gregorian birth dates and a server UTC day boundary. Date of birth is private; age is calculated for public views. Date changes after activation go through a controlled support flow. Age self declaration is not a verified-age badge. Confirm launch assurance separately.

Accounts: `onboarding`, `active`, `suspended`, `deletion_pending`, `deleted`. Discovery pause is a separate field. Pending, suspended and deleting users cannot enter discovery, like, or send new messages. Email verification, moderation, and profile readiness are separate facts rather than more overlapping account statuses.

### 4.2 Onboarding and profile fields

Save each completed step server-side with a revision number. Resume from missing requirements after sign-in on another device. Keep local unsent edits separate from server-confirmed data. Two devices editing the same revision receive a conflict response with refresh/reapply choices.

| Field | Required? | Public? | Proposed validation |
| --- | --- | --- | --- |
| First/display name | Yes | Yes | 1–40 grapheme clusters, normalized whitespace, allow Ethiopic and other Unicode names |
| Birth date | Yes | No | Valid ISO date, adult eligibility, no future date |
| Gender identity | Yes for matching configuration | Visibility selectable | Inclusive catalog plus optional self description; matching categories are explicitly selected, never inferred |
| People interested in meeting | Yes | No | Explicit multi-select categories; supports more than one |
| US state/city | Yes | City/state only | Controlled IDs; US current residence separate from hometown |
| Relationship intention | Yes | Yes | Owner-reviewed catalog including serious, open to exploring, other agreed options |
| Photos | Yes | Approved photos only | 3–6 approved items, stable IDs, supported image formats, ordered |
| Prompt answers | Yes | Yes | Exactly three distinct active prompts; 1–300 grapheme clusters per answer |
| Languages spoken | Optional | Visibility selectable | Catalog IDs plus custom option if reviewed |
| Short bio | Optional | Yes if entered | Maximum 500 grapheme clusters |
| Hometown/community connection | Optional | Visibility selectable | Free expression with moderation, no identity inference |
| Occupation/education | Optional | Visibility selectable | Length limits; no exact workplace requirement |
| Religion/family plans/lifestyle | Optional | Per-field visibility | Skip allowed; no hidden ranking from these fields |
| Height | Optional | Visibility selectable | Units convertible; do not block profile activation |
| Terms/privacy acceptance | Yes | No | Document version, timestamp, locale; no fabricated final legal text |

Readiness is a server-computed predicate: verified account, adult eligibility, current agreements accepted, all required fields valid, at least three approved photos, three approved prompt answers, and no safety restriction. Update profile readiness immediately when edits remove required content. Maintain an approved published profile and a pending draft where practical so an edited prompt does not overwrite already approved content before review. Never publish a pending replacement automatically.

Every public API uses an explicit allowlisted profile DTO. Exclude birth date, email, Firebase UID, report history, internal moderation fields, raw coordinates, device tokens, private preferences and hidden optional fields.

### 4.3 Photos and text moderation

Recommend a media adapter with a local test implementation and a Firebase Storage implementation after approval. Profile content needs object storage; MongoDB holds metadata, not image binaries.

Proposed limit: 10 MB per uploaded photo, configurable. Flutter compresses/resizes for bandwidth; the server independently checks the true decoded format, dimensions, size, and file integrity. Reject disguised executables, corrupt files and decompression bombs. Accept a clearly defined format list; handle HEIC through an explicit conversion path or an informative unsupported-format response. Do not claim all device photos are supported without testing.

Upload through an authenticated Express multipart endpoint with strict request limits into quarantine. Generate a server-owned asset ID and object path. Strip EXIF, including GPS, normalize orientation and produce approved thumbnail/display variants. Prevent clients from reading quarantine or writing arbitrary storage paths. A moderation decision promotes safe variants; failed processing removes orphan assets through a retryable cleanup job. Guard against requests to fetch arbitrary external URLs.

For the first small pilot, manual photo and text review is an acceptable proposed workflow if someone is assigned to do it. Pending photos/prompts do not appear in discovery. Rejection gives a respectful reason and replacement action. Automated moderation is a later adapter, not an invented built-in capability. Admin actions record actor, target, reason, before/after state and timestamp.

Private buckets are not sufficient if permanent bearer download URLs are exposed. Prefer an authenticated media endpoint that rechecks access and streams a variant. If short-lived signed URLs are chosen later, explicitly document their revocation delay. Do not ship public permanent URLs for dating profiles.

### 4.4 Discovery and preferences

Eligibility is a hard filter before ranking:

1. Viewer is eligible to browse.
2. Candidate is a different user, active, profile-ready, and not paused.
3. Both users' explicitly chosen gender/interest preferences include the other.
4. Both users satisfy each other's hard age preferences.
5. Their US city/state/long-distance choices are compatible under the selected location policy.
6. Neither direction has a block, a terminal unmatch, or a report-triggered hide.
7. They are not already matched and have no unresolved outgoing like from the viewer.
8. The viewer has not passed the candidate within the configured cooldown.
9. Any owner-approved additional hard filters pass. Never use hidden sensitive fields for ranking.

Paused users disappear from new discovery and incoming-like presentation, but existing chats continue unless the owner decides otherwise. Likes sent before pause remain stored; accept/send is rechecked and temporarily disabled while the relevant person is paused. Resuming restores eligibility if all other requirements pass. A block or unmatch is permanent for that pair in the first release, even after unblock; unblock does not recreate a match or chat.

Proposed pass cooldown: 30 days, adjustable. Sending a like consumes allowance only on successful creation. An incoming like is handled in Likes rather than duplicated in Discover. A previously declined like is terminal for that direction in the first release; owner may later choose a documented reappearance policy.

For v1, avoid invented AI compatibility. Use US city/state/scope buckets and a stable server-generated shuffle among eligible candidates. Optional, transparently explained soft preferences can be added after launch. Do not rank by ethnicity, skin tone, religion, inferred sexuality, or wealth. No need to collect ethnicity to implement a community-focused app.

Create a short-lived discovery session containing a bounded ordered set of candidate IDs and the preference revision. Use an opaque signed cursor `{sessionId, nextOffset}` with server ownership and expiry checks. Return bounded pages, for example ten candidates. Recheck eligibility for every page and every action. Advancing the cursor tracks scanned candidates, so filtering unavailable users does not repeat or skip unscanned positions. Preferences change invalidates the session. Keep passes and likes idempotent across refreshes. Never silently widen age or geography when empty. Offer a clear user-triggered preference change.

City mode requires no precise location. If radius mode is later selected, use coarse server-held coordinates and a MongoDB `2dsphere` index, return distance bands rather than exact coordinates, and document rounding and minimum distance thresholds. Mutual geographic eligibility then needs a separately tested specification.

### US community and location rules

The confirmed audience is US based. The city catalog stores stable city ID, display name, state code and country code fixed to `US` for launch residence. Do not use an unrestricted global country picker as the default onboarding path. Hometowns abroad are optional profile context and never change current discovery eligibility. Show “Seattle, WA” or “Dallas, TX,” rather than full addresses or ZIP codes.

Proposed scopes for owner review: my city/selected metro area, selected US states, or anywhere in the US. If metro areas are supported, define an explicit catalog membership; do not invent mileage around a city center. Nationwide discovery must be deliberately selected. A pair is geographically eligible only if both users' selected scopes include the other's current city/state. “Open to long distance” does not silently override a selected hard location scope. Explain the exact scope in the filter sheet.

Residence is self declared. Do not request passports, citizenship, visa category, immigration documents or proof of ethnicity. The launch app is not an ancestry verification system. Do not use names, photos or language to decide whether someone is Ethiopian or Eritrean. If the owner chooses a community-background field, allow self-description, both backgrounds, mixed backgrounds and hidden display. Its eligibility wording needs owner input; it is not a ranking score or exclusion filter inferred by software.

Allow multilingual names, bios and messages even with English UI. Make no automatic assumption that Ethiopian users speak Amharic or Eritrean users speak Tigrinya. Prompts may mention family, coffee, music and community in optional ways; avoid testing anyone's cultural authenticity. Do not add tribe, political affiliation or immigration status fields for discovery.

Tests: non-US residence cannot enter the launch discovery pool; a stale/global city ID is rejected; two cities with the same name but different states remain distinct; metro/state/nationwide scope is mutual; hometown never substitutes for residence; hidden community fields stay hidden. If exact launch metros are not chosen, provide configurable catalogs and fictional fixtures rather than claim any city is the approved launch market.

### 4.5 Likes and matching

Proposed pilot allowance: eight new likes per UTC day, configurable and visibly explained. Acceptance of an incoming like does not consume an outgoing discovery allowance. The reset boundary is UTC in v1; show local next-reset time so travel and device timezone changes do not manipulate quota. Owner can select another policy before implementation.

Each like targets a stable photo ID or prompt answer ID plus content version. Optional comment limit: 200 grapheme clusters. Validate target ownership, current publication, content version and visibility at send time. Store a minimal context snapshot so a recipient understands a like after later edits. Do not keep removed media publicly accessible merely for context. Use a neutral “This profile item changed” fallback if the original is no longer safe or available.

Inbound actions are Accept and Decline. Accept creates a reciprocal interest decision and a match through the same service used for mutual likes. Simultaneous mutual likes create one match. A retry returns the original outcome. Self likes, likes to unavailable users, likes across blocks and stale-target submissions are rejected. A rejected operation never consumes quota.

Use a canonical pair record for each unordered pair. Every action that changes pair state performs a write to this same record inside its MongoDB transaction. This forces conflicting concurrent operations to retry against current state. Unique indexes are still required; checking for an existing document in application code is not sufficient.

When a match is committed, enqueue chat provisioning in a MongoDB outbox in that transaction. The app shows “Setting up your chat” until the room is ready. A worker failure cannot delete the match or create duplicate conversations. Never open a client-created chat room.

### 4.6 Chat

**Selected proposal: Cloud Firestore for rooms/messages and real-time reads; Express for every message send and privileged mutation.** Do not add Firebase Realtime Database as a second chat database in v1.

Firestore clients have narrowly scoped read permission and no room/message write permission. Express verifies identity, account status, room membership, pair state, text limits, rate limits and idempotency. Firebase Admin writes bypass Firestore Security Rules, so backend validation is independently required.

Messages are plain text only, 1–2,000 grapheme clusters after whitespace checks. Escape/render as plain text. Do not enable HTML, markdown commands, attachments or link previews in v1. Preserve multilingual input and emoji. Choose and test one equivalent Dart/JavaScript grapheme-counting contract.

Flow: client submits `clientMessageId` with text → Mongo transaction validates participant and writes the pair record, reserves next per-room sequence, and enqueues message event → response `202 accepted` → worker performs an authorized Firestore transaction with deterministic message ID derived from room + sender + clientMessageId → mark outbox event delivered. “Accepted” is not “Sent.” “Sent” appears after Firestore confirmation, and “Read” only after the recipient's server-validated read marker passes that sequence.

Client states: draft, submitting, accepted, sent, failed, cancelled by safety closure. A retry preserves the same message ID and body; a different body with the same ID gets conflict. Order by sequence, with accepted server time as display metadata and a deterministic ID tie-breaker. A process crash between Firestore write and outbox acknowledgment does not duplicate a message. Serialize or sequence delivery per room so out-of-order jobs cannot regress the inbox preview or read cursor.

Load latest 30 messages, paginate older pages with stable Firestore cursors, listen only to a bounded recent window, and detach listeners when leaving a room. Maintain participant-specific `lastReadSequence`; unread count is the number of messages from the other participant above that marker, not total sequence minus read position. Use bounded badge counts if exact aggregation is expensive. Disable public presence, last seen and typing indicators in the first release.

Use memory-only chat caching for the initial privacy posture. Keep unsent drafts in memory unless a reviewed encrypted draft store is added. Do not silently replay outgoing sends after restart or reconnect; show a retry action and reauthorize first. Local UI strips hidden conversations on block/unmatch/sign-out. No system can retract a message already read, cached outside the app, screenshotted, or copied by another person.

### 4.7 Block, report, unmatch and account status changes

**Block:** hides both people from discovery/likes, disallows future pair actions, closes active chat, prevents future reads once closure is confirmed, and does not notify the other person with a push. “Unblock” only removes the block entry; the pair stays closed in v1.

**Unmatch:** closes the match/chat and removes the inbox entry. Allow report before or during the flow. Do not require a reason to unmatch. Never send a message announcing who unmatched whom.

**Report:** reason catalog, optional description up to 2,000 grapheme clusters, optional current profile item/message IDs, and an explicit “Also block” choice. Server snapshots narrowly relevant evidence with restricted staff access. Hide the reported profile from the reporter's discovery; report alone does not automatically punish the other person or close an existing chat. Explain this and make block easy. An account must not be automatically suspended solely because a report counter crosses a threshold.

**Suspension/deletion:** stop new app actions immediately in MongoDB, revoke Firestore user access, close affected rooms, invalidate media access, revoke/disable auth as appropriate, and clear device push registrations. Restoring a suspended user does not automatically reopen closed relationships. Deletion is retryable and distinguishes no-longer-visible from fully erased.

Safety actions span two databases; they are not one atomic transaction. Required protocol:

1. Mongo transaction sets pair `closing` or account `restricted`, writes the shared guard document, stops new sends/likes and creates a durable safety operation. UI hides affected content immediately and shows progress.
2. A worker/API step uses a Firestore transaction to set room access closed, or the global user access document to disabled. Message projection transactions read these documents too, so conflicting writes retry and fail closed. Closing an absent room creates a permanent tombstone.
3. Mongo marks the safety operation completed. Only now may the API/UI claim chat access was fully closed. If step 2 fails, return an operation ID with pending status; deny new actions, retry durably and never roll back to open.
4. Provisioning uses create-only room semantics. A stale create job cannot overwrite a closed room/tombstone. All state jobs carry expected version and cannot reopen terminal states.

Pair operations write the same Mongo pair guard. Account eligibility changes and pair actions must also conflict on relevant account guard versions rather than relying on stale read-only checks. Keep transactions small and apply a consistent document update order. Use this explicit protocol in the race tests. Access may remain readable while closure is pending; do not promise instant remote revocation during a Firebase outage. After completion, new server reads/sends must fail. Already delivered content cannot be retrieved from recipients.

### 4.8 Settings, notification and privacy behavior

Preferences: edit dating interests, age range, selected US location scope, optional soft preferences and profile visibility controls. Enforce age minimum 18; never let an adult search for underage people. A preference change increments a revision and resets discovery pagination.

Pause removes a profile from new introductions without deleting chats. Sign out detaches listeners, removes local sensitive data, and unregisters that session's device token. Notification settings separate likes, matches and messages; in-app activity remains available without push permission. Quiet hours are later unless explicitly chosen.

Push messages use neutral text by default, for example “You have a new message.” Avoid message body, sensitive profile fields or private photos on the lock screen. Notification delivery is best effort and cannot be exactly-once across all provider failures. Give each notification a stable dedupe ID, recheck recipient eligibility before sending, and reauthorize every deep link. Do not treat a push as proof that a match still exists.

Deletion requires recent sign-in and confirmation. Immediately hide/restrict the user, then run a durable job across MongoDB, Firestore, object storage, Firebase Auth, device tokens and active notifications. Clarify what is removed from the other participant's view. Proposed policy: close the room and remove user-accessible conversation history while retaining only report evidence under a separately approved, bounded policy. Retention periods, supported markets, privacy terms and handling of sensitive profile data require owner review before public release. Do not invent a claim of legal compliance.

### 4.9 Moderation and admin

An internal admin Flutter route/build may share components with the mobile project, but admin authorization always lives on the server. Access is allowlisted, roles are server managed and moderator permissions are separate from administrator permissions. Require recent sign-in for evidence access and destructive actions. No client can grant roles or set verification badges.

Case workflow: new → assigned → in review → resolved/dismissed. Add optimistic case revisions so two staff members cannot unknowingly overwrite each other. Record an action reason. Show report context without exposing unrelated message history. A report's existence is private. Staff cannot export all conversations through a convenience endpoint. Provide local seeded admin accounts only in the emulator environment, never an undocumented production bypass.

## 5. Architecture and repository

### Responsibilities

| Layer | Responsibility | Must not become |
| --- | --- | --- |
| Flutter | UI, view models/controllers, local draft state, API calls, authenticated Firestore listeners | Trusted authorization or quota enforcement |
| Firebase Auth | Identity, password recovery, verification, tokens | The app's profile or match database |
| Express + TypeScript | Policy, validation, authorization, matching, media access, admin API | A pass-through that trusts client flags |
| MongoDB | Profiles, preferences, interactions, pair state, quotas, safety, jobs, notification metadata | A duplicate full chat history store |
| Cloud Firestore | Authorized chat rooms, message records, live updates, chat access projection | Canonical discovery/match policy |
| Media adapter | Quarantine, variants, private objects, cleanup | Permanent public profile links |
| Worker process | Outbox delivery, room provisioning, safety propagation, deletion, cleanup | A second set of untested business rules |

Use a modular monolith with one Express application and a worker entry point sharing domain services. Do not start with microservices. External integrations sit behind adapters for deterministic tests. No external queue, Redis, Elasticsearch, GraphQL, vector DB or LLM dependency is necessary for v1.

### Proposed supporting packages

Flutter: Riverpod for dependency injection/state, GoRouter for navigation, Dio for API calls, Freezed/JSON serialization if the team accepts code generation, official Firebase Flutter packages, `flutter_test` and `integration_test`. Use one state-management convention throughout. Do not add Bloc alongside Riverpod.

Backend: TypeScript in strict mode, Express, MongoDB Node driver, Zod for boundary validation, Firebase Admin SDK, structured logging with redaction, image processing adapter such as Sharp, Vitest and Supertest. Use current compatible supported versions verified by the implementation agent and commit lockfiles. This plan intentionally does not pin unverified future package versions.

Rules tests: Firebase Emulator Suite plus `@firebase/rules-unit-testing`. Tests that exercise transactional matching use an actual local MongoDB replica set, not a standalone mock. MongoDB transactions require a supported transaction-capable topology. Local replica-set setup is test tooling, not a production hosting choice.

### Repository layout

| Path | Contents |
| --- | --- |
| `apps/mobile/lib/app/` | App entry point, router, bootstrap, environments |
| `apps/mobile/lib/core/` | Theme, UI primitives, API errors, localization, shared utilities |
| `apps/mobile/lib/features/` | auth, onboarding, profile, discovery, likes, matches, chat, safety, settings, admin |
| `apps/mobile/test/` | Unit, widget, golden and accessibility-oriented tests |
| `apps/mobile/integration_test/` | End-to-end user journeys |
| `apps/api/src/modules/` | Domain-oriented controllers, services, repositories, schemas |
| `apps/api/src/adapters/` | Firebase, media, push and clock adapters |
| `apps/api/src/workers/` | Outbox processors and cleanup/deletion handlers |
| `apps/api/test/` | Unit, API, Mongo integration, concurrency and failure tests |
| `firebase/` | Rules, indexes, emulator configuration and rule tests |
| `contracts/` | OpenAPI schemas and fixtures, not duplicated business logic |
| `scripts/` | Local emulators, seed/reset, contract generation, test runner |
| `docs/` | This spec, decisions, state machines, threat model, QA, progress |

Feature code separates presentation, application/domain, and data adapters. Do not make a dozen empty abstractions per screen. Abstract only meaningful external boundaries or reusable domain behavior.

## 6. Data model and indexes

Use server-generated opaque user IDs and UTC timestamps. Do not expose Firebase UIDs as public profile IDs. Dates of birth are date-only values. Keep exact validation limits and enums in the OpenAPI contract and generated Dart models where possible.

### MongoDB collections

| Collection | Main fields | Essential indexes/notes |
| --- | --- | --- |
| `users` | id, firebaseUid, accountStatus, emailVerifiedCache, birthDate, adultEligible, discoverPaused, profileReady, guardVersion, agreements, createdAt | Unique firebaseUid; account status index. Cached verification never replaces authoritative sensitive checks |
| `profiles` | userId, displayName, gender identity, public gender setting, cityId/stateCode/countryCode, intention, published fields, draft, revision, publishedRevision | Unique userId; discovery fields denormalized deliberately |
| `preferences` | userId, acceptedGenderCategories, minAge, maxAge, locationScope, longDistance, optional soft preferences, revision | Unique userId; revision invalidates sessions |
| `photos` | id, ownerId, state, originalPrivateKey, variantKeys, dimensions, order, revision, moderationReason | ownerId/state/order; server-managed object paths |
| `promptCatalog` | id, category, localizedText keys, active, revision | Unique stable id; inactive prompts follow explicit migration policy |
| `promptAnswers` | id, ownerId, promptId, approvedText, pendingText, state, publishedRevision | ownerId/promptId uniqueness; text not silently republished |
| `pairs` | pairKey, sorted memberIds, state, version, nextMessageSequence, matchId, closedReason | Unique pairKey; all competing pair writes touch this document |
| `likes` | id, fromUserId, toUserId, pairKey, targetKind/id/version, context, comment, status, createdAt | Unique from/to for v1; recipient/status/createdAt/id pagination |
| `passes` | viewerId, candidateId, expiresAt | Unique viewer/candidate; expiry index. Check expiresAt in code because TTL deletion is asynchronous |
| `matches` | id, pairKey, memberIds, status, chatState, createdAt, closedAt | Unique pairKey; memberIds/status/createdAt for inbox |
| `blocks` | blockerId, blockedId, pairKey, createdAt, removedAt | Directional unique active record or one record per direction updated in place |
| `reports` | reporterId, subjectId, reason, description, evidence refs/snapshot, status, assignedTo, revision | status/createdAt; restricted evidence storage |
| `reportHides` | reporterId, subjectId, createdAt | Unique pair in this direction; does not imply public punishment |
| `quotas` | userId, utcDay, usedLikes, policyVersion | Unique user/day; conditional increment in like transaction |
| `idempotency` | actorId, operation, key, requestHash, resultRef, status, expiresAt | Unique actor/operation/key; TTL and explicit expiry checks |
| `outbox` | eventId, aggregateId, aggregateVersion, type, payload, status, attempts, nextAttemptAt, leaseOwner, leaseUntil | Unique eventId; status/nextAttemptAt; expired leases recoverable |
| `safetyOperations` | id, scope, targetId, requestedBy, phase, attempts, createdAt, completedAt | phase/retry time; independently pollable completion |
| `discoverySessions` | id, ownerId, preferencesRevision, candidateIds, expiresAt | owner/expiry; TTL; bounded candidate list |
| `notifications` | id, userId, type, entityId, dedupeKey, readAt, createdAt | Unique dedupeKey; user/createdAt/id |
| `devices` | userId, installationId, pushToken, platform, preferences, updatedAt | Unique token and owner/installation; reassignment on shared-device sign-in |
| `auditLogs` | actorId, action, targetType/id, reason, requestId, time | Time/target indexes; append-only service contract |
| `deletionJobs` | userId, requestedAt, phase, progress, retryAt, errorCode, completedAt | Unique active user job; no raw sensitive payload in error logs |

Schema design can combine small documents after measurement, but every required uniqueness invariant needs a real database index and an automated test. Index creation/migration is an explicit local command; don't rely on implicit production auto-indexing.

### Firestore documents

| Path | Main fields | Ownership |
| --- | --- | --- |
| `chatAccess/{firebaseUid}` | enabled, accountVersion | Server-only writes; rules consult both participants |
| `rooms/{matchId}` | participantUids exactly two, status provisioning/active/closed, pairVersion, closedAt, lastMessageSummary, lastMessageSequence | Server-only; no reopen from closed |
| `rooms/{matchId}/messages/{messageId}` | senderUid, clientMessageId, plainText, sequence, acceptedAt, deliveredAt, schemaVersion | Server-only; immutable message identity |
| `rooms/{matchId}/readStates/{uid}` | lastReadSequence, updatedAt | Server-only; member reads only; no typing data |

Rules: unauthenticated denied; nonparticipant denied; closed room denied; either disabled participant denies reads; all client writes denied. Room list queries must constrain participant membership and room state in a way supported by rules; implement and test exact queries and composite indexes. Do not use “rules are filters” as a query strategy. If listing rooms safely proves awkward, use the Express match list and attach listeners to explicit allowed room IDs. This is the preferred v1 approach.

No public Firebase collection contains profiles, likes, email, DOB, moderation cases or arbitrary user directories. Admin evidence endpoints read with privileged access only after server authorization.

## 7. API and consistency contracts

All versioned endpoints use `/v1`. Protected requests use `Authorization: Bearer <Firebase ID token>`. Use `Idempotency-Key` for creates and safety actions. Profile updates use expected revision or `If-Match`. Reject unknown fields on privileged mutation DTOs. All object access checks occur server-side.

| Endpoint | Purpose / important constraint |
| --- | --- |
| `POST /v1/me/bootstrap` | Idempotently map Firebase identity to app account |
| `GET /v1/me` | Private own-account snapshot, readiness and next onboarding step |
| `PATCH /v1/me/onboarding` | Validate one draft step and expected revision |
| `GET /v1/catalogs` | Allowed cities, US states/cities, prompts, intentions, locale metadata |
| `PATCH /v1/me/profile` | Own editable draft fields only; no role/status changes |
| `GET /v1/me/profile/preview` | Self preview with public projection semantics |
| `POST /v1/me/photos` | Authenticated bounded multipart upload into quarantine |
| `PATCH /v1/me/photos/order` | Complete valid ID ordering and expected revision |
| `DELETE /v1/me/photos/:id` | Owner only; recompute readiness and remove public access |
| `GET /v1/media/:assetId/:variant` | Reauthorize viewer and stream approved media |
| `GET/PATCH /v1/me/preferences` | Private preferences and revision |
| `GET /v1/discovery` | New session or validated cursor, public DTOs only |
| `GET /v1/profiles/:id` | Eligible contextual access; no global searchable directory |
| `POST /v1/passes` | Candidate ID; idempotent cooldown |
| `POST /v1/likes` | Recipient, content reference/version, optional comment |
| `GET /v1/likes/incoming` | Keyset cursor and currently eligible content |
| `POST /v1/likes/:id/accept` | Recipient only; idempotent match result |
| `POST /v1/likes/:id/decline` | Recipient only; no quota consumption |
| `GET /v1/matches` | Authorized list and room provisioning states |
| `POST /v1/matches/:id/unmatch` | Returns completed result or pending safety operation |
| `POST /v1/matches/:id/messages` | clientMessageId + text; `202` is acceptance only |
| `POST /v1/matches/:id/read` | Monotonic valid read sequence, participant only |
| `POST /v1/blocks` | Subject ID; durable close protocol |
| `DELETE /v1/blocks/:subjectId` | Remove block, preserve terminal closed pair |
| `POST /v1/reports` | Valid evidence ownership/context; optional linked block operation |
| `GET /v1/operations/:id` | Owner-authorized progress for safety/deletion/media jobs |
| `GET /v1/notifications` | User-scoped cursor list |
| `POST /v1/notifications/:id/read` | Recipient only; idempotent |
| `POST/DELETE /v1/me/devices/:installationId` | Register/revoke device token |
| `PATCH /v1/me/settings` | Pause and notification preferences; guard version update |
| `POST /v1/me/deletion` | Recent auth, confirmation, idempotent durable job |
| `GET /v1/admin/reports` | Role checked and audited |
| `POST /v1/admin/reports/:id/actions` | Expected case revision and required action reason |
| `POST /v1/admin/content/:id/review` | Approve/reject supported asset types with audit |

Success envelope proposal: `{data, meta: {requestId, nextCursor?}}`. Errors: `{error: {code, message, fieldErrors?, retryable}, requestId}`. No stack traces or database internals. Standard cases: 400 malformed, 401 auth, 403 forbidden, 404 unavailable resource, 409 conflict/stale revision, 413 too large, 422 field validation, 429 rate/quota, 503 dependency temporarily unavailable. Avoid distinguishable “blocked you” errors; use `PROFILE_UNAVAILABLE` or `CONVERSATION_CLOSED` with safe copy.

Idempotency binds key to authenticated actor, operation and normalized request hash. Same key/same request returns same entity; same key/different request returns conflict. Durable uniqueness protects duplicates beyond the idempotency TTL. An expired key does not allow a second match or duplicate message. Read-after-write responses identify pending projections explicitly.

### Proposed abuse limits and validation boundaries

These are reviewable pilot defaults, not measured service capacity: 30 message submissions per minute per account with a small burst allowance; eight new likes per UTC day; ten photo upload attempts per hour; five report submissions per hour with a clear alternate support path for urgent safety issues. Recovery/sign-in abuse protection uses Firebase capabilities plus appropriate API safeguards, not a client timer. Generic authenticated read limits should accommodate normal scrolling without blocking ordinary usage. Never throttle the ability to request a block or unmatch behind a consumed likes/messages quota; provide an independent protective limit and idempotent retries for safety endpoints.

Enforce limits server-side, atomically across API processes using bounded Mongo counters where needed. IP-level protections supplement user limits but do not punish shared campus or household networks as the sole signal. Return a retry hint, enforce payload/body size before expensive decoding, and paginate every list. Tests cover boundary, concurrent increments, rollover, retry without double count, unauthenticated bursts and safety requests after another quota is exhausted. Tune defaults from pilot evidence without changing the contract silently.

### Worker semantics

Write domain changes and outbox events in one Mongo transaction. Message outbox payloads temporarily contain text for delivery; clear the text after confirmed projection according to an explicit short retention policy, preserving only delivery metadata and a request hash for duplicate checks. Do not let the outbox become an indefinite second chat archive. Claim jobs atomically with a lease and bounded retries; recover expired leases after crashes. No network calls inside a retriable Mongo transaction. Firebase transactions and external sends happen after commit. Job effects are idempotent, version checked and observable. Use exponential backoff with jitter, a dead-letter state and a local replay command. A reconciliation command compares active matches and terminal safety states to Firestore without ever reopening terminal rooms. Keep worker code inside the same repository and test suite.

Match provisioning writes an active room only with create-only semantics after checking current pair/user eligibility. Closure may create a closed tombstone first; later creation must fail. Messages check room status and both chatAccess documents in the same Firestore transaction as their write. Push projection checks current state but has unavoidable provider timing limits; never place sensitive contents in it.

## 8. Testing and verification strategy

The agent must write meaningful tests for each implemented behavior, run them, and report actual results. A generated test file is not evidence that a test passed. A mocked test cannot establish real database transaction or Firebase rule behavior.

### Test layers

| Layer | Examples | Tools / environment |
| --- | --- | --- |
| Domain unit | Birthday boundary, matching eligibility, Unicode length, quota reset, state transitions | Vitest; Dart unit tests for client logic |
| API integration | Auth, validation, authorization, response contracts, duplicate requests | Supertest against actual app; Firebase Auth emulator |
| Mongo integration | Unique indexes, rollback, concurrency, leases, quota atomicity | Real local replica set with isolated test database |
| Firebase rules | Anonymous/nonmember denial, closed room denial, disabled account denial, all client writes denied | Emulator Suite and rules-unit-testing |
| Flutter widget | Forms, recovery, filters, loading/empty/error, semantics | flutter_test with deterministic adapters |
| Visual regression | Theme, profile card, like composer, chat, error/empty screens | Golden tests on fixed sizes/fonts; baseline review |
| Full journey | Two people onboard → approved profiles → like → accept → chat → block | Flutter integration_test plus API and emulators |
| Failure/concurrency | Duplicate worker, reverse job order, crash/retry, block/send race | Explicit failure hooks and barriers; no timing-only sleeps |
| Manual device QA | Keyboard, photo picker, navigation, permissions, screen readers | Available iOS/Android simulators/devices; report limitations |

### Required regression matrix

1. A person one day short of the selected adult birthday boundary cannot activate; the boundary date works; leap day policy is tested.
2. Firebase UID impersonation, expired token, wrong project token, missing token and client-forged role fail.
3. Unverified/incomplete/suspended/deleting accounts cannot browse or like.
4. Changing profile owner IDs in requests does not expose or edit another profile.
5. Every public profile DTO excludes private fields and hidden optional fields.
6. Corrupt, oversized, wrong-format and EXIF-bearing photos are handled correctly; quarantine cannot be read.
7. A pending/rejected photo or prompt cannot appear in discovery or be liked.
8. Mutual age/interests/location rules apply in both directions and are checked again at action time.
9. Pagination has stable order, no duplicates within a session, owned/expiring cursor checks, correct scanned offsets, and preference invalidation.
10. Same like retry consumes one quota unit; failure consumes zero; parallel requests cannot exceed allowance.
11. Simultaneous opposite likes and repeated acceptance produce one match and one room.
12. Like context survives safe profile edits without keeping removed media accessible.
13. Anonymous users, strangers, closed participants and disabled accounts cannot read chat. Clients cannot write any chat document.
14. Duplicate message submission and worker retry produce one message; same ID/different text conflicts.
15. Reverse job order does not regress latest preview, corrupt order or overcount unread.
16. Block versus like, block versus accept, block versus send, and closure versus provisioning fail closed under controlled races.
17. Safety operation pending state is honest during Firebase outage; restart completes closure; stale jobs never reopen it.
18. Account suspension/deletion conflicts correctly with concurrent pair actions and revokes Firebase read permission.
19. Report evidence must belong to an accessible context and cannot expose unrelated conversation messages.
20. Pause removes new-introduction eligibility while preserving existing allowed chat.
21. Deletion job restarts after every external step and does not skip media, message subcollections or auth cleanup.
22. Push payload contains no message body/private fields; deep links reauthorize; sign-out/token reassignment avoids cross-account delivery.
23. Large text, screen readers, reduced motion, contrast and keyboard access do not hide critical controls.
24. Offline UI never calls an accepted/queued action completed; retry rechecks current state.

### Quality gates and reporting

Maintain a requirement-to-test map. All critical safety, authorization, matching and quota branches must have explicit positive and negative tests. A suggested initial numeric target is 85% branch coverage on domain services; the percentage is secondary to covering the actual invariants. Do not write trivial tests just to hit coverage. No timeouts or skipped tests may be hidden to get a green result.

Standard local checks, after scripts exist: API format/lint/typecheck, API unit/integration tests, Firebase rules tests, Dart format check, Flutter analyze, Flutter unit/widget tests, selected goldens, then relevant device integration tests. Run focused checks per phase and full regressions at milestones. Always state whether an emulator/device was available. Seed users and photos are fictional and development-only.

Performance targets are provisional test goals, not measured claims: API profile/discovery response near or below 500 ms p95 on a documented local fixture environment, message projection usually within 2 seconds when dependencies are healthy, bounded listener/page sizes, and no full-collection candidate scan in request handling. Record dataset size, hardware and configuration alongside any timing. Add a synthetic data generator for at least 10,000 profiles when testing query plans. Use representative images to check memory and smooth scrolling on an available modest device.

## 9. Implementation roadmap

Each phase produces a usable increment with tests. Dependencies are deliberate. Prompts below are designed for one agent session at a time. Do not execute all phases in one unreviewed change.

| Phase | Deliverable | Depends on |
| --- | --- | --- |
| 00 | Decisions and acceptance map | Owner answers for affected decisions |
| 01 | Repository and local test harness | 00 scaffolding decisions |
| 02 | Original UI system and component gallery | 01 |
| 03 | Auth, adult gate and route protection | 01, 02, auth decision |
| 04 | Profile draft and preferences domain | 03, matching field decisions |
| 05 | Private media and moderation foundation | 04, media decision |
| 06 | Complete onboarding and profile editing | 02–05 |
| 07 | Discovery API and Flutter experience | 04–06, location policy decision |
| 08 | Likes, quota and incoming-like UI | 07 |
| 09 | Transactional matches and outbox | 08 |
| 10 | Firestore chat provisioning and rules | 09 |
| 11 | Reliable messaging and Flutter chat | 10 |
| 12 | Block, unmatch and report vertical flow | 09–11 |
| 13 | Moderation/admin workflow | 05, 12 |
| 14 | Notifications and optional push | 11–13, push decision |
| 15 | Pause, account lifecycle and deletion | 12–14, retention decision |
| 16 | Localization, accessibility and network polish | Core screens implemented |
| 17 | Race testing, reconciliation and performance | 03–16 |
| 18 | Complete local beta acceptance review | All applicable phases |

Before phase 12, use fictional test accounts only: safety is part of the minimum usable dating product, not a post-launch enhancement. Before public release, separately resolve legal texts, launch markets, age assurance, moderation operations, media policy, and production service setup. This plan does not deploy anything.

## 10. Copyable master prompt for the implementation agent

Paste this at the beginning of the coding session, with this specification available in the repository. Then paste one phase prompt from section 11.

```text
You are implementing an Ethiopian and Eritrean US community dating application from the attached
specification. Build the requested phase as working code, with meaningful tests
that you actually run. Work on one phase at a time.

Confirmed audience: English-speaking Ethiopians and Eritreans living in the US.
Confirmed platform: Flutter mobile for iOS and Android; no public web client.
Confirmed UI language: English at launch; Amharic is optional future work.
Do not ask the owner to confirm these three choices again.

Confirmed stack: Flutter client, TypeScript/Express API, MongoDB application data,
Firebase Authentication, Cloud Firestore chat. Do not replace this stack.
Hosting, deployment, infrastructure vendors, domains and production provisioning
are out of scope. Local emulators, a test Mongo replica set, and local scripts
are in scope. Additional service adapters require recorded product decisions.

Start by reading AGENTS.md if present, the repository, this specification,
docs/product-decisions.md and docs/progress.md. Inspect installed tools and
existing code before changing anything. Preserve unrelated work. Never assume
an existing behavior or dependency version without checking it.

If a product decision needed for this phase is missing, ask a concise clarifying
question. Continue only independent work while awaiting the answer. Do not
silently turn a proposed option in the specification into an approved decision.
Do not implement later phases, subscriptions, ML matching or extra services.

For this phase:
1. Restate its deliverables and observable acceptance criteria briefly.
2. Identify authorization, privacy, concurrency and failure invariants.
3. Write meaningful failing tests for changed behavior before implementing it.
   Run them to verify failure for the intended missing behavior when possible.
4. Implement the smallest complete vertical increment. Avoid placeholder success,
   fake production data, hardcoded auth bypasses, client-only authorization,
   unbounded queries and broad refactors unrelated to the phase.
5. Run focused tests, fix failures, and run relevant regression checks. Use real
   local Mongo transactions and Firebase emulators for integration guarantees.
   Mocks are allowed for unit tests, not as proof of rules or race correctness.
6. Inspect the UI on available devices/emulators where this phase changes it.
   Include loading, empty, validation, offline, retry and success states.
7. Update OpenAPI/contracts, indexes, seed fixtures, setup notes, requirement-to-
   test mapping and docs/progress.md as needed.
8. Finish with files changed, behaviors delivered, commands run, actual results,
   remaining limitations, and the next phase. Never claim an unrun test passed.

Keep business rules server-side. Verify Firebase tokens. MongoDB owns profiles,
preferences, likes, pair state, matches, quotas and safety jobs. Firestore owns
chat documents and live delivery. All chat writes go through Express and the
outbox. Deny direct client writes. Use explicit public DTO allowlists.

Use unique indexes, canonical pair guards, account guard conflicts, transactions,
idempotency and durable outbox events for competing operations. Never call an
external service inside a retriable Mongo transaction. Cross-database safety
closures are durable and fail closed; report pending honestly. Closed rooms
cannot be reopened by stale provisioning or replayed jobs.

Do not log tokens, email addresses, DOB, location coordinates, message content,
report evidence or private profile fields. Use synthetic local fixtures.

Use the approved fresh UI direction: ivory surfaces, berry actions, subtle copper
details, large photos, readable prompts and restrained textile-inspired accents.
Do not copy another app's branding, layouts, assets or copy. Honor accessibility,
Unicode text, localization structure, reduced motion and slow connections.

If a required tool/emulator is unavailable, report the exact limitation and
provide reproducible commands. Complete verifiable independent work, but do not
mark an integration-dependent phase finished without the required evidence.
Do not deploy, push changes to external services or contact anyone.
```

## 11. Phase-by-phase implementation prompts

### Phase 00: decisions and traceable acceptance criteria

```text
Execute Phase 00 only. Read the specification and inspect the repository. Create
docs/product-decisions.md, docs/requirements.md and docs/progress.md. Assign stable
requirement IDs to the product rules, privacy rules, race invariants and screens.
Separate confirmed stack choices from proposals awaiting owner answers.

Record the already-confirmed US Ethiopian/Eritrean audience, Flutter iOS/Android
platforms and English launch UI. Do not ask for those again. Ask only unresolved
choices affecting the first slice, such as sign-in method and brand placeholder.
Record other pending choices with their blocking phases, including age-assurance
policy, sensitive fields, city mode, media storage, push and retention.
Do not make up answers. Produce a sequential checklist with the 19 phases,
dependencies, acceptance criteria and required verification layer for each.

Do not scaffold the application yet. This phase contains documents and decisions,
so validate consistency and completeness rather than writing artificial tests.
Definition of done: every approved first-release requirement has an ID and phase;
every open choice has an owner question and a clear dependency; hosting is absent.
```

### Phase 01: repository and local verification harness

```text
Execute Phase 01 only after the scaffold decisions are recorded. Set up Flutter,
TypeScript/Express, strict compiler configuration, dependency lockfiles, contracts,
Firebase emulator configuration and a local MongoDB replica-set test harness.
Add environment examples with no secrets. Make production Firebase access
impossible in the default local test configuration. Fail fast if test execution
would use a nonlocal database or non-emulator Firebase endpoint.

Add scripts for seed/reset, API checks/tests, Firebase rule tests, Flutter checks
and a root local verification command. Verify a real Mongo transaction can commit
and roll back. Verify the Auth/Firestore emulator connections work. Add health
and readiness endpoints with non-sensitive output, a request ID and error mapping.

Tests first: health response, readiness with unavailable dependency, transaction
rollback, unknown-route response, invalid environment rejection. Do not create
feature endpoints yet. Definition of done: a fresh checkout can follow documented
steps to run the app shell and all harness checks locally. Report missing native
toolchains explicitly; never substitute a mock integration pass.
```

### Phase 02: original theme, navigation shell and UI components

```text
Execute Phase 02 only. Implement the approved visual tokens, typography, spacing,
accessible buttons/inputs, cards, photo frames, prompt tiles, badges, sheets,
loading/empty/error states, bottom navigation and localization resource structure.
Create a development-only component gallery with fictional fixtures. Implement
the Discover profile composition and like composer as reusable presentation
components without adding real likes or discovery logic.

Write widget tests for input errors, disabled/loading buttons, semantics and
navigation selection. Add reviewed goldens for a narrow phone, normal phone and
large text setting. Verify long names, Ethiopic samples, emoji, three-line prompt
answers and missing images do not break layouts. Check actual color contrast.

Definition of done: an original, coherent UI can be inspected locally; all main
components support keyboard/screen reader use, reduced motion and 48-pixel touch
targets. No copied product assets, hardcoded user-facing strings or fake live
matching behavior. Include the commands and actual visual checks performed.
```

### Phase 03: authentication, adult gate and guarded routes

```text
Execute Phase 03 only using the approved auth and platform decisions. Implement
Firebase sign-up/sign-in, email verification, recovery, sign-out and Express token
verification. Add idempotent identity bootstrap and unique firebaseUid mapping.
Implement account status guards and onboarding route protection. Add the approved
date-of-birth/adult boundary policy and terms acceptance draft metadata.

Write tests before implementation for missing/invalid/expired/wrong-project tokens,
body UID spoofing, duplicate bootstrap under concurrency, unverified accounts,
underage and boundary birthdays including leap day, and suspended/deleting users.
Use Auth emulator integration tests. Widget-test verification and recovery states.
Never store a password or accept a client role/status as authoritative.

Definition of done: a real local test identity can sign in, verify and reach only
the allowed onboarding screens; unauthorized users cannot call protected APIs.
Document what self-declared age does and does not establish. No identity badge.
```

### Phase 04: profiles, preferences and public projection

```text
Execute Phase 04 only. Implement catalogs, onboarding draft persistence, profile
revision conflicts, preferences, visibility settings, prompt answer domain and
server-computed readiness. Define explicit private/self/public DTOs and OpenAPI
contracts. Generate or validate matching Dart DTOs. Account guard versions change
when eligibility-affecting fields change.

Tests first: Unicode names and grapheme limits, malformed dates, invalid age
ranges, duplicate prompt IDs, unknown catalog IDs, own-resource authorization,
hidden fields omitted, stale revision conflict, and every readiness requirement.
Test two-device edits. Test that clients cannot set readiness, approval, roles,
published revisions or account status. Seed fictional profiles only.

Definition of done: profile/preferences APIs validate and persist correct draft
state and publish only allowed approved content. Public DTO tests explicitly
assert sensitive fields are absent. No discovery API or matching yet.
```

### Phase 05: private media pipeline and review foundation

```text
Execute Phase 05 only. First confirm the media adapter decision. Implement bounded
multipart upload, private quarantine, decoded-file validation, orientation handling,
EXIF stripping, image variants, metadata, review states and retryable orphan cleanup.
Add authenticated media reads with per-request access checks. Provide the local
adapter and approved storage adapter behind the same interface.

Tests first: oversized input, fake MIME type, corrupt image, extreme dimensions,
EXIF GPS removal, unsupported HEIC handling, wrong owner, quarantine access denied,
removed/rejected asset denied, failed upload compensation and duplicate retry.
Verify rules or bucket permissions with an emulator/integration fixture where
supported; no permanent public download URLs. Test reorder/delete revision checks.

Definition of done: a fictional photo can be uploaded, reviewed and displayed as
an approved variant; private originals and pending content are inaccessible to
other users. Minimal audited review service is allowed; full admin UI is Phase 13.
Do not claim moderation exists if everything is auto-approved.
```

### Phase 06: complete onboarding and editable profile UI

```text
Execute Phase 06 only. Connect onboarding screens to real APIs: account identity,
dating interests, location, photos, prompts, optional fields, preferences, agreement
acceptance and profile preview. Implement resumable drafts, local unsent state,
revision conflict recovery and visible pending-review states. Build You and edit
profile screens using the same public presentation components as Discover.

Tests first: restart midway, back/forward navigation, failed step save, last-required
field missing, pending/rejected media, duplicate prompt, removal below minimum,
concurrent edit, private fields hidden in preview and successful readiness transition.
Use Flutter widget tests and an emulator-backed onboarding integration journey.

Definition of done: a person can create a complete fictional profile locally,
resume interrupted onboarding and edit it without data loss or false activation.
Inspect keyboard behavior, scrollability and accessible error announcements.
```

### Phase 07: discovery eligibility and complete discovery UI

```text
Execute Phase 07 only after the US location-scope policy is recorded. Implement
mutual eligibility, US city/state scope, stable bounded discovery sessions, signed
owned cursors, pass cooldown and preference revision invalidation. Build the real
Discover screen and filter sheet. Display only public DTOs and authorized media.

Tests first: mutual interests and ages, inactive/incomplete/paused users, either-way
block, terminal pairs, report hides, passes with expired-but-not-TTL-deleted rows,
existing matches/outgoing likes, missing candidates, cursor expiry/tampering/other
owner, correct scanned offsets and preference changes. Inject clock and stable RNG.
Recheck candidate access on profile reads. Do not silently expand preferences.

Definition of done: fictional eligible users browse a stable feed, pass and update
filters with honest loading/empty/offline states. Explain any density shortfall.
Do not implement compatibility scoring, GPS or likes before their phases.
```

### Phase 08: content likes, allowance and incoming-like UI

```text
Execute Phase 08 only. Implement content-level likes with stable target/version,
optional comment, safe context snapshot, authenticated idempotency, transactional
quota and incoming-like pagination/decline. Build composer, incoming Likes list
and outgoing result states. Expose accept as disabled until Phase 09, rather than
pretending a match exists.

Tests first: self like, wrong target owner, stale/deleted/rejected target, body UID
spoof, duplicate request, same key/different payload, Unicode comment limit, UTC
day reset, rejected like consumes zero, simultaneous requests cannot overspend,
blocked/paused recipient and safe context after content removal. Verify actual
unique indexes and transaction behavior against the replica set.

Definition of done: sending/declining a like works end to end, remaining allowance
is accurate, retries do not duplicate or double-charge, and unavailable users do
not leak into incoming Likes. New-like tests use controlled concurrency barriers.
```

### Phase 09: matches, pair guards and durable outbox

```text
Execute Phase 09 only. Implement canonical pairs, required pair/account guard
writes, explicit incoming-like acceptance, mutual-like matching, unique match
creation and transactional outbox. Implement worker leases, retry, dead-letter
state, replay and per-aggregate version handling. Add match list and provisioning
UI without claiming an uncreated chat is ready.

Tests first: simultaneous opposite likes, duplicate accept, accept versus decline,
eligibility change versus accept, quota/match rollback, expired lease recovery,
worker crash after side effect and duplicate job execution. Use a real Mongo
replica set and deterministic failure hooks. External calls never run inside
retriable Mongo transactions. Future safety closure hooks must be explicit.

Definition of done: every pair gets at most one match and one room-provisioning
event identity. A failed external adapter leaves a recoverable pending match.
Test the outbox with a recording fake here; real Firestore provisioning is Phase 10.
```

### Phase 10: Firestore rooms, access rules and provisioning

```text
Execute Phase 10 only. Create Firestore room/access/read-state schemas, indexes
and deny-by-default rules. Clients may read only active permitted rooms and may
not write rooms/messages/read state. Use Express match listing and explicit room
listeners. Implement create-only provisioning, closed tombstones and reconciliation
that cannot reopen terminal states. Use both participants' enabled access docs.

Tests first using Firebase rules-unit-testing: anonymous denied, nonmember denied,
member active read allowed, disabled participant denied, closed room denied, every
client write denied, malformed room participant shape denied and actual listener
queries permitted. Integration-test duplicate provisioning, safety tombstone before
creation, dependency outage and reversed stale events against Firestore emulator.

Definition of done: one matched pair gets one ready room, a stranger cannot read
it, and stale jobs cannot recreate access. Backend checks are independently tested
because Firebase Admin SDK writes bypass rules. No messages feature yet.
```

### Phase 11: reliable text messages and conversation UI

```text
Execute Phase 11 only. Implement server-authorized message submission, deterministic
clientMessageId, per-room sequence reservation, message outbox delivery, Firestore
transactional permission checks, bounded history/listeners, server-owned read
markers and accurate unread behavior. Build inbox, conversation and safe deep-link
navigation. Distinguish accepted from sent and failed from closed/cancelled.

Tests first: nonparticipant send, direct write denial, whitespace/Unicode limits,
same-ID retry, same ID/different text, crash after delivery before acknowledgment,
reversed message jobs, latest-preview monotonicity, unread excludes own messages,
future read marker rejection, offline retry after eligibility change and listener
cleanup. Run an emulator-backed two-user message exchange and widget states.

Definition of done: both fictional users receive text live, history paginates,
retries are exactly-once at message identity level, no duplicate bubbles appear,
and memory-only cache behavior is documented. Do not add presence or attachments.
```

### Phase 12: block, unmatch and report, including race safety

```text
Execute Phase 12 only. Implement the durable Mongo closing → Firestore revocation
→ Mongo completed protocol, operation status polling, closed tombstones and all
discovery/like/media exclusions. Add block/unblock, unmatch, report, report hide,
restricted evidence capture and explicit report-also-block UX. Unblocking never
restores a closed v1 pair. A report alone does not automatically suspend someone.

Tests first: block versus send, block versus like/accept, close versus provision,
outage before revocation, crash after revocation, stale retry, both block directions,
unmatch retry, unauthorized operation poll, evidence from unrelated room and report
without block. Assert new reads and sends fail after completed closure. Assert
pending is reported honestly while Firebase is unavailable. Test controlled races
with barriers and real Mongo/Firebase emulators, not only sequential mocks.

Definition of done: safety actions work from profile/like/chat menus, content hides
locally immediately, remote revocation completes durably, and stale events cannot
reopen access. Explain that already-read or copied content cannot be retracted.
```

### Phase 13: audited moderation and admin interface

```text
Execute Phase 13 only. Implement server-managed staff roles, recent-auth evidence
access, report queue/case detail, assignment/revision checks, photo/prompt review,
suspend/restore and append-only audit records. Build a minimal internal admin UI
using the approved Flutter target. Add synthetic local staff fixtures, not auth
bypasses. Suspension uses account guards and global Firestore access revocation.

Tests first: forged role, ordinary user on every admin route, unrelated evidence,
stale case revision, missing action reason, pending content publication, double
review, suspension racing with send/accept, restoration does not reopen closed
rooms and every sensitive action produces one audit record. Verify logs contain
no evidence content, tokens, message text or private account details.

Definition of done: a moderator can process a fictional case and review content
without broad access to all chats. Account suspension is immediately enforced
for new actions and durable for Firebase read access. Do not invent operational
staff coverage or label profiles identity verified.
```

### Phase 14: in-app notifications and approved push adapter

```text
Execute Phase 14 only. Implement recipient-scoped in-app notifications, unread/read
state, stable dedupe IDs, device registration/revocation, notification preferences
and authorized deep links. Add Firebase Cloud Messaging only if approved; otherwise
ship a tested push adapter interface and recording local fake, clearly labeled.

Tests first: duplicate job, transient failure, invalid token cleanup, shared-device
account switch, sign-out token removal, preferences off, neutral lock-screen
payload, unmatch/block before delivery, stale push tap and wrong-user notification
reads. Recheck current state before sends, while documenting unavoidable timing
and duplicate limits across external push delivery.

Definition of done: likes/matches/messages create appropriate in-app items without
duplicates, private bodies are absent from push, and deep links always reauthorize.
Do not claim physical-device push has passed unless actually tested on a configured
device. A local fake is not proof of FCM delivery.
```

### Phase 15: pause, deletion and complete account lifecycle

```text
Execute Phase 15 only after retention and deletion policy decisions are recorded.
Implement pause/resume, notification settings, blocked list, recent-auth deletion
request, immediate account restriction and resumable cleanup across MongoDB,
Firestore messages/subcollections, private media, Firebase Auth and device tokens.
Implement user-visible job states and restricted retained-report evidence exactly
according to the approved policy, with no fabricated compliance claims.

Tests first: pause preserves existing chat but prevents new introduction actions,
pause/resume eligibility checks, stale auth deletion, duplicate deletion requests,
account guard versus send/accept, failure/restart after each external cleanup step,
Firestore child-collection cleanup, hidden media access and token invalidation.
Test retry after partial Auth deletion without requiring the deleted user to log in
again for the worker to finish. Operation status access needs a documented policy.

Definition of done: a person can pause safely and delete via a truthful durable
workflow; all cleanup targets are accounted for and no active access remains after
completed deletion. Record the real retention policy and unresolved launch issues.
```

### Phase 16: localization, accessibility and poor-network polish

```text
Execute Phase 16 only. Audit every shipped screen for localization resources,
Unicode/grapheme behavior, text scaling, semantics, focus, contrast, reduced motion,
keyboard insets, safe areas, slow image loading and failed/retried operations.
Ship only approved languages reviewed by a competent speaker. Keep unreviewed
translations behind an unavailable locale rather than presenting them as complete.

Tests first for discovered failures: narrow screens, 200% text scaling, long names,
Ethiopic text, emoji clusters, multiline errors, denied photo permissions, interrupted
uploads, expired auth, offline accepted messages and error recovery. Add meaningful
goldens without normalizing obvious visual bugs into the baseline. Verify sensitive
local data and listeners clear on sign-out and safety closure.

Definition of done: core journeys remain usable with accessibility settings and
slow/offline transitions. Perform available native screen reader/device checks and
report anything not run. No copy claims a pending server action is completed.
```

### Phase 17: races, reconciliation, query plans and reliability

```text
Execute Phase 17 only. Implement and run the complete required race/failure matrix,
including account and pair guards, quota contention, opposite likes, reversed jobs,
lease expiry, stale provisioning, close-before-create, send-before/after-revocation,
partial deletion and read permission removal. Add safe reconciliation and local
repair tools that cannot reopen terminal state. Protect all scripts from production
execution by default. Test replay with deterministic fixtures.

Generate at least 10,000 fictional profiles; inspect actual discovery/index query
plans and bounded request behavior. Measure provisional latency and image-memory
targets in a documented local environment. Do not introduce infrastructure services
to hide poor query design. Document observed results rather than invented SLAs.

Definition of done: real integration evidence demonstrates invariants across
concurrency and crashes, no unbounded hot-path reads/listeners exist, dead-letter
jobs are diagnosable without sensitive logs, and reconciliation is safe to repeat.
Do not hide intermittent failures with retries in the test runner.
```

### Phase 18: full local beta acceptance and handoff

```text
Execute Phase 18 only. Read all requirements and phase evidence. Run available full
checks from a clean local fixture reset. Run the complete journey with two fictional
people: sign-up/verification → adult onboarding → reviewed profile → discovery →
content like/comment → acceptance → one match → chat/read → report/block → denied
further access. Separately verify pause, admin suspension, recovery and deletion.

Check native navigation, keyboard/photo picker and accessibility on every available
approved platform. Create docs/beta-readiness.md with delivered features, exact test
commands/results, untested platforms, known defects, operational decisions and
out-of-scope work. Update the requirement-to-test mapping and progress accurately.

Definition of done: no critical auth/privacy/safety/matching defect remains known;
missing required integration evidence is a blocker, not a footnote. Clearly
distinguish locally validated beta readiness from public-launch readiness. Do not
deploy, select hosting, create production resources or claim store approval.
```

## 12. Review checklist and workflow for the owner

1. Answer Phase 00 decisions. The stack is already confirmed; no need to revisit it.
2. Give the agent this document and the master prompt, then Phase 00 or the next incomplete phase.
3. Review the UI gallery before connecting every screen to business logic.
4. Require the agent's actual test output at each phase. Review negative cases, not only happy paths.
5. Keep changes small enough to inspect. Run focused checks per phase and a full milestone suite after onboarding, matching/chat, safety and final acceptance.
6. Record changes to product rules in the decisions file before changing code and tests together.
7. Never let “the UI works” substitute for backend authorization, Firebase rule tests or concurrency tests.
8. Select hosting later. Nothing in this roadmap depends on committing to a VPS or cloud host now.

### Suggested completion report format for every phase

```text
Phase:
Requirements delivered:
Files changed:
Tests written and expected behaviors:
Commands actually executed:
Results, including failures and skipped/unavailable checks:
UI/device checks actually performed:
Privacy/security/concurrency evidence:
Known limitations and unresolved decisions:
Progress checklist updates:
Next phase:
```

## 13. Primary technical references

These references support platform behavior. The product choices, UI design,
database ownership, closure protocol and test matrix above are proposed design
decisions, not vendor guarantees. Implementation agents should verify current
compatible SDK versions and native setup against official documentation.

- Flutter architecture: https://docs.flutter.dev/app-architecture
- Flutter integration testing: https://docs.flutter.dev/testing/integration-tests
- Firebase token verification: https://firebase.google.com/docs/auth/admin/verify-id-tokens
- Firestore security rule conditions, server SDK bypass behavior and query constraints: https://firebase.google.com/docs/firestore/security/rules-conditions
- Firebase Rules unit testing and emulator setup: https://firebase.google.com/docs/rules/unit-tests
- Cloud Storage rule conditions: https://firebase.google.com/docs/storage/security/rules-conditions
- MongoDB transaction semantics and supported deployment types: https://www.mongodb.com/docs/manual/core/transactions/

End of specification. This is a detailed proposed build plan and set of implementation prompts, not a claim that the app or its tests already exist.
