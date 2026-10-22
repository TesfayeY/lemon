# Lemon App - Requirements Map

## Account & Auth

| ID | Requirement | Phase | Test Layer |
|----|------------|-------|------------|
| R-AUTH-01 | Firebase email/password sign-up with verification | 03 | API integration, Auth emulator |
| R-AUTH-02 | Sign-in, recovery, sign-out | 03 | API integration |
| R-AUTH-03 | Express verifies Firebase ID tokens (Admin SDK) | 03 | API integration |
| R-AUTH-04 | Never store passwords in MongoDB | 03 | Code review |
| R-AUTH-05 | Unique firebaseUid index; one app user per Firebase identity | 03 | Mongo integration |
| R-AUTH-06 | Idempotent identity bootstrap | 03 | Concurrency test |
| R-AUTH-07 | Account statuses: onboarding, active, suspended, deletion_pending, deleted | 03 | Domain unit |
| R-AUTH-08 | Unverified/incomplete/suspended/deleting users cannot browse or like | 03 | API integration |

## Adult Gate

| ID | Requirement | Phase | Test Layer |
|----|------------|-------|------------|
| R-AGE-01 | Server calculates adult eligibility from validated birth date | 03 | Domain unit |
| R-AGE-02 | Boundary birthday and leap day policy tested | 03 | Domain unit |
| R-AGE-03 | DOB is private; age is calculated for public views | 04 | DTO test |
| R-AGE-04 | Age self-declaration is not a verified-age badge | 03 | Documentation |

## Onboarding & Profile

| ID | Requirement | Phase | Test Layer |
|----|------------|-------|------------|
| R-PROF-01 | Resumable onboarding steps saved server-side with revision | 04, 06 | API integration |
| R-PROF-02 | Required fields: name, DOB, gender, interests, location, photos (3-6), prompts (3), intention, terms | 04 | Domain unit |
| R-PROF-03 | Server-computed readiness predicate | 04 | Domain unit |
| R-PROF-04 | Explicit public DTO allowlist; exclude private fields | 04 | DTO test |
| R-PROF-05 | Unicode names (1-40 grapheme clusters) | 04 | Domain unit |
| R-PROF-06 | Prompt answers: 3 distinct, 1-300 grapheme clusters each | 04 | Domain unit |
| R-PROF-07 | Revision conflict handling for concurrent edits | 04 | API integration |

## Photos & Media

| ID | Requirement | Phase | Test Layer |
|----|------------|-------|------------|
| R-MEDIA-01 | 10MB limit, server validates format/dimensions/integrity | 05 | API integration |
| R-MEDIA-02 | EXIF/GPS stripped, orientation normalized | 05 | Unit test |
| R-MEDIA-03 | Quarantine → moderation → approved variants | 05 | Integration |
| R-MEDIA-04 | Authenticated media reads with per-request access check | 05 | API integration |
| R-MEDIA-05 | No permanent public download URLs | 05 | Integration |

## Discovery

| ID | Requirement | Phase | Test Layer |
|----|------------|-------|------------|
| R-DISC-01 | Mutual eligibility: gender/interest, age, location, status | 07 | Domain unit, API integration |
| R-DISC-02 | Exclude blocked, unmatched, already-matched, pending-like pairs | 07 | Domain unit |
| R-DISC-03 | Bounded discovery sessions with signed cursors | 07 | API integration |
| R-DISC-04 | 30-day pass cooldown (configurable) | 07 | Domain unit |
| R-DISC-05 | Paused users excluded from discovery | 07 | Domain unit |
| R-DISC-06 | US city/state scope; mutual geographic eligibility | 07 | Domain unit |
| R-DISC-07 | No AI compatibility, ethnicity ranking, or silent preference widening | 07 | Code review |

## Likes & Matching

| ID | Requirement | Phase | Test Layer |
|----|------------|-------|------------|
| R-LIKE-01 | Content-level likes with stable target/version reference | 08 | API integration |
| R-LIKE-02 | 8 likes/UTC day quota (configurable); atomic enforcement | 08 | Concurrency test |
| R-LIKE-03 | Idempotent likes; retry does not double-charge | 08 | API integration |
| R-LIKE-04 | Self-like, blocked/paused recipient rejected | 08 | API integration |
| R-MATCH-01 | Canonical pair record; one match per pair | 09 | Mongo integration |
| R-MATCH-02 | Simultaneous opposite likes produce one match | 09 | Concurrency test |
| R-MATCH-03 | Transactional outbox for chat provisioning | 09 | Mongo integration |

## Chat

| ID | Requirement | Phase | Test Layer |
|----|------------|-------|------------|
| R-CHAT-01 | Firestore rooms with deny-by-default rules | 10 | Firebase rules test |
| R-CHAT-02 | All message writes through Express; no client writes | 10, 11 | Firebase rules test |
| R-CHAT-03 | Server-authorized message with clientMessageId | 11 | API integration |
| R-CHAT-04 | Exactly-once message delivery (idempotent) | 11 | Concurrency test |
| R-CHAT-05 | Plain text only, 1-2000 grapheme clusters | 11 | Domain unit |
| R-CHAT-06 | Bounded history (30 messages), stable pagination | 11 | API integration |
| R-CHAT-07 | Server-owned read markers; accurate unread count | 11 | Integration |

## Safety

| ID | Requirement | Phase | Test Layer |
|----|------------|-------|------------|
| R-SAFE-01 | Block hides both users, closes chat, prevents future actions | 12 | Integration, concurrency |
| R-SAFE-02 | Unmatch closes match/chat; no notification to other party | 12 | Integration |
| R-SAFE-03 | Report with reason, evidence snapshot; does not auto-suspend | 12 | API integration |
| R-SAFE-04 | Durable Mongo→Firestore→Mongo closure protocol | 12 | Failure/concurrency |
| R-SAFE-05 | Closed rooms cannot be reopened by stale jobs | 12 | Concurrency test |
| R-SAFE-06 | Unblock does not restore closed pair in v1 | 12 | Domain unit |

## Admin & Moderation

| ID | Requirement | Phase | Test Layer |
|----|------------|-------|------------|
| R-ADMIN-01 | Server-managed staff roles; no client role assignment | 13 | API integration |
| R-ADMIN-02 | Report queue, case revision checks | 13 | API integration |
| R-ADMIN-03 | Photo/prompt review workflow | 13 | Integration |
| R-ADMIN-04 | Append-only audit log | 13 | Integration |
| R-ADMIN-05 | No sensitive data in logs | 13 | Code review |

## Notifications

| ID | Requirement | Phase | Test Layer |
|----|------------|-------|------------|
| R-NOTIF-01 | In-app notifications with stable dedupe IDs | 14 | API integration |
| R-NOTIF-02 | Neutral push payloads; no private content on lock screen | 14 | Unit test |
| R-NOTIF-03 | Deep links always reauthorize | 14 | Integration |

## Account Lifecycle

| ID | Requirement | Phase | Test Layer |
|----|------------|-------|------------|
| R-LIFE-01 | Pause removes from discovery; preserves existing chats | 15 | Integration |
| R-LIFE-02 | Deletion: recent auth, durable cleanup job across all stores | 15 | Failure test |
| R-LIFE-03 | Visible job state for deletion progress | 15 | API integration |

## Privacy & General

| ID | Requirement | Phase | Test Layer |
|----|------------|-------|------------|
| R-PRIV-01 | No Firebase UID as public profile ID | 04 | DTO test |
| R-PRIV-02 | No DOB, email, moderation data in public DTOs | 04 | DTO test |
| R-PRIV-03 | No ethnicity inference from photos, names, language | All | Code review |
| R-PRIV-04 | No tokens, DOB, coordinates, message content in logs | All | Code review |
| R-PRIV-05 | Accessibility: 48px touch targets, screen reader, reduced motion | 02, 16 | Widget test, manual |
