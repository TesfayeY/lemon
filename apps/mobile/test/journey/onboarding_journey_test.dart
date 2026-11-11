import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../helpers/fake_auth.dart';
import '../helpers/fake_backend.dart';
import '../helpers/harness.dart';
import '../helpers/journey.dart';

void main() {
  testWidgets('a new person signs in, completes onboarding and enters the '
      'app only after the server reports the profile ready', (tester) async {
    final backend = FakeBackend();
    final picker = FakePhotoPicker();
    await pumpLemon(
      tester,
      backend: backend,
      picker: picker,
      auth: FakeAuthRepository(signedIn: false),
    );
    expect(backend.requests, isEmpty);

    await signInFromWelcome(tester);
    expect(find.text('Step 1 of 9'), findsOneWidget);
    await completeBirthDate(tester);
    expect(backend.sent('PATCH', '/v1/me/onboarding').first.body, {
      'birthDate': '1994-06-15',
    });
    await completeTerms(tester);
    await completeBasics(tester);
    await completeLocation(tester);
    await completePreferences(tester);
    await completePhotos(tester, picker);
    await completePrompts(tester);
    await skipAbout(tester);

    // Content is waiting for human review, so the server says "not ready"
    expect(find.text('Almost there'), findsOneWidget);
    expect(find.text('Three approved photos'), findsOneWidget);
    expect(find.text('Three approved prompt answers'), findsOneWidget);
    expect(find.text('Start exploring'), findsNothing);
    expect(backend.accountStatus, 'onboarding');

    // A reviewer approves everything; the client only learns this by asking
    backend
      ..approveAllPhotos()
      ..approveAllPrompts();
    await tapText(tester, 'Check again');
    expect(find.text("You're all set"), findsOneWidget);
    expect(backend.accountStatus, 'active');

    await tapText(tester, 'Start exploring');
    expect(find.byType(NavigationBar), findsOneWidget);

    // Every edit carried the revision it was based on
    for (final r in backend.requests.where((r) => r.method == 'PATCH')) {
      if (r.path == '/v1/me/onboarding') continue;
      expect(r.body!.containsKey('expectedRevision'), isTrue, reason: '$r');
    }
    // The client never sent an identity of its own
    for (final r in backend.requests) {
      expect(r.body?.keys ?? const <String>[], isNot(contains('userId')));
      if (r.path == '/v1/catalogs') continue; // public
      expect(r.headers['authorization'], 'Bearer test-token', reason: '$r');
    }
  });

  testWidgets('restarting midway resumes from the server checklist', (
    tester,
  ) async {
    final backend = FakeBackend();
    await pumpLemon(tester, backend: backend);
    await completeBirthDate(tester);
    await completeTerms(tester);
    await completeBasics(tester);
    await completeLocation(tester);

    // App restarts (or a second device signs in): new widget tree, same server
    await tester.pumpWidget(const SizedBox());
    await pumpLemon(tester, backend: backend);

    expect(find.text('Who would you like to meet?'), findsOneWidget);
    expect(find.text('Step 5 of 9'), findsOneWidget);
  });

  testWidgets('back returns to the previous step with saved values', (
    tester,
  ) async {
    final backend = FakeBackend();
    await pumpLemon(tester, backend: backend);
    await completeBirthDate(tester);
    await completeTerms(tester);
    await completeBasics(tester);

    await tester.tap(find.byType(BackButton));
    await tester.pumpAndSettle();
    expect(find.text('The basics'), findsOneWidget);
    expect(find.widgetWithText(TextField, 'Hanna'), findsOneWidget);

    // Unchanged data moves forward without another save
    final saves = backend.sent('PATCH', '/v1/me/profile').length;
    await continueStep(tester);
    expect(find.text('Where do you live?'), findsOneWidget);
    expect(backend.sent('PATCH', '/v1/me/profile'), hasLength(saves));
  });

  testWidgets('a failed save keeps the person on the step with their input', (
    tester,
  ) async {
    final backend = FakeBackend()
      ..birthDate = '1994-06-15'
      ..termsVersion = '1.0';
    await pumpLemon(tester, backend: backend);
    expect(find.text('The basics'), findsOneWidget);

    await tester.enterText(find.widgetWithText(TextField, 'First name'), 'Hanna');
    await tapText(tester, 'Woman');
    await tapText(tester, 'Looking for something serious');
    backend.offline = true;
    await continueStep(tester);

    expect(
      find.text('You are offline. Check your connection and try again.'),
      findsOneWidget,
    );
    expect(find.text('The basics'), findsOneWidget);
    expect(find.widgetWithText(TextField, 'Hanna'), findsOneWidget);

    backend.offline = false;
    await continueStep(tester);
    expect(find.text('Where do you live?'), findsOneWidget);
    expect(backend.profile['displayName'], 'Hanna');
  });
}
