import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import '../../features/onboarding/data/account.dart';
import '../../features/profile/data/photos.dart';
import '../../features/profile/data/preferences.dart';
import '../../features/profile/data/profile.dart';
import '../catalogs/catalogs.dart';
import 'api_error.dart';
import 'api_exception.dart';
import 'id_token_source.dart';

/// Result of a revisioned `PATCH`: the fields saved and the new revision.
class RevisionedUpdate {
  const RevisionedUpdate({required this.updated, required this.revision});

  factory RevisionedUpdate.fromJson(Map<String, dynamic> json) =>
      RevisionedUpdate(
        updated: (json['updated'] as List<dynamic>).cast<String>(),
        revision: json['revision'] as int,
      );

  final List<String> updated;
  final int revision;
}

/// Typed client for the Lemon API (`contracts/openapi.yaml` and
/// `contracts/openapi/media.yaml`).
///
/// Identity comes only from the Firebase ID token in the `Authorization`
/// header. The server decides readiness, eligibility and authorization; this
/// client only carries requests and decodes the `{ data, meta }` envelope.
class LemonApiClient {
  LemonApiClient({
    required this.baseUrl,
    required this.tokens,
    http.Client? httpClient,
    this.timeout = const Duration(seconds: 20),
  }) : _http = httpClient ?? http.Client();

  /// API origin, e.g. `http://localhost:3000`.
  final Uri baseUrl;
  final IdTokenSource tokens;
  final Duration timeout;
  final http.Client _http;

  // Account and onboarding

  Future<BootstrapResult> bootstrap() async =>
      BootstrapResult.fromJson(await _send('POST', '/v1/me/bootstrap'));

  Future<Account> getAccount() async =>
      Account.fromJson(await _send('GET', '/v1/me'));

  /// Saves the birth date (`YYYY-MM-DD`) and/or terms acceptance.
  Future<List<String>> saveOnboarding({
    String? birthDate,
    bool acceptTerms = false,
  }) async {
    final data = await _send(
      'PATCH',
      '/v1/me/onboarding',
      body: {'birthDate': ?birthDate, if (acceptTerms) 'termsAccepted': true},
    );
    return (data['updated'] as List<dynamic>).cast<String>();
  }

  Future<Catalogs> getCatalogs() async =>
      Catalogs.fromJson(await _send('GET', '/v1/catalogs', auth: false));

  // Profile

  Future<SelfProfile> getProfile() async =>
      SelfProfile.fromJson(await _send('GET', '/v1/me/profile'));

  /// Sends only [changes], based on [expectedRevision].
  Future<RevisionedUpdate> updateProfile({
    required int expectedRevision,
    required Map<String, Object?> changes,
  }) async => RevisionedUpdate.fromJson(
    await _send(
      'PATCH',
      '/v1/me/profile',
      body: {...changes, 'expectedRevision': expectedRevision},
    ),
  );

  Future<PublicProfile> getProfilePreview() async =>
      PublicProfile.fromJson(await _send('GET', '/v1/me/profile/preview'));

  // Prompt answers

  Future<PromptSubmission> submitPromptAnswer({
    required String promptId,
    required String text,
  }) async => PromptSubmission.fromJson(
    await _send(
      'POST',
      '/v1/me/prompts',
      body: {'promptId': promptId, 'text': text},
    ),
  );

  Future<PromptSubmission> replacePromptAnswer({
    required String answerId,
    required int expectedRevision,
    required String text,
  }) async => PromptSubmission.fromJson(
    await _send(
      'PATCH',
      '/v1/me/prompts/${Uri.encodeComponent(answerId)}',
      body: {'expectedRevision': expectedRevision, 'text': text},
    ),
  );

  Future<void> deletePromptAnswer(String answerId) async {
    await _send('DELETE', '/v1/me/prompts/${Uri.encodeComponent(answerId)}');
  }

  // Preferences

  Future<Preferences> getPreferences() async =>
      Preferences.fromJson(await _send('GET', '/v1/me/preferences'));

  Future<RevisionedUpdate> updatePreferences({
    required int expectedRevision,
    required Map<String, Object?> changes,
  }) async => RevisionedUpdate.fromJson(
    await _send(
      'PATCH',
      '/v1/me/preferences',
      body: {...changes, 'expectedRevision': expectedRevision},
    ),
  );

  // Photos

  Future<PhotoSet> getPhotos() async =>
      PhotoSet.fromJson(await _send('GET', '/v1/me/photos'));

  /// Uploads one photo. Reuse the same [idempotencyKey] on every retry of the
  /// same upload so the server never stores it twice.
  Future<PhotoUpload> uploadPhoto({
    required Uint8List bytes,
    required String filename,
    required String idempotencyKey,
  }) async {
    Future<http.BaseRequest> build(String token) async =>
        http.MultipartRequest('POST', baseUrl.resolve('/v1/me/photos'))
          ..headers.addAll({
            'accept': 'application/json',
            'authorization': 'Bearer $token',
            'idempotency-key': idempotencyKey,
          })
          ..files.add(
            http.MultipartFile.fromBytes('photo', bytes, filename: filename),
          );
    return PhotoUpload.fromJson(await _sendAuthorized(build));
  }

  Future<int> reorderPhotos({
    required int expectedRevision,
    required List<String> photoIds,
  }) async {
    final data = await _send(
      'PATCH',
      '/v1/me/photos/order',
      body: {'expectedRevision': expectedRevision, 'photoIds': photoIds},
    );
    return data['revision'] as int;
  }

  /// Removes a photo and returns the new photo-set revision.
  Future<int> deletePhoto(String photoId) async {
    final data = await _send(
      'DELETE',
      '/v1/me/photos/${Uri.encodeComponent(photoId)}',
    );
    return data['revision'] as int;
  }

  // Media

  /// Absolute URL for an authenticated media path such as `/v1/media/x/thumb`.
  Uri mediaUri(String path) => baseUrl.resolve(path);

  /// Headers for loading media; every read is access-checked by the server.
  Future<Map<String, String>> authHeaders() async {
    final token = await tokens.idToken();
    if (token == null) throw const NotSignedInException();
    return {'authorization': 'Bearer $token'};
  }

  // Transport

  Future<Map<String, dynamic>> _send(
    String method,
    String path, {
    Map<String, Object?>? body,
    bool auth = true,
  }) {
    Future<http.BaseRequest> build(String? token) async {
      final request = http.Request(method, baseUrl.resolve(path))
        ..headers['accept'] = 'application/json';
      if (token != null) request.headers['authorization'] = 'Bearer $token';
      if (body != null) {
        request.headers['content-type'] = 'application/json';
        request.body = jsonEncode(body);
      }
      return request;
    }

    if (!auth) return _complete(() => build(null));
    return _sendAuthorized(build);
  }

  /// Sends with the current token; on 401 retries once with a fresh token.
  Future<Map<String, dynamic>> _sendAuthorized(
    Future<http.BaseRequest> Function(String token) build,
  ) async {
    Future<String> token({required bool refresh}) async {
      final value = await tokens.idToken(forceRefresh: refresh);
      if (value == null) throw const NotSignedInException();
      return value;
    }

    final first = await _round(() async => build(await token(refresh: false)));
    if (first.statusCode != 401) return _decode(first);
    return _decode(
      await _round(() async => build(await token(refresh: true))),
    );
  }

  Future<Map<String, dynamic>> _complete(
    Future<http.BaseRequest> Function() build,
  ) async => _decode(await _round(build));

  Future<http.Response> _round(
    Future<http.BaseRequest> Function() build,
  ) async {
    final request = await build();
    try {
      final streamed = await _http.send(request).timeout(timeout);
      return await http.Response.fromStream(streamed).timeout(timeout);
    } on http.ClientException catch (e) {
      throw NetworkException(e);
    } on TimeoutException catch (e) {
      throw NetworkException(e);
    }
  }

  Map<String, dynamic> _decode(http.Response response) {
    final Object? json;
    try {
      json = jsonDecode(utf8.decode(response.bodyBytes));
    } on FormatException catch (e) {
      throw MalformedResponseException(response.statusCode, e);
    }
    if (json is! Map<String, dynamic>) {
      throw MalformedResponseException(response.statusCode, json ?? 'null');
    }
    final ok = response.statusCode >= 200 && response.statusCode < 300;
    if (ok && json['data'] is Map<String, dynamic>) {
      return json['data'] as Map<String, dynamic>;
    }
    final error = json['error'];
    if (!ok && error is Map<String, dynamic>) {
      final ApiError parsed;
      try {
        parsed = ApiError.fromJson(error);
      } on TypeError catch (e) {
        throw MalformedResponseException(response.statusCode, e);
      }
      throw ApiException(
        statusCode: response.statusCode,
        error: parsed,
        requestId: json['requestId'] as String?,
      );
    }
    throw MalformedResponseException(response.statusCode, json);
  }
}
