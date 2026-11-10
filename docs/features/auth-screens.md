# Feature: Sign-in screens (Flutter)

**Branch:** `feat/auth-screens` (built on `feat/onboarding-flow`, PR #13)
**Roadmap:** Phase 03 in `docs/progress.md` (Flutter side of sign-up, sign-in, verification, recovery, sign-out)
**Spec:** `docs/specification.md` §3 (Welcome and Authentication screens), §4.1, Phase 03 prompt
**Decision:** D-07, email/password with Firebase Auth verification and recovery

## Status

Done on the Flutter side. The dev-only token sources from the onboarding
branch (`EmulatorPasswordTokenSource`, `LEMON_DEV_EMAIL`/`PASSWORD`/`ID_TOKEN`)
are gone. Every API call now carries an ID token from the Firebase Auth SDK.
No API, contract or Firebase rule changed.

The flow is: **signed out → sign-in screens → (verify email) → server
bootstrap → onboarding or main app**.

## What was built

### Layers (`lib/features/auth/`)

- `data/auth_repository.dart`: the `AuthRepository` interface (sign in, create
  account, password reset, send verification, reload, ID token, sign out, user
  stream) and `UnconfiguredAuthRepository` for builds with no Firebase config.
- `data/firebase_auth_repository.dart`: the Firebase Auth SDK implementation.
  SDK errors become `AuthFailure(AuthErrorCode)`. Firebase's message text is
  dropped because it can echo the email.
- `data/auth_failure.dart`: maps Firebase error codes to `AuthErrorCode`.
  `wrong-password`, `user-not-found`, `invalid-credential` and
  `invalid-login-credentials` all become `invalidCredentials`, which has one
  message.
- `data/firebase_setup.dart`: `FirebaseSettings.fromEnvironment()` reads
  `--dart-define` values. `createAuthRepository` starts Firebase, points it at
  the Auth emulator when `LEMON_AUTH_EMULATOR_HOST` is set, and falls back to
  the unconfigured repository if config is missing or startup fails. Nothing
  about the config is logged except the error type.
- `domain/credentials.dart`: `PasswordPolicy` mirrors Firebase's password
  policy options and character classes. `looksLikeEmail` is a shape check.
- `application/auth_controller.dart`: `AuthController` (Riverpod `Notifier`)
  follows `userChanges()` and exposes `SessionStatus` (`starting`,
  `signedOut`, `expired`, `unverified`, `signedIn`). It runs every auth action
  and is the API client's `IdTokenSource`.

### Screens

| Screen | Notes |
| --- | --- |
| Auth gate | Root widget. `starting` → loading; `signedOut` → Welcome; `expired` → Session expired; `unverified` → Verify email; `signedIn` → the existing `AppGate` (bootstrap, then onboarding, main app or restricted). Any status change pops the whole route stack, so pushed auth or settings screens never linger. |
| Welcome | Placeholder wordmark from `appName` with a woven-line accent, value statement, "for adults 18 and older", Create account / I already have an account, draft-terms note. Says when the build has no Firebase config. |
| Create account | Email, password with show/hide, confirm. A live checklist (icon + text + "Done:"/"Still needed:" semantics) follows `PasswordPolicy.lemon`. Client checks run first. Firebase errors (email in use, weak password, too many requests, offline) get friendly copy. Firebase sends the verification email after sign-up. |
| Sign in | Email, password, "Forgot password?" (carries the typed email), "New here? Create an account". Wrong password and unknown email show the same message. |
| Forgot password | Sends the Firebase reset link. The confirmation reads "If an account uses …, we've sent it a link…" whether or not the account exists (`user-not-found` counts as success). Offline and rate-limit errors are shown, never confirmed. |
| Verify email | "We sent a link to {email}", spam hint, **I've verified my email** (reloads the Firebase user; once verified it force-refreshes the ID token so the server's bootstrap sees `email_verified`), **Resend** with a 60 s cooldown and a live countdown, "Use a different account" (signs out). |
| Session expired | Signed-out screen: "Please sign in again … Your profile is saved." with Sign in. |
| Sign out | You tab → Account section: "Signed in as {email}" (own email, local only) and Sign out with a confirmation dialog. The restricted-account screen and the verify screen can also sign out. |

The onboarding `VerifyEmailStep` now reuses the same verify view. It only
appears if the server still lacks the verified claim (for example, a token
issued before the link was opened). It refreshes the user and token,
re-bootstraps and re-checks.

### Session expiry

The session ends and the **Session expired** screen shows when:

1. Getting an ID token fails with `user-token-expired`, `invalid-user-token`,
   `user-disabled` or similar. The controller signs out locally, and the API
   client gets `null` and reports `NotSignedInException`.
2. The API still answers `401` (`UNAUTHENTICATED` or `TOKEN_REVOKED`) after
   `LemonApiClient` retried with a force-refreshed token. The new
   `onUnauthorized` callback calls `AuthController.sessionRejected()`.
3. Firebase drops the user on its own (the user stream emits `null` without
   the app signing out).

An offline token refresh does **not** end the session. It surfaces as
`NetworkException`, the usual offline copy.

### Privacy and security

- Firebase Auth is the only password authority. Passwords exist only in text
  controllers and the SDK call. Nothing logs passwords, tokens, Firebase
  messages or config values.
- `AuthUser` holds no UID. The server still derives identity from the token
  only.
- Verification state on the client only picks a screen. The server reads
  `email_verified` from the verified token at bootstrap (unchanged).
- Password fields turn off autocorrect and suggestions. Autofill hints are
  `email`, `password` and `newPassword`.

### Localization and accessibility

All strings are ARB keys (`app_en.arb`), and the brand comes from `appName`.
Errors are live regions with icon + text. Every page is a single scrolling
column capped at 520 px wide. Tests cover 200% text on a 360×690 phone and
the tap-target, labeled-target and contrast guidelines on Welcome and Create
account.

## Configuration the owner must supply

Nothing real is in the repo. For each Firebase environment (staging,
production):

1. **Firebase project with Email/Password sign-in enabled** (Authentication →
   Sign-in method).
2. **Password policy** (Authentication → Settings → Password policy):
   enforce, minimum length **8**, require **uppercase**, **lowercase** and
   **numeric**. This must match `PasswordPolicy.lemon`; change both together.
   Otherwise the client checklist and Firebase disagree. The client still
   maps `password-does-not-meet-requirements`.
3. **Email enumeration protection**: recommended on. The screens already
   treat unknown user and wrong password the same.
4. **Platform apps** (Android package, iOS bundle ID) registered in the
   project, which gives the FlutterFire options per platform:
   `LEMON_FIREBASE_API_KEY`, `LEMON_FIREBASE_APP_ID`,
   `LEMON_FIREBASE_MESSAGING_SENDER_ID`, `LEMON_FIREBASE_PROJECT_ID`, plus
   `LEMON_FIREBASE_IOS_BUNDLE_ID` (iOS) and `LEMON_FIREBASE_AUTH_DOMAIN` (web).
   Pass them with `--dart-define` or `--dart-define-from-file` (template:
   `apps/mobile/config/firebase.example.json`; `config/*.local.json` is
   git-ignored). The project ID must equal the API's `FIREBASE_PROJECT_ID`.
5. **Email templates and action URL** (Authentication → Templates): sender
   name, verification and reset copy in English, using the final app name
   (P-01).
6. **Release signing**: Android SHA-1/SHA-256 in the Firebase Android app if
   any later feature needs it (email/password itself does not).

Without these values the app still builds, and tests run with a fake.

## Running against the Auth emulator

```bash
scripts/start-emulators.sh            # Auth :9099, Firestore :8080, project lemon-dev
cd apps/api && npm run dev            # with FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099
cd apps/mobile && flutter run \
  --dart-define=LEMON_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
  --dart-define=LEMON_API_BASE_URL=http://localhost:3000
```

- No real options are needed. The app starts FlutterFire's demo placeholder
  options for project `lemon-dev` (override with `LEMON_FIREBASE_PROJECT_ID`).
- Android emulator: the SDK maps `127.0.0.1` to `10.0.2.2` for Auth. Set
  `LEMON_API_BASE_URL=http://10.0.2.2:3000`.
- The emulator sends no emails. Open the verification or reset link from the
  emulator log, or from
  `http://127.0.0.1:9099/emulator/v1/projects/lemon-dev/oobCodes`, then tap
  "I've verified my email".
- The Emulator UI (`http://127.0.0.1:4000`) can disable a user or revoke
  tokens to try the session-expired screen.

## Dependencies

`firebase_core 5.1.0`, `firebase_auth 7.0.1` (both published 2026-10-23,
18 days before this branch; transitive Firebase packages are from the same
release or older) and `clock 1.1.3` (already transitive via `flutter_test`;
lets tests drive the resend cooldown). Versions are pinned exactly in
`pubspec.yaml`. `pubspec.lock` is git-ignored repo-wide, so pins are the
guarantee. firebase_core 5 needs Android minSdk 24 (Flutter's default),
iOS 15 and macOS 11+.

## Tests

`scripts/check-mobile.sh` (new) runs `flutter pub get`, `flutter analyze` and
`flutter test`.

- `test/features/auth/auth_domain_test.dart`: error-code mapping (same message
  for wrong password and unknown user, too many requests, network, session
  codes), every code has copy, password policy with Firebase character classes
  and max length, email check, Firebase settings parsing.
- `test/features/auth/auth_controller_test.dart`: restored sessions, sign-out
  vs expiry, token failure → expired, offline token keeps session, server
  rejection, sign-in after expiry, reload + forced token refresh on
  verification, 60 s cooldown.
- `test/features/auth/auth_screens_test.dart`: gate routing for every
  `SessionStatus` plus onboarding/active/restricted, no-config build, create
  account (validation, checklist semantics, success → verify with cooldown,
  email in use, loading), sign in (success → bootstrap, same message for wrong
  password and unknown email, rate limit, offline, unverified), forgot password
  (neutral message for known and unknown, offline), verify email (cooldown
  countdown, resend restarts it, "I've verified" before and after the link,
  different account, onboarding fallback), sign out from You with confirmation,
  stack cleared on expiry, server 401 → expired, sign in again after expiry.
- `test/accessibility/large_text_test.dart`: every auth screen at 200% text on
  a small phone, and tap-target, label and contrast guidelines.
- `test/core/lemon_api_client_test.dart`: `onUnauthorized` fires only when the
  refreshed token is also rejected.
- Journeys (`test/journey/onboarding_journey_test.dart` and
  `integration_test/onboarding_journey_test.dart`) now start from the welcome
  screen and sign in.
- `test/helpers/fake_auth.dart`: `FakeAuthRepository` copies Firebase's
  observable behavior (replaying user stream, verification visible only after
  reload, reset that never reveals accounts).

## Follow-ups

- On-device run against the real Auth emulator + Express API (seeded account,
  verification via `oobCodes`). This depends on the same seeded-account and
  prompt-review tooling as the onboarding follow-up.
- Native platform setup for release builds: iOS/macOS keychain sharing
  entitlement if Firebase needs it on macOS, the Android/iOS app IDs registered
  in Firebase, and an optional `GoogleService-Info.plist`/`google-services.json`
  if other Firebase products are added later. Dart-side options work for Auth.
- Recent-login re-authentication for deletion and other sensitive changes
  (§4.1). It belongs with account lifecycle (Phase 15); the
  `requires-recent-login` code already maps to session copy.
- Change email and change password in Settings (not in scope).
- Re-check verification automatically when the app returns to the foreground
  on the verify screen.
- Legal links on Welcome once final Terms and Privacy documents and URLs exist
  (today only the draft note shows).
- The welcome photo composition from the spec waits on licensed imagery and
  branding (P-01).

## Open questions

- **Password policy:** proposed minimum 8 with upper, lower and number, no
  symbol required. The owner should confirm it and configure Firebase to
  match.
- **Unverified accounts and bootstrap:** the client asks for verification
  before calling the API, but the server would bootstrap an unverified account
  (readiness lists `emailVerified`). That is fine as is. Say so if
  unverified users should never get a Mongo account.
- **Session-expired copy:** says "Your profile is saved"; confirm the tone.
