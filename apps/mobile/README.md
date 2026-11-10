# Lemon mobile app

Flutter app for iOS and Android. Sign-in uses the Firebase Auth SDK
(email/password, D-07); everything after sign-in is decided by the Express API.

## Checks

```bash
../../scripts/check-mobile.sh   # flutter pub get, analyze, test
```

Tests use a fake auth repository and an in-memory API, so they need no
Firebase configuration or network.

## Firebase configuration

**No Firebase project config or API keys are committed.** The app reads the
FlutterFire `FirebaseOptions` from `--dart-define` values at build time. With
none set, the app still builds and starts, and the welcome screen says sign-in
isn't set up.

| Define | Required | Notes |
| --- | --- | --- |
| `LEMON_FIREBASE_API_KEY` | yes* | Web API key of the platform app |
| `LEMON_FIREBASE_APP_ID` | yes* | e.g. `1:123:android:abc` (differs per platform) |
| `LEMON_FIREBASE_MESSAGING_SENDER_ID` | yes* | Project number |
| `LEMON_FIREBASE_PROJECT_ID` | yes* | Must match the API's `FIREBASE_PROJECT_ID` |
| `LEMON_FIREBASE_AUTH_DOMAIN` | web only | |
| `LEMON_FIREBASE_IOS_BUNDLE_ID` | iOS only | |
| `LEMON_AUTH_EMULATOR_HOST` | dev only | `host:port` of the Auth emulator |
| `LEMON_API_BASE_URL` | no | Defaults to `http://localhost:3000` |

\* Not needed when `LEMON_AUTH_EMULATOR_HOST` is set: the emulator accepts
placeholder options, and the project ID defaults to `lemon-dev`.

Keep values in a local, git-ignored file:

```bash
cp config/firebase.example.json config/firebase.local.json   # fill it in
flutter run --dart-define-from-file=config/firebase.local.json
```

`config/*.local.json` is ignored by git. The values (from the Firebase console,
Project settings → Your apps, or `flutterfire configure` output) identify the
project but are not secrets; they still stay out of the repo so each build
picks its environment.

## Running against the local emulators

```bash
# repo root: start the Auth (and Firestore) emulators (project lemon-dev)
scripts/start-emulators.sh
# another terminal: the API, with FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099
cd apps/api && npm run dev

# app
cd apps/mobile
flutter run \
  --dart-define=LEMON_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
  --dart-define=LEMON_API_BASE_URL=http://localhost:3000
```

Android emulators reach the host at `10.0.2.2` (the Firebase SDK maps
`127.0.0.1`/`localhost` for Auth automatically; use
`LEMON_API_BASE_URL=http://10.0.2.2:3000` for the API). Verification and
password reset emails are not sent by the emulator: open the link printed in
the emulator log, or list them at
`http://127.0.0.1:9099/emulator/v1/projects/lemon-dev/oobCodes`.

See `docs/features/auth-screens.md` for the full sign-in design.
