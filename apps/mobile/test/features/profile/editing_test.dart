import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lemon/app/shell.dart';
import 'package:lemon/core/widgets/bottom_nav.dart';

import '../../helpers/fake_backend.dart';
import '../../helpers/harness.dart';
import '../../helpers/journey.dart';

/// An active, ready profile with fictional content.
FakeBackend readyBackend() {
  final backend = FakeBackend()
    ..accountStatus = 'active'
    ..completeBasics();
  for (var i = 0; i < 3; i++) {
    backend.seedPhoto();
  }
  backend
    ..seedPrompt('prompt-tradition', approvedText: 'Coffee with my aunts.')
    ..seedPrompt('prompt-sunday', approvedText: 'A long walk by the lake.')
    ..seedPrompt('prompt-home', approvedText: 'Grandmother\'s kitchen.');
  return backend;
}

Future<void> openYou(WidgetTester tester, FakeBackend backend, {bool sensitive = false}) =>
    pumpLemon(
      tester,
      backend: backend,
      home: const AppShell(initialTab: LemonTab.you),
      showSensitiveFields: sensitive,
    );

void main() {
  group('You tab', () {
    testWidgets('shows the server status: visible when ready', (tester) async {
      await openYou(tester, readyBackend());
      expect(find.text('Hanna'), findsOneWidget);
      expect(find.text('Seattle, WA'), findsOneWidget);
      expect(find.text('Your profile is visible'), findsOneWidget);
    });

    testWidgets('lists what is missing when the server says hidden', (
      tester,
    ) async {
      final backend = readyBackend()..photos.removeLast();
      await openYou(tester, backend);
      expect(find.text('Your profile is hidden'), findsOneWidget);
      expect(find.text('Three approved photos'), findsOneWidget);
    });
  });

  group('revision conflicts', () {
    testWidgets('keeping my edits reapplies them on the latest revision', (
      tester,
    ) async {
      final backend = readyBackend();
      await openYou(tester, backend);
      await tapText(tester, 'Name, gender and intention');
      await tester.enterText(find.widgetWithText(TextField, 'First name'), 'Hanna T.');

      // Another device saved meanwhile
      backend.profile
        ..['intention'] = 'open'
        ..['revision'] = 5;
      await tapVisible(
        tester,
        find.widgetWithText(ElevatedButton, 'Save'),
        settle: false,
      );

      expect(find.text('Updated on another device'), findsOneWidget);
      await tester.tap(find.text('Keep my edits'));
      await tester.pumpAndSettle();

      final patches = backend.sent('PATCH', '/v1/me/profile');
      expect(patches.map((p) => p.body!['expectedRevision']), [1, 5]);
      // Only the field I changed is resent; the other device's edit survives
      expect(patches.last.body, {'displayName': 'Hanna T.', 'expectedRevision': 5});
      expect(backend.profile['displayName'], 'Hanna T.');
      expect(backend.profile['intention'], 'open');
      expect(find.text('Saved'), findsOneWidget);
    });

    testWidgets('using the latest version reloads the form and says so', (
      tester,
    ) async {
      final backend = readyBackend();
      await openYou(tester, backend);
      await tapText(tester, 'Name, gender and intention');
      await tester.enterText(find.widgetWithText(TextField, 'First name'), 'Hanna T.');

      backend.profile
        ..['displayName'] = 'Hanna M.'
        ..['revision'] = 4;
      await tapVisible(
        tester,
        find.widgetWithText(ElevatedButton, 'Save'),
        settle: false,
      );
      await tester.tap(find.text('Use latest version'));
      await tester.pumpAndSettle();

      expect(
        find.text('We loaded the latest version of your profile.'),
        findsOneWidget,
      );
      expect(find.widgetWithText(TextField, 'Hanna M.'), findsOneWidget);
      expect(backend.sent('PATCH', '/v1/me/profile'), hasLength(1));
      expect(backend.profile['displayName'], 'Hanna M.');
    });

    testWidgets('preferences use the same conflict recovery', (tester) async {
      final backend = readyBackend();
      await openYou(tester, backend);
      await tapText(tester, 'Dating preferences');
      await tapText(tester, 'Nonbinary');

      backend.preferences['revision'] = 9;
      await tapVisible(
        tester,
        find.widgetWithText(ElevatedButton, 'Save'),
        settle: false,
      );
      await tester.tap(find.text('Keep my edits'));
      await tester.pumpAndSettle();

      expect(
        backend.sent('PATCH', '/v1/me/preferences').last.body,
        {
          'acceptedGenderCategories': ['man', 'nonbinary'],
          'expectedRevision': 9,
        },
      );
    });
  });

  group('preview', () {
    testWidgets('shows what others see: private fields and pending content '
        'are absent', (tester) async {
      final backend = readyBackend();
      backend.profile
        ..['occupation'] = 'Pharmacist'
        ..['occupationDisplay'] = 'public'
        ..['hometown'] = 'Asmara'
        ..['hometownDisplay'] = 'private';
      backend.prompts.first
        ..['pendingText'] = 'An edit still waiting for review.'
        ..['state'] = 'pending';
      backend.seedPhoto(state: 'pending');
      await openYou(tester, backend);
      await tapText(tester, 'Preview your profile');

      expect(find.textContaining('This is how other people see you.'), findsOneWidget);
      expect(find.text('Hanna, 32'), findsOneWidget);
      expect(find.text('Looking for something serious'), findsOneWidget);
      await scrollToVisible(tester, find.text('Pharmacist'));
      expect(find.text('Asmara'), findsNothing);
      expect(find.text('An edit still waiting for review.'), findsNothing);
      // Only approved photos are shown
      expect(find.bySemanticsLabel('Photo 4'), findsNothing);
    });
  });

  group('sensitive fields (P-03)', () {
    testWidgets('are hidden by default', (tester) async {
      await openYou(tester, readyBackend());
      await tapText(tester, 'More about you');
      expect(find.widgetWithText(TextField, 'Bio'), findsOneWidget);
      await scrollToVisible(tester, find.text('Languages you speak'));
      // Religion would sit between languages and Save
      await scrollToVisible(tester, find.widgetWithText(ElevatedButton, 'Save'));
      expect(find.widgetWithText(TextField, 'Religion'), findsNothing);
    });

    testWidgets('appear only when the single flag is on', (tester) async {
      final backend = readyBackend();
      await openYou(tester, backend, sensitive: true);
      await tapText(tester, 'More about you');
      await scrollToVisible(tester, find.widgetWithText(TextField, 'Religion'));
      expect(find.widgetWithText(TextField, 'Religion'), findsOneWidget);
    });

    testWidgets('saving optional details never sends religion when hidden', (
      tester,
    ) async {
      final backend = readyBackend();
      await openYou(tester, backend);
      await tapText(tester, 'More about you');
      await tester.enterText(find.widgetWithText(TextField, 'Bio'), 'Sunday buna.');
      await tapVisible(tester, find.widgetWithText(ElevatedButton, 'Save'));

      final body = backend.sent('PATCH', '/v1/me/profile').single.body!;
      expect(body, {'bio': 'Sunday buna.', 'expectedRevision': 1});
    });
  });
}
