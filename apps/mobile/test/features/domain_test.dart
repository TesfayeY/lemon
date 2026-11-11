import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lemon/features/onboarding/data/account.dart';
import 'package:lemon/features/onboarding/domain/birth_date.dart';
import 'package:lemon/features/onboarding/domain/onboarding_steps.dart';
import 'package:lemon/features/profile/data/photos.dart';
import 'package:lemon/features/profile/domain/validation.dart';

Readiness readiness(List<ReadinessRequirement> missing) =>
    Readiness(ready: missing.isEmpty, missing: missing);

void main() {
  group('adult gate', () {
    final today = DateTime(2026, 11, 10);

    test('requires a date', () {
      expect(validateBirthDate(null, today), BirthDateError.required);
    });

    test('rejects a future date', () {
      expect(
        validateBirthDate(DateTime(2026, 11, 11), today),
        BirthDateError.future,
      );
    });

    test('turning 18 today is eligible; tomorrow is not', () {
      expect(validateBirthDate(DateTime(2008, 11, 10), today), isNull);
      expect(
        validateBirthDate(DateTime(2008, 11, 11), today),
        BirthDateError.underage,
      );
    });

    test('a 29 February birthday turns 18 on 1 March in non-leap years', () {
      final birth = DateTime(2008, 2, 29);
      expect(ageOn(birth, DateTime(2026, 2, 28)), 17);
      expect(ageOn(birth, DateTime(2026, 3, 1)), 18);
    });

    test('formats and parses date-only strings without time zones', () {
      expect(isoDate(DateTime(1995, 3, 9)), '1995-03-09');
      expect(parseIsoDate('1995-03-09'), DateTime(1995, 3, 9));
      expect(parseIsoDate('03/09/1995'), isNull);
      expect(parseIsoDate(null), isNull);
    });
  });

  group('onboarding resume', () {
    test('starts at the earliest missing requirement', () {
      expect(
        resumeStep(readiness([
          ReadinessRequirement.photos,
          ReadinessRequirement.displayName,
        ])),
        OnboardingStep.basics,
      );
      expect(
        resumeStep(readiness([ReadinessRequirement.adultEligible])),
        OnboardingStep.birthDate,
      );
    });

    test('a profile that is only waiting on review resumes at photos', () {
      expect(
        resumeStep(readiness([
          ReadinessRequirement.photos,
          ReadinessRequirement.promptAnswers,
        ])),
        OnboardingStep.photos,
      );
    });

    test('nothing missing goes to the readiness summary', () {
      expect(resumeStep(readiness([])), OnboardingStep.readiness);
    });

    test('unknown or unfixable requirements do not pick a step', () {
      expect(
        resumeStep(readiness([ReadinessRequirement.unknown])),
        OnboardingStep.readiness,
      );
      expect(stepFor(ReadinessRequirement.accountSuspended), isNull);
    });

    test('email verification only shows while it is missing', () {
      expect(
        visibleSteps(readiness([])),
        isNot(contains(OnboardingStep.verifyEmail)),
      );
      expect(
        visibleSteps(readiness([ReadinessRequirement.emailVerified])).first,
        OnboardingStep.verifyEmail,
      );
    });

    test('every requirement a person can fix maps to a step', () {
      for (final r in ReadinessRequirement.values) {
        final fixable =
            r != ReadinessRequirement.accountSuspended &&
            r != ReadinessRequirement.unknown;
        expect(stepFor(r) != null, fixable, reason: r.wire);
      }
    });
  });

  group('form validation', () {
    test('names count graphemes, so Ethiopic names fit the limit', () {
      final ethiopic = 'ሰላም' * 13; // 39 graphemes
      expect(validateRequiredText(ethiopic, max: 40), isNull);
      expect(validateRequiredText('$ethiopicማ', max: 40), isNull);
      expect(
        validateRequiredText('$ethiopicማማ', max: 40),
        TextError.tooLong,
      );
    });

    test('whitespace-only text is empty', () {
      expect(validateRequiredText('   \n ', max: 40), TextError.required);
      expect(normalizeWhitespace('  Selam   Tesfaye '), 'Selam Tesfaye');
    });

    test('optional text may be empty and is stored as null', () {
      expect(validateOptionalText('', max: 100), isNull);
      expect(optionalTextValue('   '), isNull);
      expect(optionalTextValue(' Asmara '), 'Asmara');
      expect(validateOptionalText('a' * 101, max: 100), TextError.tooLong);
    });

    test('heights convert to feet and inches', () {
      expect(feetAndInches(165), (feet: 5, inches: 5));
      expect(feetAndInches(183), (feet: 6, inches: 0));
    });
  });

  test('photos fixture round-trips through the DTO', () {
    final json =
        (jsonDecode(File('test/fixtures/photos.json').readAsStringSync())
                as Map<String, dynamic>)['data']
            as Map<String, dynamic>;
    expect(PhotoSet.fromJson(json).toJson(), json);
  });
}
