import 'package:firebase_auth/firebase_auth.dart';

import 'auth_failure.dart';
import 'auth_repository.dart';

/// [AuthRepository] backed by the Firebase Auth SDK.
class FirebaseAuthRepository implements AuthRepository {
  FirebaseAuthRepository(this._auth);

  final FirebaseAuth _auth;

  @override
  bool get isConfigured => true;

  @override
  AuthUser? get currentUser => _toAuthUser(_auth.currentUser);

  @override
  Stream<AuthUser?> userChanges() => _auth.userChanges().map(_toAuthUser);

  @override
  Future<void> signIn({required String email, required String password}) =>
      _guard(
        () => _auth.signInWithEmailAndPassword(
          email: email.trim(),
          password: password,
        ),
      );

  @override
  Future<void> createAccount({
    required String email,
    required String password,
  }) async {
    final credential = await _guard(
      () => _auth.createUserWithEmailAndPassword(
        email: email.trim(),
        password: password,
      ),
    );
    try {
      await credential.user?.sendEmailVerification();
    } on FirebaseException {
      // The account exists; the verify screen offers "Resend"
    }
  }

  @override
  Future<void> sendPasswordReset(String email) async {
    try {
      await _guard(() => _auth.sendPasswordResetEmail(email: email.trim()));
    } on AuthFailure catch (failure) {
      // Never reveal whether an account exists for this address
      if (failure.code == AuthErrorCode.invalidCredentials) return;
      rethrow;
    }
  }

  @override
  Future<void> sendEmailVerification() => _guard(() async {
    final user = _auth.currentUser;
    if (user == null) throw const AuthFailure(AuthErrorCode.sessionExpired);
    await user.sendEmailVerification();
  });

  @override
  Future<AuthUser?> reloadUser() => _guard(() async {
    final user = _auth.currentUser;
    if (user == null) return null;
    await user.reload();
    return _toAuthUser(_auth.currentUser);
  });

  @override
  Future<String?> idToken({bool forceRefresh = false}) => _guard(() async {
    final user = _auth.currentUser;
    if (user == null) return null;
    return user.getIdToken(forceRefresh);
  });

  @override
  Future<void> signOut() => _guard(_auth.signOut);

  static AuthUser? _toAuthUser(User? user) => user == null
      ? null
      : AuthUser(email: user.email, emailVerified: user.emailVerified);

  /// Converts SDK errors to [AuthFailure]. Error messages are dropped: they
  /// can echo the email address and are never shown or logged.
  static Future<T> _guard<T>(Future<T> Function() action) async {
    try {
      return await action();
    } on AuthFailure {
      rethrow;
    } on FirebaseException catch (e) {
      throw AuthFailure(authErrorCodeFromFirebase(e.code));
    }
  }
}
