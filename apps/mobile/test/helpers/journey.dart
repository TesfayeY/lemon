import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'harness.dart';

/// Steps of the onboarding happy path, shared by the widget journey test and
/// the on-device integration test. Uses fictional data only.

Future<void> tapText(WidgetTester tester, String text) =>
    tapVisible(tester, find.text(text));

Future<void> continueStep(WidgetTester tester) =>
    tapVisible(tester, find.widgetWithText(ElevatedButton, 'Continue'));

Future<void> chooseBirthDate(WidgetTester tester, String typed) async {
  await tapVisible(tester, find.widgetWithText(OutlinedButton, 'Choose your birth date'));
  await tester.enterText(find.byType(TextField).last, typed);
  await tester.tap(find.text('OK'));
  await tester.pumpAndSettle();
}

Future<void> completeBirthDate(WidgetTester tester) async {
  expect(find.text("When's your birthday?"), findsOneWidget);
  await chooseBirthDate(tester, '06/15/1994');
  await continueStep(tester);
}

Future<void> completeTerms(WidgetTester tester) async {
  expect(find.text('Before you join'), findsOneWidget);
  await tapText(tester, 'I agree to the Terms of Service and Privacy Policy');
  await continueStep(tester);
}

Future<void> completeBasics(WidgetTester tester) async {
  expect(find.text('The basics'), findsOneWidget);
  await tester.enterText(find.widgetWithText(TextField, 'First name'), 'Hanna');
  await tapText(tester, 'Woman');
  await tapText(tester, 'Looking for something serious');
  await continueStep(tester);
}

Future<void> completeLocation(WidgetTester tester) async {
  expect(find.text('Where do you live?'), findsOneWidget);
  await tester.enterText(find.widgetWithText(TextField, 'Search US cities'), 'sea');
  await tester.pumpAndSettle();
  await tapText(tester, 'Seattle, WA');
  await continueStep(tester);
}

Future<void> completePreferences(WidgetTester tester) async {
  expect(find.text('Who would you like to meet?'), findsOneWidget);
  await tapText(tester, 'Man');
  await tapText(tester, 'Anywhere in the US');
  await continueStep(tester);
}

Future<void> completePhotos(WidgetTester tester, FakePhotoPicker picker) async {
  expect(find.text('Add your photos'), findsOneWidget);
  for (var i = 0; i < 3; i++) {
    picker.add('photo-$i.jpg');
    await tapVisible(tester, find.byIcon(Icons.add_a_photo_outlined));
  }
  expect(find.text('In review'), findsNWidgets(3));
  await continueStep(tester);
}

Future<void> completePrompts(WidgetTester tester) async {
  expect(find.text('Answer three prompts'), findsOneWidget);
  const answers = {
    'A tradition I would love to share with you…': 'Sunday coffee ceremony with my aunts.',
    'My ideal Sunday looks like…': 'A long walk, then injera at home.',
    'A place that feels like home…': 'My grandmother\'s kitchen.',
  };
  for (final entry in answers.entries) {
    await tapVisible(tester, find.widgetWithText(OutlinedButton, 'Choose a prompt'));
    await tapText(tester, entry.key);
    await tester.enterText(find.widgetWithText(TextField, 'Your answer'), entry.value);
    await tapVisible(tester, find.widgetWithText(ElevatedButton, 'Submit for review'));
  }
  expect(find.text('Waiting for review'), findsNWidgets(3));
  await continueStep(tester);
}

Future<void> skipAbout(WidgetTester tester) async {
  expect(find.text('More about you'), findsOneWidget);
  await tapText(tester, 'Skip for now');
}
