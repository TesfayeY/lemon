import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:lemon/core/api/api_exception.dart';
import 'package:lemon/core/api/changes.dart';
import 'package:lemon/core/api/id_token_source.dart';
import 'package:lemon/core/api/lemon_api_client.dart';
import 'package:lemon/features/onboarding/data/account.dart';
import 'package:lemon/features/profile/data/photos.dart';
import 'package:lemon/features/profile/data/preferences.dart';
import 'package:lemon/features/profile/data/profile.dart';

/// Contract fixtures shared with the API (contracts/fixtures).
String contractFixture(String name) =>
    File('../../contracts/fixtures/$name').readAsStringSync();

/// Mobile-only fixtures for shapes the shared fixtures do not cover yet.
String localFixture(String name) =>
    File('test/fixtures/$name').readAsStringSync();

/// Tokens handed out in order; records whether a refresh was forced.
class RecordingTokens implements IdTokenSource {
  RecordingTokens([List<String?>? tokens]) : tokens = tokens ?? ['token-1'];

  final List<String?> tokens;
  final refreshes = <bool>[];

  @override
  Future<String?> idToken({bool forceRefresh = false}) async {
    refreshes.add(forceRefresh);
    return tokens.length > 1 ? tokens.removeAt(0) : tokens.first;
  }
}

void main() {
  late List<http.BaseRequest> sent;
  late List<String> bodies;

  LemonApiClient clientFor(
    Future<http.Response> Function(http.Request request) handler, {
    IdTokenSource? tokens,
    void Function()? onUnauthorized,
  }) {
    sent = [];
    bodies = [];
    return LemonApiClient(
      baseUrl: Uri.parse('http://lemon.test'),
      tokens: tokens ?? RecordingTokens(),
      onUnauthorized: onUnauthorized,
      httpClient: MockClient((request) {
        sent.add(request);
        final isJson = request.headers['content-type']?.contains('json') ?? false;
        bodies.add(isJson ? request.body : '');
        return handler(request);
      }),
    );
  }

  http.Response json(String body, [int status = 200]) => http.Response(
    body,
    status,
    headers: {'content-type': 'application/json; charset=utf-8'},
  );

  group('requests', () {
    test('send the Firebase token as the only identity', () async {
      final api = clientFor((_) async => json(contractFixture('account.json')));
      final account = await api.getAccount();

      expect(account.readiness.missing, [
        ReadinessRequirement.photos,
        ReadinessRequirement.promptAnswers,
      ]);
      expect(sent.single.url.toString(), 'http://lemon.test/v1/me');
      expect(sent.single.headers['authorization'], 'Bearer token-1');
      expect(sent.single.url.queryParameters, isEmpty);
    });

    test('catalogs are public and need no token', () async {
      final api = clientFor(
        (_) async => json(contractFixture('catalogs.json')),
        tokens: const StaticIdTokenSource(null),
      );
      final catalogs = await api.getCatalogs();

      expect(catalogs.cities.single.id, 'city-dallas-tx');
      expect(sent.single.headers.containsKey('authorization'), isFalse);
    });

    test('profile edits send only changes plus expectedRevision', () async {
      final api = clientFor(
        (_) async => json(
          '{"data":{"updated":["displayName"],"revision":8},"meta":{"requestId":"r"}}',
        ),
      );
      final profile = SelfProfile.fromJson(
        (jsonDecode(contractFixture('self-profile.json')) as Map)['data']
            as Map<String, dynamic>,
      );
      final changes = changedFields(profile.toJson(), {
        'displayName': 'Selam',
        'cityId': 'city-dallas-tx',
        'bio': 'New bio',
      });
      final result = await api.updateProfile(
        expectedRevision: profile.revision,
        changes: changes,
      );

      expect(result.revision, 8);
      expect(sent.single.method, 'PATCH');
      expect(sent.single.url.path, '/v1/me/profile');
      expect(jsonDecode(bodies.single), {
        'bio': 'New bio',
        'expectedRevision': 7,
      });
    });

    test('preferences parse the contract fixture and patch with revision', () async {
      var call = 0;
      final api = clientFor((_) async {
        call++;
        return call == 1
            ? json(contractFixture('preferences.json'))
            : json('{"data":{"updated":["minAge"],"revision":4},"meta":{"requestId":"r"}}');
      });
      final prefs = await api.getPreferences();
      expect(prefs.locationScope, LocationScope.state);

      await api.updatePreferences(
        expectedRevision: prefs.revision,
        changes: {'minAge': 30},
      );
      expect(jsonDecode(bodies.last), {'minAge': 30, 'expectedRevision': 3});
    });

    test('onboarding sends a date-only birth date and terms', () async {
      final api = clientFor(
        (_) async => json('{"data":{"updated":["birthDate"]},"meta":{"requestId":"r"}}'),
      );
      await api.saveOnboarding(birthDate: '1995-03-10');
      await api.saveOnboarding(acceptTerms: true);

      expect(jsonDecode(bodies[0]), {'birthDate': '1995-03-10'});
      expect(jsonDecode(bodies[1]), {'termsAccepted': true});
    });

    test('prompt answers post, patch with revision and delete', () async {
      final api = clientFor((request) async {
        if (request.method == 'DELETE') {
          return json('{"data":{"deleted":true},"meta":{"requestId":"r"}}');
        }
        return json(
          '{"data":{"id":"a1","promptId":"prompt-tradition","state":"pending","revision":2},"meta":{"requestId":"r"}}',
          request.method == 'POST' ? 201 : 200,
        );
      });
      final created = await api.submitPromptAnswer(
        promptId: 'prompt-tradition',
        text: 'Coffee with my grandmother.',
      );
      expect(created.state, ReviewState.pending);
      await api.replacePromptAnswer(
        answerId: 'a1',
        expectedRevision: 1,
        text: 'Coffee, three rounds.',
      );
      await api.deletePromptAnswer('a1');

      expect(sent.map((r) => '${r.method} ${r.url.path}'), [
        'POST /v1/me/prompts',
        'PATCH /v1/me/prompts/a1',
        'DELETE /v1/me/prompts/a1',
      ]);
      expect(jsonDecode(bodies[1]), {
        'expectedRevision': 1,
        'text': 'Coffee, three rounds.',
      });
    });
  });

  group('photos', () {
    test('list parses review states, reasons and processing media', () async {
      final api = clientFor((_) async => json(localFixture('photos.json')));
      final set = await api.getPhotos();

      expect(set.revision, 5);
      expect(set.active.map((p) => p.state), [
        PhotoState.approved,
        PhotoState.processing,
      ]);
      expect(set.active[1].media, isNull);
      expect(set.rejected.single.rejectionReason!.code, 'face_not_clear');
      expect(set.approvedCount, 1);
    });

    test('upload is multipart with an Idempotency-Key and one photo part', () async {
      final api = clientFor(
        (_) async => json(
          '{"data":{"id":"p1","state":"pending","order":0,"revision":2},"meta":{"requestId":"r"}}',
          201,
        ),
      );
      final upload = await api.uploadPhoto(
        bytes: Uint8List.fromList([1, 2, 3]),
        filename: 'me.jpg',
        idempotencyKey: 'key-123456789',
      );

      expect(upload.state, PhotoState.pending);
      final request = sent.single;
      expect(request.url.path, '/v1/me/photos');
      expect(request.headers['idempotency-key'], 'key-123456789');
      expect(request.headers['content-type'], startsWith('multipart/form-data'));
      expect(request.headers['authorization'], 'Bearer token-1');
    });

    test('reorder and delete return the new photo-set revision', () async {
      final api = clientFor((request) async {
        if (request.method == 'DELETE') {
          return json('{"data":{"deleted":true,"revision":7},"meta":{"requestId":"r"}}');
        }
        return json(
          '{"data":{"revision":6,"photoIds":["b","a"]},"meta":{"requestId":"r"}}',
        );
      });
      expect(
        await api.reorderPhotos(expectedRevision: 5, photoIds: ['b', 'a']),
        6,
      );
      expect(jsonDecode(bodies.first), {
        'expectedRevision': 5,
        'photoIds': ['b', 'a'],
      });
      expect(await api.deletePhoto('a'), 7);
    });

    test('media paths resolve against the API origin', () {
      final api = clientFor((_) async => json('{}'));
      expect(
        api.mediaUri('/v1/media/x/thumb').toString(),
        'http://lemon.test/v1/media/x/thumb',
      );
    });
  });

  group('failures', () {
    test('409 revision conflict carries the current revision', () async {
      final api = clientFor(
        (_) async => json(contractFixture('error-revision-conflict.json'), 409),
      );
      await expectLater(
        api.updateProfile(expectedRevision: 7, changes: {'bio': 'x'}),
        throwsA(
          isA<ApiException>()
              .having((e) => e.isRevisionConflict, 'conflict', isTrue)
              .having((e) => e.error.currentRevision, 'current', 8)
              .having((e) => e.requestId, 'requestId', 'fixture-request-conflict'),
        ),
      );
    });

    test('422 validation errors keep field errors', () async {
      final api = clientFor(
        (_) async => json(contractFixture('error-validation.json'), 422),
      );
      await expectLater(
        api.updateProfile(expectedRevision: 1, changes: {'displayName': ''}),
        throwsA(
          isA<ApiException>().having(
            (e) => e.error.fieldErrors.single.field,
            'field',
            'displayName',
          ),
        ),
      );
    });

    test('media errors with extra fields still parse', () async {
      final api = clientFor(
        (_) async => json(
          '{"error":{"code":"UNSUPPORTED_MEDIA_TYPE","message":"HEIC","detectedFormat":"heic","acceptedFormats":["jpeg"],"retryable":false},"requestId":"r"}',
          415,
        ),
      );
      await expectLater(
        api.uploadPhoto(
          bytes: Uint8List(1),
          filename: 'a.heic',
          idempotencyKey: 'key-123456789',
        ),
        throwsA(isA<ApiException>().having((e) => e.code, 'code', 'UNSUPPORTED_MEDIA_TYPE')),
      );
    });

    test('a dropped connection is reported as offline', () async {
      final api = clientFor(
        (request) async => throw http.ClientException('no route', request.url),
      );
      await expectLater(api.getProfile(), throwsA(isA<NetworkException>()));
    });

    test('a non-JSON body is a malformed response, not a crash', () async {
      final api = clientFor((_) async => http.Response('<html>502</html>', 502));
      await expectLater(
        api.getProfile(),
        throwsA(isA<MalformedResponseException>()),
      );
    });

    test('no signed-in user fails before any request', () async {
      final api = clientFor(
        (_) async => json('{}'),
        tokens: const StaticIdTokenSource(null),
      );
      await expectLater(api.getAccount(), throwsA(isA<NotSignedInException>()));
      expect(sent, isEmpty);
    });

    test('401 retries once with a refreshed token', () async {
      final tokens = RecordingTokens(['stale', 'fresh']);
      var call = 0;
      final api = clientFor((_) async {
        call++;
        return call == 1
            ? json(
                '{"error":{"code":"UNAUTHENTICATED","message":"expired","retryable":false},"requestId":"r"}',
                401,
              )
            : json(contractFixture('account.json'));
      }, tokens: tokens);

      await api.getAccount();
      expect(tokens.refreshes, [false, true]);
      expect(sent.map((r) => r.headers['authorization']), [
        'Bearer stale',
        'Bearer fresh',
      ]);
    });

    test('a 401 after the refreshed token reports the session as rejected', () async {
      var rejected = 0;
      final api = clientFor(
        (_) async => json(
          '{"error":{"code":"TOKEN_REVOKED","message":"revoked","retryable":false},"requestId":"r"}',
          401,
        ),
        tokens: RecordingTokens(['stale', 'fresh']),
        onUnauthorized: () => rejected++,
      );

      await expectLater(
        api.getAccount(),
        throwsA(isA<ApiException>().having((e) => e.code, 'code', 'TOKEN_REVOKED')),
      );
      expect(sent, hasLength(2));
      expect(rejected, 1);
    });

    test('a 401 that a refreshed token fixes does not end the session', () async {
      var rejected = 0;
      var call = 0;
      final api = clientFor((_) async {
        call++;
        return call == 1
            ? json(
                '{"error":{"code":"UNAUTHENTICATED","message":"expired","retryable":false},"requestId":"r"}',
                401,
              )
            : json(contractFixture('account.json'));
      }, onUnauthorized: () => rejected++);

      await api.getAccount();
      expect(rejected, 0);
    });
  });

  group('changedFields', () {
    test('ignores unchanged values and compares lists by content', () {
      expect(
        changedFields(
          {'a': 1, 'langs': ['x', 'y'], 'b': null},
          {'a': 1, 'langs': ['x', 'y'], 'b': 'set'},
        ),
        {'b': 'set'},
      );
      expect(
        changedFields({'langs': ['x']}, {'langs': ['x', 'y']}),
        {'langs': ['x', 'y']},
      );
    });

    test('clearing an optional field sends null', () {
      expect(changedFields({'bio': 'Old'}, {'bio': null}), {'bio': null});
    });
  });
}
