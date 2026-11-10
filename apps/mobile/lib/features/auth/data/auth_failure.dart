/// Why a sign-in action failed, independent of the auth provider.
///
/// Screens map these to localized copy (`authFailureMessage`). Provider
/// messages are never shown, and nothing here carries the password or token.
enum AuthErrorCode {
  /// Wrong password, unknown email, or malformed credential. These share one
  /// code so the app never reveals whether an account exists.
  invalidCredentials,
  invalidEmail,
  emailInUse,
  weakPassword,
  tooManyRequests,
  network,
  userDisabled,

  /// The saved session can no longer produce tokens (revoked, expired,
  /// deleted or changed elsewhere); the person must sign in again.
  sessionExpired,

  /// Email/password sign-in is not set up for this build or project.
  notConfigured,
  unknown;

  /// Failures after which the local session is unusable.
  bool get endsSession =>
      this == sessionExpired || this == userDisabled;
}

class AuthFailure implements Exception {
  const AuthFailure(this.code);

  final AuthErrorCode code;

  @override
  String toString() => 'AuthFailure(${code.name})';
}

/// Maps a Firebase Auth error code (`FirebaseAuthException.code`) to an
/// [AuthErrorCode]. Unknown codes fall back to [AuthErrorCode.unknown].
AuthErrorCode authErrorCodeFromFirebase(String code) => switch (code) {
  'invalid-credential' ||
  'invalid-login-credentials' ||
  'wrong-password' ||
  'user-not-found' ||
  'missing-password' => AuthErrorCode.invalidCredentials,
  'invalid-email' || 'missing-email' => AuthErrorCode.invalidEmail,
  'email-already-in-use' ||
  'credential-already-in-use' => AuthErrorCode.emailInUse,
  'weak-password' ||
  'password-does-not-meet-requirements' => AuthErrorCode.weakPassword,
  'too-many-requests' || 'quota-exceeded' => AuthErrorCode.tooManyRequests,
  'network-request-failed' || 'timeout' => AuthErrorCode.network,
  'user-disabled' => AuthErrorCode.userDisabled,
  'user-token-expired' ||
  'invalid-user-token' ||
  'requires-recent-login' ||
  'user-mismatch' ||
  'no-current-user' => AuthErrorCode.sessionExpired,
  'operation-not-allowed' ||
  'invalid-api-key' ||
  'api-key-not-valid' ||
  'app-not-authorized' ||
  'configuration-not-found' ||
  'no-app' => AuthErrorCode.notConfigured,
  _ => AuthErrorCode.unknown,
};
