/// Supplies the Firebase ID token sent as the bearer credential.
///
/// The token is the only identity the API trusts; the client never sends a
/// user ID of its own.
abstract interface class IdTokenSource {
  /// Returns the current token, or null when nobody is signed in.
  /// [forceRefresh] fetches a new token, e.g. after email verification.
  Future<String?> idToken({bool forceRefresh = false});
}

/// A fixed token, for tests and quick local runs.
class StaticIdTokenSource implements IdTokenSource {
  const StaticIdTokenSource(this.token);

  final String? token;

  @override
  Future<String?> idToken({bool forceRefresh = false}) async => token;
}
