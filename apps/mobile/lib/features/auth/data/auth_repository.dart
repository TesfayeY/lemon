import 'auth_failure.dart';

/// The signed-in Firebase user as the app needs it. Holds no UID: the server
/// derives identity from the ID token alone.
class AuthUser {
  const AuthUser({required this.email, required this.emailVerified});

  /// The person's own sign-in email, shown only to them.
  final String? email;

  /// Firebase's verification flag. The server reads its own copy from the
  /// token claim; this only decides which screen to show.
  final bool emailVerified;

  @override
  bool operator ==(Object other) =>
      other is AuthUser &&
      other.email == email &&
      other.emailVerified == emailVerified;

  @override
  int get hashCode => Object.hash(email, emailVerified);
}

/// Email/password sign-in (D-07). Implemented with the Firebase Auth SDK in
/// the app and with a fake in tests.
///
/// Every method throws [AuthFailure] on failure. Implementations never log
/// passwords or tokens.
abstract interface class AuthRepository {
  /// False when the build has no Firebase configuration; every action then
  /// fails with [AuthErrorCode.notConfigured].
  bool get isConfigured;

  AuthUser? get currentUser;

  /// Emits the current user (or null) on listen, then on every sign-in,
  /// sign-out and profile reload.
  Stream<AuthUser?> userChanges();

  Future<void> signIn({required String email, required String password});

  /// Creates the account, signs in, and sends the verification email.
  Future<void> createAccount({required String email, required String password});

  /// Sends a reset link. Completes normally when no account uses [email], so
  /// callers cannot tell whether an account exists.
  Future<void> sendPasswordReset(String email);

  Future<void> sendEmailVerification();

  /// Reloads the user from Firebase (e.g. after the verification link was
  /// opened) and returns the fresh state.
  Future<AuthUser?> reloadUser();

  /// The current ID token, or null when signed out.
  Future<String?> idToken({bool forceRefresh = false});

  Future<void> signOut();
}

/// Used when the build carries no Firebase configuration, so the app still
/// starts (and says sign-in is unavailable) instead of crashing.
class UnconfiguredAuthRepository implements AuthRepository {
  const UnconfiguredAuthRepository();

  static const _failure = AuthFailure(AuthErrorCode.notConfigured);

  @override
  bool get isConfigured => false;

  @override
  AuthUser? get currentUser => null;

  @override
  Stream<AuthUser?> userChanges() => Stream.value(null);

  @override
  Future<void> signIn({required String email, required String password}) =>
      Future.error(_failure);

  @override
  Future<void> createAccount({
    required String email,
    required String password,
  }) => Future.error(_failure);

  @override
  Future<void> sendPasswordReset(String email) => Future.error(_failure);

  @override
  Future<void> sendEmailVerification() => Future.error(_failure);

  @override
  Future<AuthUser?> reloadUser() async => null;

  @override
  Future<String?> idToken({bool forceRefresh = false}) async => null;

  @override
  Future<void> signOut() async {}
}
