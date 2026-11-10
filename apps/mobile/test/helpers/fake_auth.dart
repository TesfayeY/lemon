import 'dart:async';

import 'package:lemon/features/auth/data/auth_failure.dart';
import 'package:lemon/features/auth/data/auth_repository.dart';
import 'package:lemon/features/auth/domain/credentials.dart';

/// Fictional credentials used across tests.
const testEmail = 'hanna@example.test';
const testPassword = 'Sunrise2026';

class FakeAccount {
  FakeAccount(this.password, {this.verified = false, this.disabled = false});

  String password;
  bool verified;
  bool disabled;
}

/// In-memory stand-in for Firebase Auth, with Firebase's observable
/// behavior: a user stream that replays the current user, verification that
/// only shows after a reload, and a reset call that never reveals whether an
/// account exists.
class FakeAuthRepository implements AuthRepository {
  /// Starts signed in as [testEmail] with a verified email, unless told
  /// otherwise.
  FakeAuthRepository({
    bool signedIn = true,
    bool verified = true,
    this.isConfigured = true,
  }) {
    accounts[testEmail] = FakeAccount(testPassword, verified: verified);
    if (signedIn) _signInAs(testEmail);
  }

  @override
  final bool isConfigured;

  final accounts = <String, FakeAccount>{};
  final _changes = StreamController<AuthUser?>.broadcast();
  String? _currentEmail;
  AuthUser? _current;

  /// The ID token handed out while signed in.
  String token = 'test-token';

  /// Thrown (once) by the next sign-in action.
  AuthFailure? failNext;

  /// Thrown by every token request while set.
  AuthFailure? tokenFailure;

  /// When set, actions wait for it before completing (to see loading states).
  Completer<void>? hold;

  int verificationEmails = 0;
  final resetEmailsSent = <String>[];
  final resetRequests = <String>[];
  final tokenRequests = <bool>[];
  int reloads = 0;
  int signOuts = 0;

  /// Marks the email verified on the "server", as if the link was opened.
  /// The signed-in user only sees it after [reloadUser], like Firebase.
  void openVerificationLink([String email = testEmail]) =>
      accounts[email]!.verified = true;

  /// Firebase dropped the session by itself (revoked, disabled elsewhere).
  void dropSession() {
    _currentEmail = null;
    _emit(null);
  }

  void _signInAs(String email) {
    _currentEmail = email;
    _current = AuthUser(email: email, emailVerified: accounts[email]!.verified);
  }

  void _emit(AuthUser? user) {
    _current = user;
    _changes.add(user);
  }

  Future<void> _step() async {
    final failure = failNext;
    failNext = null;
    if (hold case final gate?) await gate.future;
    if (failure != null) throw failure;
  }

  @override
  AuthUser? get currentUser => _current;

  @override
  Stream<AuthUser?> userChanges() => Stream.multi((controller) {
    controller.add(_current);
    final subscription = _changes.stream.listen(controller.add);
    controller.onCancel = subscription.cancel;
  });

  @override
  Future<void> signIn({required String email, required String password}) async {
    await _step();
    final key = email.trim().toLowerCase();
    final account = accounts[key];
    if (account == null || account.password != password) {
      throw const AuthFailure(AuthErrorCode.invalidCredentials);
    }
    if (account.disabled) throw const AuthFailure(AuthErrorCode.userDisabled);
    _signInAs(key);
    _emit(_current);
  }

  @override
  Future<void> createAccount({
    required String email,
    required String password,
  }) async {
    await _step();
    final key = email.trim().toLowerCase();
    if (accounts.containsKey(key)) {
      throw const AuthFailure(AuthErrorCode.emailInUse);
    }
    if (!PasswordPolicy.lemon.accepts(password)) {
      throw const AuthFailure(AuthErrorCode.weakPassword);
    }
    accounts[key] = FakeAccount(password);
    _signInAs(key);
    verificationEmails++;
    _emit(_current);
  }

  @override
  Future<void> sendPasswordReset(String email) async {
    await _step();
    final key = email.trim().toLowerCase();
    resetRequests.add(key);
    if (accounts.containsKey(key)) resetEmailsSent.add(key);
  }

  @override
  Future<void> sendEmailVerification() async {
    await _step();
    if (_currentEmail == null) {
      throw const AuthFailure(AuthErrorCode.sessionExpired);
    }
    verificationEmails++;
  }

  @override
  Future<AuthUser?> reloadUser() async {
    await _step();
    reloads++;
    final email = _currentEmail;
    if (email == null) return null;
    _signInAs(email);
    _emit(_current);
    return _current;
  }

  @override
  Future<String?> idToken({bool forceRefresh = false}) async {
    tokenRequests.add(forceRefresh);
    if (tokenFailure case final failure?) throw failure;
    return _currentEmail == null ? null : token;
  }

  @override
  Future<void> signOut() async {
    signOuts++;
    _currentEmail = null;
    _emit(null);
  }
}
