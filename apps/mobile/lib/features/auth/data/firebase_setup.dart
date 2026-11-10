import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart';

import 'auth_repository.dart';
import 'firebase_auth_repository.dart';

/// Firebase client configuration, read from `--dart-define` values (or
/// `--dart-define-from-file`). Nothing real is committed: see
/// `apps/mobile/README.md` and `config/firebase.example.json`.
///
/// These are FlutterFire `FirebaseOptions` values. They identify the project
/// to Firebase; they are not secrets, but they stay out of the repo so each
/// environment (emulator, staging, production) is chosen at build time.
class FirebaseSettings {
  const FirebaseSettings({
    this.apiKey = '',
    this.appId = '',
    this.messagingSenderId = '',
    this.projectId = '',
    this.authDomain = '',
    this.iosBundleId = '',
    this.authEmulatorHost = '',
  });

  factory FirebaseSettings.fromEnvironment() => const FirebaseSettings(
    apiKey: String.fromEnvironment('LEMON_FIREBASE_API_KEY'),
    appId: String.fromEnvironment('LEMON_FIREBASE_APP_ID'),
    messagingSenderId: String.fromEnvironment(
      'LEMON_FIREBASE_MESSAGING_SENDER_ID',
    ),
    projectId: String.fromEnvironment('LEMON_FIREBASE_PROJECT_ID'),
    authDomain: String.fromEnvironment('LEMON_FIREBASE_AUTH_DOMAIN'),
    iosBundleId: String.fromEnvironment('LEMON_FIREBASE_IOS_BUNDLE_ID'),
    authEmulatorHost: String.fromEnvironment('LEMON_AUTH_EMULATOR_HOST'),
  );

  final String apiKey;
  final String appId;
  final String messagingSenderId;
  final String projectId;

  /// Web only.
  final String authDomain;

  /// iOS/macOS only.
  final String iosBundleId;

  /// `host:port` of the Firebase Auth emulator, e.g. `127.0.0.1:9099`
  /// (`10.0.2.2:9099` from an Android emulator). Development only.
  final String authEmulatorHost;

  /// The project ID used against the emulator when none is given. Matches
  /// `FIREBASE_PROJECT_ID` in `apps/api/.env.example`, so the API accepts the
  /// emulator's tokens.
  static const emulatorDefaultProjectId = 'lemon-dev';

  bool get hasProjectOptions =>
      apiKey.isNotEmpty &&
      appId.isNotEmpty &&
      messagingSenderId.isNotEmpty &&
      projectId.isNotEmpty;

  bool get usesEmulator => authEmulatorHost.isNotEmpty;

  /// Whether Firebase can start: real options, or the emulator (which accepts
  /// placeholder options).
  bool get canInitialize => hasProjectOptions || usesEmulator;

  FirebaseOptions toOptions() => FirebaseOptions(
    apiKey: apiKey,
    appId: appId,
    messagingSenderId: messagingSenderId,
    projectId: projectId,
    authDomain: authDomain.isEmpty ? null : authDomain,
    iosBundleId: iosBundleId.isEmpty ? null : iosBundleId,
  );

  /// Parses [authEmulatorHost]; null when it is not `host:port`.
  ({String host, int port})? get emulatorAddress {
    final separator = authEmulatorHost.lastIndexOf(':');
    if (separator <= 0) return null;
    final port = int.tryParse(authEmulatorHost.substring(separator + 1));
    if (port == null) return null;
    return (host: authEmulatorHost.substring(0, separator), port: port);
  }
}

/// Starts Firebase and returns the auth repository the app should use.
///
/// Falls back to [UnconfiguredAuthRepository] when the build has no Firebase
/// configuration or Firebase fails to start, so the app still opens and the
/// welcome screen explains that sign-in is unavailable.
Future<AuthRepository> createAuthRepository(FirebaseSettings settings) async {
  if (!settings.canInitialize) {
    debugPrint('Firebase is not configured for this build; sign-in is off.');
    return const UnconfiguredAuthRepository();
  }
  try {
    final FirebaseApp app;
    if (settings.hasProjectOptions) {
      app = await Firebase.initializeApp(options: settings.toOptions());
    } else {
      // Emulator without real options: FlutterFire's demo placeholders
      app = await Firebase.initializeApp(
        demoProjectId: settings.projectId.isEmpty
            ? FirebaseSettings.emulatorDefaultProjectId
            : settings.projectId,
      );
    }
    final auth = FirebaseAuth.instanceFor(app: app);
    if (settings.usesEmulator) {
      final address = settings.emulatorAddress;
      if (address == null) {
        debugPrint('LEMON_AUTH_EMULATOR_HOST must be host:port; sign-in is off.');
        return const UnconfiguredAuthRepository();
      }
      await auth.useAuthEmulator(address.host, address.port);
    }
    return FirebaseAuthRepository(auth);
  } on Object catch (e) {
    // Only the error type: messages can include configuration values
    debugPrint('Firebase failed to start (${e.runtimeType}); sign-in is off.');
    return const UnconfiguredAuthRepository();
  }
}
