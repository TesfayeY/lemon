import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// In-memory stand-in for the Lemon API, shaped like `contracts/openapi.yaml`
/// and `contracts/openapi/media.yaml`. It keeps just enough server behavior
/// (revisions, review states, readiness) to drive the Flutter screens.
///
/// All people and places are fictional.
class FakeBackend {
  FakeBackend({this.today = '2026-11-10'});

  /// Server "today" for the adult gate (UTC day boundary).
  final String today;

  final requests = <RecordedRequest>[];

  /// Responses to return instead of normal handling, matched in order.
  final _overrides = <_Override>[];

  /// When true every request fails as if the device were offline.
  bool offline = false;

  // Account
  String accountStatus = 'onboarding';
  bool emailVerified = true;
  String? birthDate;
  String? termsVersion;
  String? acceptedAt;
  bool discoverPaused = false;

  // Profile
  final profile = <String, Object?>{
    'userId': 'user-fixture-1',
    'displayName': null,
    'genderIdentity': null,
    'genderDisplay': 'public',
    'cityId': null,
    'intention': null,
    'bio': null,
    'hometown': null,
    'hometownDisplay': 'private',
    'occupation': null,
    'occupationDisplay': 'private',
    'education': null,
    'educationDisplay': 'private',
    'height': null,
    'heightDisplay': 'private',
    'languages': <String>[],
    'languagesDisplay': 'private',
    'religion': null,
    'religionDisplay': 'private',
    'revision': 1,
  };

  final prompts = <Map<String, Object?>>[];
  int _promptIds = 0;

  final preferences = <String, Object?>{
    'acceptedGenderCategories': <String>[],
    'minAge': 18,
    'maxAge': 50,
    'locationScope': 'state',
    'longDistance': false,
    'revision': 1,
  };

  final photos = <Map<String, Object?>>[];
  int photoRevision = 1;
  int _photoIds = 0;
  final _idempotency = <String, String>{};

  static const catalogs = <String, Object?>{
    'states': [
      {'code': 'GA', 'name': 'Georgia'},
      {'code': 'ME', 'name': 'Maine'},
      {'code': 'OR', 'name': 'Oregon'},
      {'code': 'TX', 'name': 'Texas'},
      {'code': 'WA', 'name': 'Washington'},
    ],
    'cities': [
      {'id': 'city-atlanta-ga', 'name': 'Atlanta', 'stateCode': 'GA', 'countryCode': 'US'},
      {'id': 'city-dallas-tx', 'name': 'Dallas', 'stateCode': 'TX', 'countryCode': 'US'},
      {'id': 'city-portland-me', 'name': 'Portland', 'stateCode': 'ME', 'countryCode': 'US'},
      {'id': 'city-portland-or', 'name': 'Portland', 'stateCode': 'OR', 'countryCode': 'US'},
      {'id': 'city-seattle-wa', 'name': 'Seattle', 'stateCode': 'WA', 'countryCode': 'US'},
    ],
    'prompts': [
      {'id': 'prompt-tradition', 'category': 'cultural', 'text': 'A tradition I would love to share with you…', 'active': true},
      {'id': 'prompt-sunday', 'category': 'lifestyle', 'text': 'My ideal Sunday looks like…', 'active': true},
      {'id': 'prompt-home', 'category': 'cultural', 'text': 'A place that feels like home…', 'active': true},
      {'id': 'prompt-first-date', 'category': 'dating', 'text': 'A first date I would enjoy…', 'active': true},
      {'id': 'prompt-song', 'category': 'general', 'text': 'The song I always come back to…', 'active': true},
    ],
    'intentions': [
      {'id': 'serious', 'label': 'Looking for something serious'},
      {'id': 'open', 'label': 'Open to exploring'},
    ],
    'genderCategories': [
      {'id': 'woman', 'label': 'Woman'},
      {'id': 'man', 'label': 'Man'},
      {'id': 'nonbinary', 'label': 'Nonbinary'},
    ],
    'languages': [
      {'id': 'amharic', 'label': 'Amharic'},
      {'id': 'tigrinya', 'label': 'Tigrinya'},
      {'id': 'english', 'label': 'English'},
    ],
  };

  late final http.Client client = MockClient(_handle);

  /// Queue a canned response for the next matching request.
  void failNext(
    String method,
    String pathPrefix, {
    required int status,
    required Map<String, Object?> error,
  }) {
    _overrides.add(_Override(method, pathPrefix, status, error));
  }

  /// Queue a revision conflict, simulating an edit from another device.
  void conflictNext(String method, String pathPrefix, {required int bumpTo}) {
    _overrides.add(
      _Override(method, pathPrefix, 409, {
        'code': 'REVISION_CONFLICT',
        'message': 'Profile has been modified. Please refresh and try again.',
        'currentRevision': bumpTo,
        'retryable': true,
      }, onMatch: () {
        if (pathPrefix.startsWith('/v1/me/profile')) profile['revision'] = bumpTo;
        if (pathPrefix.startsWith('/v1/me/preferences')) preferences['revision'] = bumpTo;
        if (pathPrefix.startsWith('/v1/me/photos')) photoRevision = bumpTo;
      }),
    );
  }

  // Reviewer actions (Phase 05 review service stand-ins)

  void approveAllPhotos() {
    for (final p in photos) {
      if (p['state'] == 'pending') p['state'] = 'approved';
    }
    photoRevision++;
  }

  void rejectPhoto(String id, String code) {
    final photo = photos.firstWhere((p) => p['id'] == id);
    photo['state'] = 'rejected';
    photo['rejectionReason'] = {'code': code, 'message': 'English default for $code'};
    photoRevision++;
  }

  void approveAllPrompts() {
    for (final a in prompts) {
      if (a['state'] == 'pending') {
        a['approvedText'] = a['pendingText'];
        a['pendingText'] = null;
        a['state'] = 'approved';
      }
    }
  }

  void rejectPrompt(String id) {
    final answer = prompts.firstWhere((a) => a['id'] == id);
    answer['state'] = 'rejected';
  }

  /// Adds a photo directly, as if uploaded earlier.
  String seedPhoto({String state = 'approved', Map<String, Object?>? rejection}) {
    final id = 'photo-${++_photoIds}';
    photos.add(_photo(id, state, rejection: rejection));
    photoRevision++;
    return id;
  }

  /// Adds a prompt answer directly.
  String seedPrompt(
    String promptId, {
    String? approvedText,
    String? pendingText,
    String state = 'approved',
    int revision = 1,
  }) {
    final id = 'answer-${++_promptIds}';
    prompts.add({
      'id': id,
      'promptId': promptId,
      'approvedText': approvedText,
      'pendingText': pendingText,
      'state': state,
      'revision': revision,
    });
    return id;
  }

  /// Fills every required field except review-gated content.
  void completeBasics() {
    birthDate = '1994-06-15';
    termsVersion = '1.0';
    acceptedAt = '2026-11-01T10:00:00.000Z';
    profile
      ..['displayName'] = 'Hanna'
      ..['genderIdentity'] = 'woman'
      ..['cityId'] = 'city-seattle-wa'
      ..['intention'] = 'serious';
    preferences['acceptedGenderCategories'] = ['man'];
  }

  List<String> get missing {
    final city = _city(profile['cityId'] as String?);
    return [
      if (!emailVerified) 'emailVerified',
      if (birthDate == null) 'adultEligible',
      if (termsVersion == null) 'termsAccepted',
      if (profile['displayName'] == null) 'displayName',
      if (profile['genderIdentity'] == null) 'genderIdentity',
      if ((preferences['acceptedGenderCategories'] as List).isEmpty) 'interests',
      if (city == null) 'location',
      if (profile['intention'] == null) 'intention',
      if (photos.where((p) => p['state'] == 'approved').length < 3) 'photos',
      if (prompts.where((a) => a['approvedText'] != null).length < 3) 'promptAnswers',
      if (accountStatus == 'suspended') 'accountSuspended',
    ];
  }

  void _recomputeReadiness() {
    if (missing.isEmpty && accountStatus == 'onboarding') accountStatus = 'active';
  }

  Map<String, Object?> get _account => {
    'userId': 'user-fixture-1',
    'accountStatus': accountStatus,
    'emailVerified': emailVerified,
    'birthDate': birthDate,
    'adultEligible': birthDate != null,
    'profileReady': missing.isEmpty,
    'discoverPaused': discoverPaused,
    'agreements': {'termsVersion': termsVersion, 'acceptedAt': acceptedAt},
    'readiness': {'ready': missing.isEmpty, 'missing': missing},
  };

  Map<String, Object?>? _city(String? id) {
    for (final c in catalogs['cities']! as List) {
      final city = c as Map<String, Object?>;
      if (city['id'] == id) return city;
    }
    return null;
  }

  String _promptText(String id) {
    for (final p in catalogs['prompts']! as List) {
      final prompt = p as Map<String, Object?>;
      if (prompt['id'] == id) return prompt['text']! as String;
    }
    return '';
  }

  Map<String, Object?> get _selfProfile {
    final city = _city(profile['cityId'] as String?);
    return {
      ...Map.of(profile)..remove('revision'),
      'cityName': city?['name'],
      'stateCode': city?['stateCode'],
      'promptAnswers': [
        for (final a in prompts) {...a, 'promptText': _promptText(a['promptId']! as String)},
      ],
      'revision': profile['revision'],
      'profileReady': missing.isEmpty,
    };
  }

  Map<String, Object?> get _publicProfile {
    final city = _city(profile['cityId'] as String?);
    String? shown(String field) =>
        profile['${field}Display'] == 'public' ? profile[field] as String? : null;
    final intention = (catalogs['intentions']! as List)
        .cast<Map<String, Object?>>()
        .where((i) => i['id'] == profile['intention'])
        .firstOrNull;
    final gender = (catalogs['genderCategories']! as List)
        .cast<Map<String, Object?>>()
        .where((g) => g['id'] == profile['genderIdentity'])
        .firstOrNull;
    final genderPublic = profile['genderDisplay'] == 'public';
    return {
      'userId': 'user-fixture-1',
      'displayName': profile['displayName'],
      'age': birthDate == null ? null : 32,
      'cityName': city?['name'],
      'stateCode': city?['stateCode'],
      'intention': profile['intention'],
      'intentionLabel': intention?['label'],
      'genderIdentity': genderPublic ? profile['genderIdentity'] : null,
      'genderLabel': genderPublic ? (gender?['label']) : null,
      'bio': profile['bio'],
      'hometown': shown('hometown'),
      'occupation': shown('occupation'),
      'education': shown('education'),
      'height': profile['heightDisplay'] == 'public' ? profile['height'] : null,
      'languages': profile['languagesDisplay'] == 'public' ? profile['languages'] : <String>[],
      'religion': shown('religion'),
      'promptAnswers': [
        for (final a in prompts)
          if (a['approvedText'] != null)
            {
              'id': a['id'],
              'promptId': a['promptId'],
              'promptText': _promptText(a['promptId']! as String),
              'text': a['approvedText'],
              'contentVersion': a['publishedRevision'] ?? a['revision'] ?? 1,
            },
      ],
      'photos': [
        for (final p in photos.where((p) => p['state'] == 'approved').toList()
          ..sort((a, b) => (a['order']! as int).compareTo(b['order']! as int)))
          {
            'id': p['id'],
            'order': p['order'],
            'width': p['width'],
            'height': p['height'],
            'contentVersion': p['contentVersion'],
            'media': p['media'],
          },
      ],
    };
  }

  Map<String, Object?> _photo(String id, String state, {Map<String, Object?>? rejection}) => {
    'id': id,
    'state': state,
    'order': photos.where((p) => p['state'] != 'rejected').length,
    'width': 1080,
    'height': 1440,
    'contentVersion': 1,
    'rejectionReason': rejection,
    'media': state == 'processing'
        ? null
        : {'thumb': '/v1/media/$id/thumb', 'display': '/v1/media/$id/display'},
    'createdAt': '2026-11-0${(_photoIds % 9) + 1}T12:00:00.000Z',
  };

  // Transport

  Future<http.Response> _handle(http.Request request) async {
    final isJson = request.headers['content-type']?.contains('json') ?? false;
    final body = !isJson || request.body.isEmpty
        ? null
        : jsonDecode(request.body) as Map<String, Object?>;
    requests.add(RecordedRequest(request.method, request.url.path, body, request.headers));
    if (offline) throw http.ClientException('Network is unreachable', request.url);
    for (final o in _overrides) {
      if (o.method == request.method && request.url.path.startsWith(o.pathPrefix)) {
        _overrides.remove(o);
        o.onMatch?.call();
        return _json(o.status, {'error': o.error, 'requestId': 'fake'});
      }
    }
    final response = _route(request.method, request.url.path, body ?? const {}, request);
    _recomputeReadiness();
    return response;
  }

  http.Response _route(
    String method,
    String path,
    Map<String, Object?> body,
    http.Request request,
  ) {
    switch ((method, path)) {
      case ('POST', '/v1/me/bootstrap'):
        return _ok({
          'userId': 'user-fixture-1',
          'accountStatus': accountStatus,
          'profileReady': missing.isEmpty,
          'adultEligible': birthDate != null,
        });
      case ('GET', '/v1/me'):
        return _ok(_account);
      case ('PATCH', '/v1/me/onboarding'):
        final updated = <String>[];
        if (body['birthDate'] case final String date) {
          if (date.compareTo(_adultBoundary) > 0) {
            return _error(422, 'AGE_INELIGIBLE', 'You must be at least 18 years old');
          }
          birthDate = date;
          updated.addAll(['birthDate', 'adultEligible']);
        }
        if (body['termsAccepted'] == true) {
          termsVersion = '1.0';
          acceptedAt = '2026-11-10T09:00:00.000Z';
          updated.add('agreements');
        }
        return _ok({'updated': updated});
      case ('GET', '/v1/catalogs'):
        return _ok(catalogs);
      case ('GET', '/v1/me/profile'):
        return _ok(_selfProfile);
      case ('GET', '/v1/me/profile/preview'):
        return _ok(_publicProfile);
      case ('PATCH', '/v1/me/profile'):
        return _revisioned(profile, body);
      case ('GET', '/v1/me/preferences'):
        return _ok(preferences);
      case ('PATCH', '/v1/me/preferences'):
        return _revisioned(preferences, body);
      case ('POST', '/v1/me/prompts'):
        if (prompts.any((a) => a['promptId'] == body['promptId'])) {
          return _error(409, 'DUPLICATE_PROMPT', 'You already answered this prompt');
        }
        if (prompts.length >= 3) return _error(422, 'PROMPT_LIMIT', 'At most 3');
        final id = seedPrompt(
          body['promptId']! as String,
          pendingText: body['text']! as String,
          state: 'pending',
        );
        return _json(201, {
          'data': {'id': id, 'promptId': body['promptId'], 'state': 'pending', 'revision': 1},
          'meta': {'requestId': 'fake'},
        });
      case ('GET', '/v1/me/photos'):
        final active = photos.where((p) => p['state'] != 'rejected').toList()
          ..sort((a, b) => (a['order']! as int).compareTo(b['order']! as int));
        final rejected = photos.where((p) => p['state'] == 'rejected');
        return _ok({
          'photos': [...active, ...rejected],
          'revision': photoRevision,
          'minPhotos': 3,
          'maxPhotos': 6,
        });
      case ('POST', '/v1/me/photos'):
        final key = request.headers['idempotency-key'];
        if (key == null) return _error(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Key required');
        if (_idempotency[key] case final existing?) {
          final photo = photos.firstWhere((p) => p['id'] == existing);
          return _ok({'id': existing, 'state': photo['state'], 'order': photo['order'], 'revision': photoRevision});
        }
        if (photos.where((p) => p['state'] != 'rejected').length >= 6) {
          return _error(422, 'PHOTO_LIMIT_REACHED', 'At most 6');
        }
        final id = seedPhoto(state: 'pending');
        _idempotency[key] = id;
        final photo = photos.last;
        return _json(201, {
          'data': {'id': id, 'state': 'pending', 'order': photo['order'], 'revision': photoRevision},
          'meta': {'requestId': 'fake'},
        });
      case ('PATCH', '/v1/me/photos/order'):
        if (body['expectedRevision'] != photoRevision) {
          return _conflict(photoRevision);
        }
        final ids = (body['photoIds']! as List).cast<String>();
        for (final (i, id) in ids.indexed) {
          photos.firstWhere((p) => p['id'] == id)['order'] = i;
        }
        photoRevision++;
        return _ok({'revision': photoRevision, 'photoIds': ids});
    }
    if (method == 'PATCH' && path.startsWith('/v1/me/prompts/')) {
      final answer = prompts.firstWhere((a) => a['id'] == path.split('/').last);
      if (body['expectedRevision'] != answer['revision']) {
        return _conflict(answer['revision']! as int);
      }
      answer
        ..['pendingText'] = body['text']
        ..['state'] = 'pending'
        ..['revision'] = (answer['revision']! as int) + 1;
      return _ok({'id': answer['id'], 'state': 'pending', 'revision': answer['revision']});
    }
    if (method == 'DELETE' && path.startsWith('/v1/me/prompts/')) {
      prompts.removeWhere((a) => a['id'] == path.split('/').last);
      return _ok({'deleted': true});
    }
    if (method == 'DELETE' && path.startsWith('/v1/me/photos/')) {
      final id = path.split('/').last;
      photos.removeWhere((p) => p['id'] == id);
      var order = 0;
      for (final p in photos.where((p) => p['state'] != 'rejected')) {
        p['order'] = order++;
      }
      photoRevision++;
      return _ok({'deleted': true, 'revision': photoRevision});
    }
    return _error(404, 'NOT_FOUND', 'No fake route for $method $path');
  }

  String get _adultBoundary {
    final parts = today.split('-').map(int.parse).toList();
    return '${parts[0] - 18}-${parts[1].toString().padLeft(2, '0')}-${parts[2].toString().padLeft(2, '0')}';
  }

  http.Response _revisioned(Map<String, Object?> doc, Map<String, Object?> body) {
    if (body['expectedRevision'] != doc['revision']) {
      return _conflict(doc['revision']! as int);
    }
    final updated = <String>[];
    for (final entry in body.entries) {
      if (entry.key == 'expectedRevision') continue;
      doc[entry.key] = entry.value;
      updated.add(entry.key);
    }
    if (updated.isEmpty) return _error(400, 'NO_UPDATES', 'No valid fields provided');
    doc['revision'] = (doc['revision']! as int) + 1;
    return _ok({'updated': updated, 'revision': doc['revision']});
  }

  http.Response _conflict(int current) => _json(409, {
    'error': {
      'code': 'REVISION_CONFLICT',
      'message': 'Modified elsewhere',
      'currentRevision': current,
      'retryable': true,
    },
    'requestId': 'fake',
  });

  http.Response _ok(Object data) =>
      _json(200, {'data': data, 'meta': {'requestId': 'fake'}});

  http.Response _error(int status, String code, String message) => _json(status, {
    'error': {'code': code, 'message': message, 'retryable': false},
    'requestId': 'fake',
  });

  http.Response _json(int status, Object body) => http.Response(
    jsonEncode(body),
    status,
    headers: {'content-type': 'application/json; charset=utf-8'},
  );

  /// Requests matching [method] and [path] exactly.
  List<RecordedRequest> sent(String method, String path) =>
      requests.where((r) => r.method == method && r.path == path).toList();
}

class RecordedRequest {
  RecordedRequest(this.method, this.path, this.body, this.headers);

  final String method;
  final String path;
  final Map<String, Object?>? body;
  final Map<String, String> headers;

  @override
  String toString() => '$method $path ${body ?? ''}';
}

class _Override {
  _Override(this.method, this.pathPrefix, this.status, this.error, {this.onMatch});

  final String method;
  final String pathPrefix;
  final int status;
  final Map<String, Object?> error;
  final void Function()? onMatch;
}
