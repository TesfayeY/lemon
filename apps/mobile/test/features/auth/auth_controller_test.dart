import 'package:clock/clock.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lemon/core/api/api_exception.dart';
import 'package:lemon/features/auth/application/auth_controller.dart';
import 'package:lemon/features/auth/data/auth_failure.dart';

import '../../helpers/fake_auth.dart';

void main() {
  late FakeAuthRepository auth;
  late ProviderContainer container;

  AuthController controller() => container.read(authControllerProvider.notifier);
  SessionStatus status() => container.read(authControllerProvider).status;

  Future<void> start(FakeAuthRepository repository) async {
    auth = repository;
    container = ProviderContainer(
      overrides: [authRepositoryProvider.overrideWithValue(auth)],
    );
    addTearDown(container.dispose);
    container.listen(authControllerProvider, (_, _) {});
    await pumpEventQueue();
  }

  test('follows the restored session from Firebase', () async {
    await start(FakeAuthRepository());
    expect(status(), SessionStatus.signedIn);
    expect(container.read(authControllerProvider).user?.email, testEmail);

    await start(FakeAuthRepository(verified: false));
    expect(status(), SessionStatus.unverified);

    await start(FakeAuthRepository(signedIn: false));
    expect(status(), SessionStatus.signedOut);
  });

  test('signing out is not an expiry', () async {
    await start(FakeAuthRepository());
    await controller().signOut();
    await pumpEventQueue();
    expect(status(), SessionStatus.signedOut);
    expect(auth.signOuts, 1);
  });

  test('Firebase dropping the session shows as expired', () async {
    await start(FakeAuthRepository());
    auth.dropSession();
    await pumpEventQueue();
    expect(status(), SessionStatus.expired);
  });

  test('a token refresh failure ends the session', () async {
    await start(FakeAuthRepository());
    auth.tokenFailure = const AuthFailure(AuthErrorCode.sessionExpired);
    expect(await controller().idToken(forceRefresh: true), isNull);
    await pumpEventQueue();
    expect(status(), SessionStatus.expired);
    expect(auth.signOuts, 1);
  });

  test('an offline token refresh keeps the session', () async {
    await start(FakeAuthRepository());
    auth.tokenFailure = const AuthFailure(AuthErrorCode.network);
    await expectLater(
      controller().idToken(),
      throwsA(isA<NetworkException>()),
    );
    expect(status(), SessionStatus.signedIn);
  });

  test('the server rejecting a fresh token ends the session', () async {
    await start(FakeAuthRepository());
    controller().sessionRejected();
    await pumpEventQueue();
    expect(status(), SessionStatus.expired);
  });

  test('signing in after expiry moves on', () async {
    await start(FakeAuthRepository());
    auth.dropSession();
    await pumpEventQueue();
    await controller().signIn(email: testEmail, password: testPassword);
    await pumpEventQueue();
    expect(status(), SessionStatus.signedIn);
  });

  test('verification needs a reload, then refreshes the token', () async {
    await start(FakeAuthRepository(verified: false));
    expect(await controller().refreshVerification(), isFalse);
    expect(status(), SessionStatus.unverified);
    expect(auth.tokenRequests, isEmpty);

    auth.openVerificationLink();
    expect(await controller().refreshVerification(), isTrue);
    expect(status(), SessionStatus.signedIn);
    // The new token carries email_verified for the server's bootstrap
    expect(auth.tokenRequests, [true]);
  });

  test('verification emails have a 60 second cooldown', () async {
    var now = DateTime.utc(2026, 11, 10, 9);
    await withClock(Clock(() => now), () async {
      await start(FakeAuthRepository(signedIn: false));
      expect(controller().resendWaitRemaining(), Duration.zero);

      await controller().createAccount(
        email: 'selam@example.test',
        password: testPassword,
      );
      expect(controller().resendWaitRemaining(), const Duration(seconds: 60));

      now = now.add(const Duration(seconds: 45));
      expect(controller().resendWaitRemaining(), const Duration(seconds: 15));

      now = now.add(const Duration(seconds: 15));
      expect(controller().resendWaitRemaining(), Duration.zero);
      await controller().resendVerificationEmail();
      expect(auth.verificationEmails, 2);
      expect(controller().resendWaitRemaining(), const Duration(seconds: 60));
    });
  });
}
