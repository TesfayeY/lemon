import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lemon/core/l10n/l10n.dart';
import 'package:lemon/core/theme/lemon_theme.dart';
import 'package:lemon/features/onboarding/data/account.dart';
import 'package:lemon/features/onboarding/domain/onboarding_steps.dart';
import 'package:lemon/features/onboarding/ui/readiness_view.dart';

import '../../helpers/fake_backend.dart';
import '../../helpers/harness.dart';
import '../../helpers/journey.dart';

Widget localized(Widget child) => MaterialApp(
  theme: buildLemonTheme(),
  localizationsDelegates: AppLocalizations.localizationsDelegates,
  supportedLocales: AppLocalizations.supportedLocales,
  home: Scaffold(body: child),
);

void main() {
  group('adult gate', () {
    testWidgets('requires a date before continuing', (tester) async {
      final backend = FakeBackend();
      await pumpLemon(tester, backend: backend);

      await continueStep(tester);
      expect(find.text('Choose your birth date to continue.'), findsOneWidget);
      expect(backend.sent('PATCH', '/v1/me/onboarding'), isEmpty);
    });

    testWidgets('an under-18 date shows a respectful explanation and is '
        'not sent', (tester) async {
      final backend = FakeBackend();
      await pumpLemon(tester, backend: backend);

      await chooseBirthDate(tester, '11/11/2008'); // 18 tomorrow
      await continueStep(tester);

      expect(find.text('Thanks for your interest'), findsOneWidget);
      expect(
        find.text(
          "Lemon is only for adults 18 and older, so we can't create a "
          'profile for you.',
        ),
        findsOneWidget,
      );
      expect(backend.sent('PATCH', '/v1/me/onboarding'), isEmpty);
    });

    testWidgets('the server decides eligibility even when the client allows '
        'the date', (tester) async {
      final backend = FakeBackend()
        ..failNext(
          'PATCH',
          '/v1/me/onboarding',
          status: 422,
          error: {
            'code': 'AGE_INELIGIBLE',
            'message': 'You must be at least 18 years old to use Lemon',
            'retryable': false,
          },
        );
      await pumpLemon(tester, backend: backend);

      await chooseBirthDate(tester, '11/10/2008'); // 18 today on the device
      await continueStep(tester);

      expect(find.text('Thanks for your interest'), findsOneWidget);
      expect(backend.birthDate, isNull);
    });

    testWidgets('turning 18 today is accepted and saved as a date-only '
        'string', (tester) async {
      final backend = FakeBackend();
      await pumpLemon(tester, backend: backend);

      await chooseBirthDate(tester, '11/10/2008');
      expect(find.textContaining('Birth date: '), findsOneWidget);
      await continueStep(tester);

      expect(backend.sent('PATCH', '/v1/me/onboarding').single.body, {
        'birthDate': '2008-11-10',
      });
      expect(find.text('Before you join'), findsOneWidget);
    });

    testWidgets('explains that the birth date stays private', (tester) async {
      await pumpLemon(tester, backend: FakeBackend());
      expect(
        find.text('Your birth date stays private. People only see your age.'),
        findsOneWidget,
      );
      expect(find.text('Lemon is for adults 18 and older.'), findsOneWidget);
    });
  });

  group('terms', () {
    testWidgets('must be agreed to before continuing', (tester) async {
      final backend = FakeBackend()..birthDate = '1994-06-15';
      await pumpLemon(tester, backend: backend);
      expect(find.text('Before you join'), findsOneWidget);

      await continueStep(tester);
      expect(find.text('Please agree to continue.'), findsOneWidget);
      expect(backend.termsVersion, isNull);

      await completeTerms(tester);
      expect(backend.termsVersion, '1.0');
      expect(find.text('The basics'), findsOneWidget);
    });
  });

  group('basics validation', () {
    testWidgets('names, gender and intention are required', (tester) async {
      final backend = FakeBackend()
        ..birthDate = '1994-06-15'
        ..termsVersion = '1.0';
      await pumpLemon(tester, backend: backend);

      await continueStep(tester);
      expect(find.text('Enter your first name.'), findsOneWidget);
      expect(find.text('Choose the option that fits you best.'), findsOneWidget);
      expect(find.text("Choose what you're looking for."), findsOneWidget);
      expect(backend.sent('PATCH', '/v1/me/profile'), isEmpty);
    });

    testWidgets('server field errors are pointed at the field', (tester) async {
      final backend = FakeBackend()
        ..birthDate = '1994-06-15'
        ..termsVersion = '1.0'
        ..failNext(
          'PATCH',
          '/v1/me/profile',
          status: 422,
          error: {
            'code': 'VALIDATION_ERROR',
            'message': 'Invalid fields',
            'fieldErrors': [
              {'field': 'displayName', 'message': 'Name must be 40 characters or fewer'},
            ],
            'retryable': false,
          },
        );
      await pumpLemon(tester, backend: backend);
      await completeBasics(tester);

      // Localized copy, never the server's English diagnostic
      expect(find.text('Some details need another look.'), findsNWidgets(2));
      expect(find.text('Name must be 40 characters or fewer'), findsNothing);
      expect(find.text('The basics'), findsOneWidget);
    });
  });

  group('location', () {
    testWidgets('shows only catalog US cities as "City, ST" and keeps '
        'same-named cities apart', (tester) async {
      final backend = FakeBackend()
        ..completeBasics()
        ..profile['cityId'] = null;
      await pumpLemon(tester, backend: backend);
      expect(find.text('Where do you live?'), findsOneWidget);

      await tester.enterText(
        find.widgetWithText(TextField, 'Search US cities'),
        'portland',
      );
      await tester.pumpAndSettle();
      expect(find.text('Portland, ME'), findsOneWidget);
      expect(find.text('Portland, OR'), findsOneWidget);

      await tapText(tester, 'Portland, OR');
      await continueStep(tester);
      expect(backend.sent('PATCH', '/v1/me/profile').single.body, {
        'cityId': 'city-portland-or',
        'expectedRevision': 1,
      });
    });

    testWidgets('an unknown city explains what to do', (tester) async {
      final backend = FakeBackend()
        ..completeBasics()
        ..profile['cityId'] = null;
      await pumpLemon(tester, backend: backend);

      await tester.enterText(
        find.widgetWithText(TextField, 'Search US cities'),
        'Addis Ababa',
      );
      await tester.pumpAndSettle();
      expect(
        find.text("We don't have that city yet. Try a nearby city."),
        findsOneWidget,
      );
    });
  });

  group('preferences', () {
    testWidgets('at least one interest is required', (tester) async {
      final backend = FakeBackend()
        ..completeBasics()
        ..preferences['acceptedGenderCategories'] = <String>[];
      await pumpLemon(tester, backend: backend);
      expect(find.text('Who would you like to meet?'), findsOneWidget);

      await continueStep(tester);
      expect(find.text('Choose at least one.'), findsOneWidget);
      expect(backend.sent('PATCH', '/v1/me/preferences'), isEmpty);
    });

    testWidgets('explains scope and long distance and sends the choices', (
      tester,
    ) async {
      final backend = FakeBackend()
        ..completeBasics()
        ..preferences['acceptedGenderCategories'] = <String>[];
      await pumpLemon(tester, backend: backend);

      expect(
        find.text("You'll only see people whose own choices include you too."),
        findsOneWidget,
      );
      await tapText(tester, 'Man');
      await tapText(tester, 'Nonbinary');
      await tapText(tester, 'My city');
      await tapText(tester, 'Open to long distance');
      expect(
        find.text(
          "Lets people know you're open to it. It doesn't widen where your "
          'matches live.',
        ),
        findsOneWidget,
      );
      await continueStep(tester);

      expect(backend.sent('PATCH', '/v1/me/preferences').single.body, {
        'acceptedGenderCategories': ['man', 'nonbinary'],
        'locationScope': 'city',
        'longDistance': true,
        'expectedRevision': 1,
      });
    });
  });

  group('readiness view', () {
    testWidgets('ready shows the way into the app', (tester) async {
      var started = false;
      await tester.pumpWidget(
        localized(
          ReadinessView(
            readiness: const Readiness(ready: true, missing: []),
            onCheckAgain: () {},
            onStart: () => started = true,
          ),
        ),
      );
      expect(find.text("You're all set"), findsOneWidget);
      await tester.tap(find.text('Start exploring'));
      expect(started, isTrue);
    });

    testWidgets('not ready lists exactly what the server reports missing', (
      tester,
    ) async {
      OnboardingStep? fixed;
      var checked = 0;
      await tester.pumpWidget(
        localized(
          ReadinessView(
            readiness: const Readiness(
              ready: false,
              missing: [
                ReadinessRequirement.location,
                ReadinessRequirement.photos,
                ReadinessRequirement.unknown,
              ],
            ),
            onCheckAgain: () => checked++,
            onFix: (step) => fixed = step,
            onStart: () {},
          ),
        ),
      );

      expect(find.text('Almost there'), findsOneWidget);
      expect(find.text('Choose your city'), findsOneWidget);
      expect(find.text('Three approved photos'), findsOneWidget);
      expect(
        find.text(
          "One more step is needed. If this doesn't go away, update the app.",
        ),
        findsOneWidget,
      );
      expect(find.textContaining('Reviews are done by people'), findsOneWidget);
      // Never offered while the server says not ready
      expect(find.text('Start exploring'), findsNothing);
      // Only fixable requirements get a Fix action
      expect(find.text('Fix'), findsNWidgets(2));

      await tester.tap(find.bySemanticsLabel('Fix: Three approved photos'));
      expect(fixed, OnboardingStep.photos);
      await tester.tap(find.text('Check again'));
      expect(checked, 1);
    });
  });
}
