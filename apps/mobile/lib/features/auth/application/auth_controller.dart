import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_exception.dart';
import '../../../core/api/id_token_source.dart';
import '../data/auth_failure.dart';
import '../data/auth_repository.dart';
import '../domain/credentials.dart';

/// Where the person is in sign-in. Server state (onboarding, active,
/// restricted) is decided after [signedIn] by the app gate.
enum SessionStatus {
  /// Waiting for Firebase to restore a saved session.
  starting,
  signedOut,

  /// The saved session stopped working (token refresh failed or the server
  /// rejected a fresh token). Shown as its own signed-out screen.
  expired,

  /// Signed in, but Firebase has not confirmed the email address yet.
  unverified,
  signedIn,
}

class SessionState {
  const SessionState(this.status, {this.user});

  final SessionStatus status;
  final AuthUser? user;

  @override
  bool operator ==(Object other) =>
      other is SessionState && other.status == status && other.user == user;

  @override
  int get hashCode => Object.hash(status, user);
}

/// Overridden in `main.dart` with the Firebase-backed repository and in tests
/// with a fake. Defaults to "not configured" so a bare `ProviderScope` works.
final authRepositoryProvider = Provider<AuthRepository>(
  (ref) => const UnconfiguredAuthRepository(),
);

/// The password rules shown while creating an account. Must match the
/// Firebase project's password policy.
final passwordPolicyProvider = Provider<PasswordPolicy>(
  (ref) => PasswordPolicy.lemon,
);

final authControllerProvider =NotifierProvider<AuthController, SessionState>(
  AuthController.new,
);

/// Owns the session: follows Firebase's user stream, runs sign-in actions,
/// supplies ID tokens to the API client, and turns token failures into the
/// [SessionStatus.expired] state.
///
/// Never logs passwords or tokens.
class AuthController extends Notifier<SessionState> implements IdTokenSource {
  late AuthRepository _repository;
  bool _signingOut = false;
  bool _expiring = false;

  /// When the last verification email was sent from this device, for the
  /// resend cooldown. Null until one is sent in this session.
  DateTime? verificationEmailSentAt;

  /// Minimum wait between verification emails.
  static const resendCooldown = Duration(seconds: 60);

  @override
  SessionState build() {
    _repository = ref.watch(authRepositoryProvider);
    final subscription = _repository.userChanges().listen(
      _onUser,
      onError: (Object _) {},
    );
    ref.onDispose(subscription.cancel);
    return const SessionState(SessionStatus.starting);
  }

  bool get isConfigured => _repository.isConfigured;

  /// Wall-clock time for the cooldown (`package:clock`, so tests can advance
  /// it); the app's `clockProvider` is a calendar date source.
  DateTime _now() => clock.now();

  void _onUser(AuthUser? user) {
    if (!ref.mounted) return;
    final current = state.status;
    if (user == null) {
      final wasSignedIn =
          current == SessionStatus.unverified ||
          current == SessionStatus.signedIn;
      if (_signingOut) {
        _signingOut = false;
        state = const SessionState(SessionStatus.signedOut);
      } else if (current != SessionStatus.expired) {
        // Firebase dropped the session on its own (revoked, disabled, expired)
        state = SessionState(
          wasSignedIn ? SessionStatus.expired : SessionStatus.signedOut,
        );
      }
      return;
    }
    if (_expiring) return;
    if (current == SessionStatus.unverified && user.emailVerified) {
      // Wait for refreshVerification so the token carries the verified claim
      return;
    }
    state = SessionState(
      user.emailVerified ? SessionStatus.signedIn : SessionStatus.unverified,
      user: user,
    );
  }

  Future<void> signIn({required String email, required String password}) =>
      _repository.signIn(email: email, password: password);

  Future<void> createAccount({
    required String email,
    required String password,
  }) async {
    await _repository.createAccount(email: email, password: password);
    verificationEmailSentAt = _now();
  }

  Future<void> sendPasswordReset(String email) =>
      _repository.sendPasswordReset(email);

  /// Time left before another verification email may be sent.
  Duration resendWaitRemaining() {
    final sent = verificationEmailSentAt;
    if (sent == null) return Duration.zero;
    final left = resendCooldown - _now().difference(sent);
    return left.isNegative ? Duration.zero : left;
  }

  Future<void> resendVerificationEmail() async {
    await _endSessionOn(_repository.sendEmailVerification);
    verificationEmailSentAt = _now();
  }

  /// Reloads the Firebase user. Once verified, fetches a fresh ID token (so
  /// the server's bootstrap sees `email_verified`) and moves to
  /// [SessionStatus.signedIn]. Returns whether the email is verified.
  Future<bool> refreshVerification() async {
    final user = await _endSessionOn(_repository.reloadUser);
    if (!ref.mounted) return false;
    if (user == null) {
      await _expire();
      return false;
    }
    if (!user.emailVerified) {
      state = SessionState(SessionStatus.unverified, user: user);
      return false;
    }
    await _endSessionOn(() => _repository.idToken(forceRefresh: true));
    if (ref.mounted) state = SessionState(SessionStatus.signedIn, user: user);
    return true;
  }

  Future<void> signOut() async {
    _signingOut = true;
    verificationEmailSentAt = null;
    state = const SessionState(SessionStatus.signedOut);
    try {
      await _repository.signOut();
    } on AuthFailure {
      // Local state is already signed out
    }
  }

  /// The API rejected a freshly refreshed token (`401`): the session is over.
  void sessionRejected() => unawaited(_expire());

  @override
  Future<String?> idToken({bool forceRefresh = false}) async {
    try {
      return await _repository.idToken(forceRefresh: forceRefresh);
    } on AuthFailure catch (failure) {
      if (failure.code == AuthErrorCode.network) {
        throw NetworkException(failure);
      }
      if (failure.code.endsSession) {
        await _expire();
        return null; // The API client reports NotSignedInException
      }
      rethrow;
    }
  }

  Future<T> _endSessionOn<T>(Future<T> Function() action) async {
    try {
      return await action();
    } on AuthFailure catch (failure) {
      if (failure.code.endsSession) await _expire();
      rethrow;
    }
  }

  Future<void> _expire() async {
    if (!ref.mounted) return;
    final current = state.status;
    if (current != SessionStatus.signedIn &&
        current != SessionStatus.unverified) {
      return;
    }
    _expiring = true;
    verificationEmailSentAt = null;
    state = const SessionState(SessionStatus.expired);
    try {
      await _repository.signOut();
    } on AuthFailure {
      // Already unusable; the local state is what matters
    } finally {
      _expiring = false;
    }
  }
}
