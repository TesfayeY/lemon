import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lemon/core/api/api_error.dart';
import 'package:lemon/core/catalogs/catalogs.dart';
import 'package:lemon/features/onboarding/data/account.dart';
import 'package:lemon/features/profile/data/preferences.dart';
import 'package:lemon/features/profile/data/profile.dart';

/// Shared with the API contract test; see contracts/fixtures/README.md.
Map<String, dynamic> loadFixture(String name) {
  final file = File('../../contracts/fixtures/$name');
  return jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
}

Map<String, dynamic> dataOf(String name) =>
    loadFixture(name)['data'] as Map<String, dynamic>;

void main() {
  group('Contract fixtures round-trip through Dart DTOs', () {
    test('account snapshot', () {
      final json = dataOf('account.json');
      final account = Account.fromJson(json);

      expect(account.accountStatus, AccountStatus.onboarding);
      expect(account.birthDate, '1995-03-10');
      expect(
        account.agreements.acceptedAt,
        DateTime.utc(2026, 10, 24, 18, 2, 11),
      );
      expect(account.readiness.ready, isFalse);
      expect(account.readiness.missing, [
        ReadinessRequirement.photos,
        ReadinessRequirement.promptAnswers,
      ]);
      expect(account.toJson(), json);
    });

    test('self profile with answers awaiting review', () {
      final json = dataOf('self-profile.json');
      final profile = SelfProfile.fromJson(json);

      expect(profile.hometownDisplay, FieldVisibility.private);
      expect(profile.languages, ['tigrinya', 'english']);
      final edited = profile.promptAnswers.first;
      expect(edited.state, ReviewState.pending);
      expect(edited.approvedText, 'The full coffee ceremony, three rounds.');
      expect(edited.pendingText, isNotNull);
      expect(profile.promptAnswers.last.approvedText, isNull);
      expect(profile.toJson(), json);
    });

    test('public profile', () {
      final json = dataOf('public-profile.json');
      final profile = PublicProfile.fromJson(json);

      expect(profile.age, 31);
      expect(profile.hometown, isNull);
      expect(
        profile.promptAnswers.single.text,
        'The full coffee ceremony, three rounds.',
      );
      expect(profile.toJson(), json);
    });

    test('preferences', () {
      final json = dataOf('preferences.json');
      final prefs = Preferences.fromJson(json);

      expect(prefs.locationScope, LocationScope.state);
      expect(prefs.minAge, 27);
      expect(prefs.toJson(), json);
    });

    test('catalogs', () {
      final json = dataOf('catalogs.json');
      final catalogs = Catalogs.fromJson(json);

      expect(catalogs.cities.single.stateCode, 'TX');
      expect(catalogs.languages.map((l) => l.id), ['amharic', 'tigrinya']);
      expect(catalogs.toJson(), json);
    });

    test('revision conflict error', () {
      final json =
          loadFixture('error-revision-conflict.json')['error']
              as Map<String, dynamic>;
      final error = ApiError.fromJson(json);

      expect(error.isRevisionConflict, isTrue);
      expect(error.currentRevision, 8);
      expect(error.retryable, isTrue);
      expect(error.toJson(), json);
    });

    test('validation error', () {
      final json =
          loadFixture('error-validation.json')['error'] as Map<String, dynamic>;
      final error = ApiError.fromJson(json);

      expect(error.isRevisionConflict, isFalse);
      expect(error.fieldErrors.single.field, 'displayName');
      expect(error.toJson(), json);
    });
  });

  group('Forward compatibility', () {
    test('an unknown readiness requirement does not break parsing', () {
      final json = dataOf('account.json');
      final readiness = json['readiness'] as Map<String, dynamic>;
      final account = Account.fromJson({
        ...json,
        'readiness': {
          ...readiness,
          'missing': ['photos', 'somethingNew'],
        },
      });

      expect(account.readiness.missing, [
        ReadinessRequirement.photos,
        ReadinessRequirement.unknown,
      ]);
    });

    test('an unknown visibility value is a contract violation', () {
      final json = dataOf('self-profile.json');
      expect(
        () => SelfProfile.fromJson({...json, 'religionDisplay': 'friends'}),
        throwsFormatException,
      );
    });
  });
}
