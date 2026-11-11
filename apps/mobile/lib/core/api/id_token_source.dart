import 'dart:convert';

import 'package:http/http.dart' as http;

import 'api_exception.dart';

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

/// Development only: signs in with email and password against the Firebase
/// Auth emulator's REST endpoint. Replaced by the Firebase Auth SDK once the
/// sign-in screens are built.
class EmulatorPasswordTokenSource implements IdTokenSource {
  EmulatorPasswordTokenSource({
    required this.host,
    required this.email,
    required this.password,
    http.Client? client,
    DateTime Function()? clock,
  }) : _client = client ?? http.Client(),
       _clock = clock ?? DateTime.now;

  final String host;
  final String email;
  final String password;
  final http.Client _client;
  final DateTime Function() _clock;

  String? _token;
  DateTime? _expiresAt;

  @override
  Future<String?> idToken({bool forceRefresh = false}) async {
    final now = _clock();
    final cached = _token;
    if (!forceRefresh && cached != null && _expiresAt!.isAfter(now)) {
      return cached;
    }
    final uri = Uri.parse(
      'http://$host/identitytoolkit.googleapis.com/v1/'
      'accounts:signInWithPassword?key=emulator',
    );
    final http.Response response;
    try {
      response = await _client.post(
        uri,
        headers: {'content-type': 'application/json'},
        body: jsonEncode({
          'email': email,
          'password': password,
          'returnSecureToken': true,
        }),
      );
    } on http.ClientException catch (e) {
      throw NetworkException(e);
    }
    if (response.statusCode != 200) return null;
    final json = jsonDecode(response.body) as Map<String, dynamic>;
    final seconds = int.tryParse('${json['expiresIn']}') ?? 3600;
    _token = json['idToken'] as String;
    _expiresAt = now.add(Duration(seconds: seconds - 60));
    return _token;
  }
}

/// Picks a token source from `--dart-define` values for local development.
IdTokenSource idTokenSourceFromEnvironment() {
  const host = String.fromEnvironment('LEMON_AUTH_EMULATOR_HOST');
  const email = String.fromEnvironment('LEMON_DEV_EMAIL');
  const password = String.fromEnvironment('LEMON_DEV_PASSWORD');
  const token = String.fromEnvironment('LEMON_DEV_ID_TOKEN');
  if (host.isNotEmpty && email.isNotEmpty) {
    return EmulatorPasswordTokenSource(
      host: host,
      email: email,
      password: password,
    );
  }
  return StaticIdTokenSource(token.isEmpty ? null : token);
}
