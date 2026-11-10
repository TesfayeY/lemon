import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lemon/core/api/api_exception.dart';
import 'package:lemon/core/l10n/l10n.dart';
import 'package:lemon/features/auth/data/auth_failure.dart';
import 'package:lemon/features/auth/data/firebase_setup.dart';
import 'package:lemon/features/auth/domain/credentials.dart';
import 'package:lemon/features/auth/ui/auth_messages.dart';

void main() {
  late AppLocalizations l10n;

  setUpAll(() async {
    l10n = await AppLocalizations.delegate.load(const Locale('en'));
  });

  group('Firebase error codes', () {
    test('wrong password and unknown user map to one code and message', () {
      const sameAnswer = [
        'wrong-password',
        'user-not-found',
        'invalid-credential',
        'invalid-login-credentials',
      ];
      for (final code in sameAnswer) {
        expect(
          authErrorCodeFromFirebase(code),
          AuthErrorCode.invalidCredentials,
          reason: code,
        );
      }
      expect(
        authFailureMessage(l10n, authErrorCodeFromFirebase('wrong-password')),
        authFailureMessage(l10n, authErrorCodeFromFirebase('user-not-found')),
      );
    });

    test('maps the codes the screens handle', () {
      expect(authErrorCodeFromFirebase('too-many-requests'), AuthErrorCode.tooManyRequests);
      expect(authErrorCodeFromFirebase('network-request-failed'), AuthErrorCode.network);
      expect(authErrorCodeFromFirebase('email-already-in-use'), AuthErrorCode.emailInUse);
      expect(authErrorCodeFromFirebase('invalid-email'), AuthErrorCode.invalidEmail);
      expect(authErrorCodeFromFirebase('weak-password'), AuthErrorCode.weakPassword);
      expect(
        authErrorCodeFromFirebase('password-does-not-meet-requirements'),
        AuthErrorCode.weakPassword,
      );
      expect(authErrorCodeFromFirebase('user-disabled'), AuthErrorCode.userDisabled);
      expect(authErrorCodeFromFirebase('user-token-expired'), AuthErrorCode.sessionExpired);
      expect(authErrorCodeFromFirebase('invalid-user-token'), AuthErrorCode.sessionExpired);
      expect(authErrorCodeFromFirebase('operation-not-allowed'), AuthErrorCode.notConfigured);
      expect(authErrorCodeFromFirebase('something-new'), AuthErrorCode.unknown);
    });

    test('only session failures end the session', () {
      expect(
        AuthErrorCode.values.where((c) => c.endsSession),
        unorderedEquals([AuthErrorCode.sessionExpired, AuthErrorCode.userDisabled]),
      );
    });

    test('every code has friendly copy that never echoes provider text', () {
      for (final code in AuthErrorCode.values) {
        final message = authFailureMessage(l10n, code);
        expect(message.trim(), isNotEmpty, reason: code.name);
        expect(message.toLowerCase(), isNot(contains('firebase')), reason: code.name);
        expect(message, isNot(contains('auth/')), reason: code.name);
      }
      expect(authFailureMessage(l10n, AuthErrorCode.network), l10n.errorOffline);
      expect(
        authFailureMessage(l10n, AuthErrorCode.tooManyRequests),
        'Too many attempts. Please wait a few minutes and try again.',
      );
    });

    test('API failures keep their existing copy', () {
      expect(
        describeAuthError(l10n, const NetworkException('offline')),
        l10n.errorOffline,
      );
      expect(
        describeAuthError(l10n, const AuthFailure(AuthErrorCode.invalidCredentials)),
        l10n.authErrorInvalidCredentials,
      );
    });
  });

  group('password policy', () {
    const policy = PasswordPolicy.lemon;

    test('requires 8+ characters with lower, upper and a number', () {
      expect(policy.accepts('Sunrise2026'), isTrue);
      expect(policy.unmet('short1A'), [PasswordRequirement.minLength]);
      expect(policy.unmet('sunrise2026'), [PasswordRequirement.uppercase]);
      expect(policy.unmet('SUNRISE2026'), [PasswordRequirement.lowercase]);
      expect(policy.unmet('Sunriseabc'), [PasswordRequirement.numeric]);
      expect(policy.unmet(''), [
        PasswordRequirement.minLength,
        PasswordRequirement.lowercase,
        PasswordRequirement.uppercase,
        PasswordRequirement.numeric,
      ]);
    });

    test('uses Firebase character classes (ASCII letters and digits)', () {
      // Non-ASCII letters and digits do not count, as in Firebase
      expect(policy.unmet('ÉÉÉÉÉÉ12a'), [PasswordRequirement.uppercase]);
      expect(policy.unmet('Sunrise١٢٣'), [PasswordRequirement.numeric]);
      const symbols = PasswordPolicy(requireNonAlphanumeric: true);
      expect(symbols.accepts('abcdef!'), isTrue);
      expect(symbols.accepts('abcdef€'), isFalse);
    });

    test('enforces the 4096 character maximum', () {
      final long = 'Aa1${'x' * 4094}';
      expect(policy.unmet(long), [PasswordRequirement.maxLength]);
    });

    test('every rule has a label', () {
      for (final r in PasswordRequirement.values) {
        expect(passwordRequirementLabel(l10n, policy, r), isNotEmpty);
      }
      expect(
        passwordRequirementLabel(l10n, policy, PasswordRequirement.minLength),
        'At least 8 characters',
      );
    });
  });

  test('email shape check', () {
    expect(looksLikeEmail(' hanna@example.test '), isTrue);
    expect(looksLikeEmail('hanna@example'), isFalse);
    expect(looksLikeEmail('hanna example.test'), isFalse);
    expect(emailError(l10n, ''), l10n.authEmailRequired);
    expect(emailError(l10n, 'nope'), l10n.authEmailInvalid);
    expect(emailError(l10n, 'hanna@example.test'), isNull);
  });

  group('Firebase settings', () {
    test('a build without configuration cannot start Firebase', () {
      const settings = FirebaseSettings();
      expect(settings.canInitialize, isFalse);
      expect(FirebaseSettings.fromEnvironment().canInitialize, isFalse);
    });

    test('the emulator works without real project options', () {
      const settings = FirebaseSettings(authEmulatorHost: '127.0.0.1:9099');
      expect(settings.canInitialize, isTrue);
      expect(settings.hasProjectOptions, isFalse);
      expect(settings.emulatorAddress, (host: '127.0.0.1', port: 9099));
      expect(FirebaseSettings.emulatorDefaultProjectId, 'lemon-dev');
    });

    test('rejects an emulator host without a port', () {
      expect(const FirebaseSettings(authEmulatorHost: 'localhost').emulatorAddress, isNull);
      expect(const FirebaseSettings(authEmulatorHost: 'localhost:x').emulatorAddress, isNull);
    });

    test('real options need all four values', () {
      const settings = FirebaseSettings(
        apiKey: 'placeholder-key',
        appId: '1:1:android:1',
        messagingSenderId: '1',
        projectId: 'lemon-staging',
      );
      expect(settings.hasProjectOptions, isTrue);
      expect(settings.toOptions().projectId, 'lemon-staging');
      expect(settings.toOptions().authDomain, isNull);
    });
  });
}
