import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lemon/features/auth/data/auth_failure.dart';
import 'package:lemon/features/auth/data/auth_repository.dart';

import '../../helpers/fake_auth.dart';
import '../../helpers/fake_backend.dart';
import '../../helpers/harness.dart';
import '../profile/editing_test.dart' show readyBackend;

const invalidCredentials =
    "That email and password don't match an account. Check them and try again.";
const offline = 'You are offline. Check your connection and try again.';

Finder field(String label) => find.widgetWithText(TextField, label);
Finder button(String label) => find.widgetWithText(ElevatedButton, label);

Future<void> signIn(
  WidgetTester tester, {
  String email = testEmail,
  String password = testPassword,
}) async {
  await tapVisible(tester, find.text('I already have an account'));
  await tester.enterText(field('Email'), email);
  await tester.enterText(field('Password'), password);
  await tapVisible(tester, button('Sign in'));
}

Future<void> fillCreateAccount(
  WidgetTester tester, {
  String email = 'selam@example.test',
  String password = testPassword,
  String? confirm,
}) async {
  await tester.enterText(field('Email'), email);
  await tester.enterText(field('Password'), password);
  await tester.enterText(field('Confirm password'), confirm ?? password);
  await tester.pump();
}

/// Firebase never reports a session (still restoring).
class _NeverRestores extends FakeAuthRepository {
  _NeverRestores() : super(signedIn: false);

  @override
  Stream<AuthUser?> userChanges() => const Stream.empty();
}

void main() {
  group('app gate routing', () {
    testWidgets('waits for Firebase before choosing a screen', (tester) async {
      await pumpLemon(
        tester,
        backend: FakeBackend(),
        auth: _NeverRestores(),
        settle: false,
      );
      expect(find.text('Loading…'), findsOneWidget);
      expect(find.text('Create account'), findsNothing);
    });

    testWidgets('signed out shows the welcome screen and calls no API', (
      tester,
    ) async {
      final backend = FakeBackend();
      await pumpLemon(
        tester,
        backend: backend,
        auth: FakeAuthRepository(signedIn: false),
      );
      expect(find.text('Lemon'), findsOneWidget);
      expect(find.text('Create account'), findsOneWidget);
      expect(find.text('I already have an account'), findsOneWidget);
      expect(find.text('Lemon is for adults 18 and older.'), findsOneWidget);
      expect(backend.requests, isEmpty);
    });

    testWidgets('unverified email shows the verify screen before bootstrap', (
      tester,
    ) async {
      final backend = FakeBackend();
      await pumpLemon(
        tester,
        backend: backend,
        auth: FakeAuthRepository(verified: false),
      );
      expect(find.text('Verify your email'), findsOneWidget);
      expect(find.textContaining(testEmail), findsOneWidget);
      expect(backend.requests, isEmpty);
    });

    testWidgets('signed in and onboarding goes to the onboarding flow', (
      tester,
    ) async {
      final backend = FakeBackend();
      await pumpLemon(tester, backend: backend);
      expect(find.text('Step 1 of 9'), findsOneWidget);
      expect(backend.sent('POST', '/v1/me/bootstrap'), hasLength(1));
      expect(
        backend.requests.first.headers['authorization'],
        'Bearer test-token',
      );
    });

    testWidgets('signed in and active goes to the main app', (tester) async {
      await pumpLemon(tester, backend: readyBackend());
      expect(find.byType(NavigationBar), findsOneWidget);
    });

    testWidgets('expired session shows the signed-out screen', (tester) async {
      final auth = FakeAuthRepository()
        ..tokenFailure = const AuthFailure(AuthErrorCode.sessionExpired);
      await pumpLemon(tester, backend: FakeBackend(), auth: auth);
      expect(find.text('Please sign in again'), findsOneWidget);
      expect(find.byType(NavigationBar), findsNothing);
    });

    testWidgets('a restricted account can sign out', (tester) async {
      final backend = FakeBackend()
        ..failNext(
          'POST',
          '/v1/me/bootstrap',
          status: 403,
          error: {
            'code': 'ACCOUNT_RESTRICTED',
            'message': 'This account is not available',
            'retryable': false,
          },
        );
      await pumpLemon(tester, backend: backend);
      expect(find.text('This account is not available'), findsOneWidget);
      await tapVisible(tester, find.widgetWithText(OutlinedButton, 'Sign out'));
      expect(find.text('I already have an account'), findsOneWidget);
    });

    testWidgets('a build without Firebase config says sign-in is off', (
      tester,
    ) async {
      await pumpLemon(
        tester,
        backend: FakeBackend(),
        auth: FakeAuthRepository(signedIn: false, isConfigured: false),
      );
      expect(
        find.text("Sign-in isn't set up in this build yet. Please try again later."),
        findsOneWidget,
      );
    });
  });

  group('create account', () {
    Future<FakeAuthRepository> open(WidgetTester tester) async {
      final auth = FakeAuthRepository(signedIn: false);
      await pumpLemon(tester, backend: FakeBackend(), auth: auth);
      await tapVisible(tester, button('Create account'));
      expect(find.text('Create your account'), findsOneWidget);
      return auth;
    }

    testWidgets('checks fields before calling Firebase', (tester) async {
      final auth = await open(tester);
      await tapVisible(tester, button('Create account'));
      expect(find.text('Enter your email address.'), findsOneWidget);
      expect(find.text('Enter your password.'), findsOneWidget);

      await fillCreateAccount(
        tester,
        email: 'selam@',
        password: 'sunrise',
        confirm: 'sunrise!',
      );
      await tapVisible(tester, button('Create account'));
      expect(
        find.text('Enter a valid email address, like name@example.com.'),
        findsOneWidget,
      );
      expect(
        find.text('Choose a password that meets every requirement below.'),
        findsOneWidget,
      );
      expect(find.text("The passwords don't match."), findsOneWidget);
      expect(auth.accounts.keys, [testEmail]);
    });

    testWidgets('the password checklist follows typing with labels', (
      tester,
    ) async {
      await open(tester);
      await tester.enterText(field('Password'), 'sunrise');
      await tester.pump();
      expect(find.bySemanticsLabel('Done: A lowercase letter'), findsOneWidget);
      expect(
        find.bySemanticsLabel('Still needed: At least 8 characters'),
        findsOneWidget,
      );
      expect(find.bySemanticsLabel('Still needed: An uppercase letter'), findsOneWidget);
      expect(find.bySemanticsLabel('Still needed: A number'), findsOneWidget);

      await tester.enterText(field('Password'), testPassword);
      await tester.pump();
      expect(find.bySemanticsLabel(RegExp('^Still needed')), findsNothing);
    });

    testWidgets('success leads to verify email with the resend cooldown', (
      tester,
    ) async {
      final auth = await open(tester);
      await fillCreateAccount(tester);
      await tapVisible(tester, button('Create account'));

      expect(auth.accounts.containsKey('selam@example.test'), isTrue);
      expect(auth.verificationEmails, 1);
      expect(find.text('Verify your email'), findsOneWidget);
      expect(find.textContaining('selam@example.test'), findsOneWidget);
      expect(find.text('Resend in 60 seconds'), findsOneWidget);
      // Nothing from the sign-up screens stays on the stack
      expect(find.byType(BackButton), findsNothing);
    });

    testWidgets('an existing email gets a friendly message', (tester) async {
      await open(tester);
      await fillCreateAccount(tester, email: testEmail);
      await tapVisible(tester, button('Create account'));
      expect(
        find.text('An account already uses this email. Sign in, or reset your password.'),
        findsOneWidget,
      );
      expect(find.text('Create your account'), findsOneWidget);
    });

    testWidgets('shows loading while Firebase works', (tester) async {
      final auth = await open(tester);
      await fillCreateAccount(tester);
      auth.hold = Completer<void>();
      await tapVisible(tester, button('Create account'), settle: false);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      final submit = tester.widget<ElevatedButton>(find.byType(ElevatedButton));
      expect(submit.onPressed, isNull);
      auth.hold!.complete();
      await tester.pumpAndSettle();
      expect(find.text('Verify your email'), findsOneWidget);
    });
  });

  group('sign in', () {
    testWidgets('signs in, then bootstraps and opens onboarding', (
      tester,
    ) async {
      final backend = FakeBackend();
      await pumpLemon(
        tester,
        backend: backend,
        auth: FakeAuthRepository(signedIn: false),
      );
      await signIn(tester);
      expect(find.text('Step 1 of 9'), findsOneWidget);
      expect(backend.sent('POST', '/v1/me/bootstrap'), hasLength(1));
      expect(find.byType(BackButton), findsNothing);
    });

    testWidgets('wrong password and unknown email show the same message', (
      tester,
    ) async {
      await pumpLemon(
        tester,
        backend: FakeBackend(),
        auth: FakeAuthRepository(signedIn: false),
      );
      await signIn(tester, password: 'NotMyPassword1');
      expect(find.text(invalidCredentials), findsOneWidget);

      await tester.enterText(field('Email'), 'nobody@example.test');
      await tester.enterText(field('Password'), testPassword);
      await tapVisible(tester, button('Sign in'));
      expect(find.text(invalidCredentials), findsOneWidget);
      expect(find.text('Welcome back'), findsOneWidget);
    });

    testWidgets('too many attempts and offline have their own copy', (
      tester,
    ) async {
      final auth = FakeAuthRepository(signedIn: false);
      await pumpLemon(tester, backend: FakeBackend(), auth: auth);
      auth.failNext = const AuthFailure(AuthErrorCode.tooManyRequests);
      await signIn(tester);
      expect(
        find.text('Too many attempts. Please wait a few minutes and try again.'),
        findsOneWidget,
      );
      auth.failNext = const AuthFailure(AuthErrorCode.network);
      await tapVisible(tester, button('Sign in'));
      expect(find.text(offline), findsOneWidget);
    });

    testWidgets('an unverified account goes to verify email', (tester) async {
      await pumpLemon(
        tester,
        backend: FakeBackend(),
        auth: FakeAuthRepository(signedIn: false, verified: false),
      );
      await signIn(tester);
      expect(find.text('Verify your email'), findsOneWidget);
      // No cooldown: this device has not sent an email yet
      expect(find.text('Resend email'), findsOneWidget);
    });
  });

  group('forgot password', () {
    Future<FakeAuthRepository> open(WidgetTester tester, String email) async {
      final auth = FakeAuthRepository(signedIn: false);
      await pumpLemon(tester, backend: FakeBackend(), auth: auth);
      await tapVisible(tester, find.text('I already have an account'));
      await tester.enterText(field('Email'), email);
      await tapVisible(tester, find.text('Forgot password?'));
      expect(find.text('Reset your password'), findsOneWidget);
      return auth;
    }

    String neutral(String email) =>
        "If an account uses $email, we've sent it a link to reset the "
        'password. It can take a few minutes, so check your spam folder too.';

    testWidgets('confirms the same way for a known address', (tester) async {
      final auth = await open(tester, testEmail);
      // Prefilled from the sign-in screen
      expect(find.widgetWithText(TextField, testEmail), findsOneWidget);
      await tapVisible(tester, button('Send reset link'));
      expect(find.text(neutral(testEmail)), findsOneWidget);
      expect(auth.resetEmailsSent, [testEmail]);

      await tapVisible(tester, button('Back to sign in'));
      expect(find.text('Welcome back'), findsOneWidget);
    });

    testWidgets('…and for an unknown one', (tester) async {
      final auth = await open(tester, 'nobody@example.test');
      await tapVisible(tester, button('Send reset link'));
      expect(find.text('Check your email'), findsOneWidget);
      expect(find.text(neutral('nobody@example.test')), findsOneWidget);
      expect(auth.resetRequests, ['nobody@example.test']);
      expect(auth.resetEmailsSent, isEmpty);
    });

    testWidgets('offline is reported, not confirmed', (tester) async {
      final auth = await open(tester, testEmail);
      auth.failNext = const AuthFailure(AuthErrorCode.network);
      await tapVisible(tester, button('Send reset link'));
      expect(find.text(offline), findsOneWidget);
      expect(find.text('Check your email'), findsNothing);
    });
  });

  group('verify email', () {
    testWidgets('resend waits out the cooldown, then restarts it', (
      tester,
    ) async {
      final auth = FakeAuthRepository(signedIn: false);
      await pumpLemon(tester, backend: FakeBackend(), auth: auth);
      await tapVisible(tester, button('Create account'));
      await fillCreateAccount(tester);
      await tapVisible(tester, button('Create account'));

      Finder resend(String label) => find.widgetWithText(OutlinedButton, label);
      expect(
        tester.widget<OutlinedButton>(resend('Resend in 60 seconds')).onPressed,
        isNull,
      );
      await tester.pump(const Duration(seconds: 59));
      expect(find.text('Resend in 1 second'), findsOneWidget);
      await tester.pump(const Duration(seconds: 1));
      expect(tester.widget<OutlinedButton>(resend('Resend email')).onPressed, isNotNull);

      await tapVisible(tester, resend('Resend email'), settle: false);
      await tester.pump();
      expect(auth.verificationEmails, 2);
      expect(
        find.text('We sent a new link. It can take a few minutes to arrive.'),
        findsOneWidget,
      );
      expect(find.text('Resend in 60 seconds'), findsOneWidget);
      await tester.pump(const Duration(seconds: 60));
    });

    testWidgets("\"I've verified\" re-checks and moves on once verified", (
      tester,
    ) async {
      final auth = FakeAuthRepository(verified: false);
      final backend = FakeBackend();
      await pumpLemon(tester, backend: backend, auth: auth);

      await tapVisible(tester, button("I've verified my email"));
      expect(
        find.text("We couldn't confirm your email yet. Open the link we sent, then try again."),
        findsOneWidget,
      );
      expect(backend.requests, isEmpty);

      auth.openVerificationLink();
      await tapVisible(tester, button("I've verified my email"));
      expect(find.text('Step 1 of 9'), findsOneWidget);
      // A fresh token (with email_verified) before the bootstrap
      expect(auth.tokenRequests.first, isTrue);
      expect(auth.reloads, 2);
    });

    testWidgets('a different account signs out', (tester) async {
      final auth = FakeAuthRepository(verified: false);
      await pumpLemon(tester, backend: FakeBackend(), auth: auth);
      await tapVisible(tester, find.text('Use a different account'));
      expect(find.text('I already have an account'), findsOneWidget);
      expect(auth.signOuts, 1);
    });

    testWidgets('the onboarding step covers a stale server claim', (
      tester,
    ) async {
      final backend = FakeBackend()..emailVerified = false;
      await pumpLemon(tester, backend: backend);
      expect(find.text('Verify your email'), findsOneWidget);
      expect(find.text('Step 1 of 10'), findsOneWidget);

      backend.emailVerified = true; // the refreshed token carries the claim
      await tapVisible(tester, button("I've verified my email"));
      expect(find.text("When's your birthday?"), findsOneWidget);
    });
  });

  group('sign out and expiry', () {
    testWidgets('sign out from the You tab asks first', (tester) async {
      final auth = FakeAuthRepository();
      await pumpLemon(tester, backend: readyBackend(), auth: auth);
      await tester.tap(find.text('You').last);
      await tester.pumpAndSettle();
      await scrollToVisible(tester, find.text('Signed in as $testEmail'));
      expect(find.text('Signed in as $testEmail'), findsOneWidget);

      await tapVisible(tester, find.widgetWithText(ListTile, 'Sign out'));
      expect(find.text('Sign out of Lemon?'), findsOneWidget);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(auth.signOuts, 0);

      await tapVisible(tester, find.widgetWithText(ListTile, 'Sign out'));
      await tester.tap(find.widgetWithText(TextButton, 'Sign out'));
      await tester.pumpAndSettle();
      expect(auth.signOuts, 1);
      expect(find.text('I already have an account'), findsOneWidget);
      expect(find.byType(NavigationBar), findsNothing);
    });

    testWidgets('signing out from a pushed screen clears the stack', (
      tester,
    ) async {
      final auth = FakeAuthRepository();
      await pumpLemon(tester, backend: readyBackend(), auth: auth);
      await tester.tap(find.text('You').last);
      await tester.pumpAndSettle();
      await tapVisible(tester, find.text('Preview your profile'));
      auth.dropSession();
      await tester.pumpAndSettle();
      expect(find.text('Please sign in again'), findsOneWidget);
      expect(find.byType(BackButton), findsNothing);
    });

    testWidgets('a server 401 on a fresh token signs out as expired', (
      tester,
    ) async {
      const revoked = {
        'code': 'TOKEN_REVOKED',
        'message': 'Your session has expired. Please sign in again.',
        'retryable': false,
      };
      final backend = FakeBackend()
        ..failNext('POST', '/v1/me/bootstrap', status: 401, error: revoked)
        ..failNext('POST', '/v1/me/bootstrap', status: 401, error: revoked);
      final auth = FakeAuthRepository();
      await pumpLemon(tester, backend: backend, auth: auth);
      expect(find.text('Please sign in again'), findsOneWidget);
      expect(auth.tokenRequests, [false, true]);
      expect(auth.signOuts, 1);
    });

    testWidgets('after expiry, signing in returns to the app', (tester) async {
      final auth = FakeAuthRepository();
      await pumpLemon(tester, backend: readyBackend(), auth: auth);
      auth.dropSession();
      await tester.pumpAndSettle();
      expect(find.text('Please sign in again'), findsOneWidget);

      await tapVisible(tester, button('Sign in'));
      await tester.enterText(field('Email'), testEmail);
      await tester.enterText(field('Password'), testPassword);
      await tapVisible(tester, button('Sign in'));
      expect(find.byType(NavigationBar), findsOneWidget);
    });
  });
}
