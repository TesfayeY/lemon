import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import '../test/helpers/fake_auth.dart';
import '../test/helpers/fake_backend.dart';
import '../test/helpers/harness.dart';
import '../test/helpers/journey.dart';

/// On-device happy path from sign-in through onboarding. Runs the real
/// widgets, layout, keyboard and date picker on a simulator or device against
/// an in-memory backend and a fake Firebase Auth (fictional data only):
///
///   `flutter test integration_test -d <device-id>`
///
/// A variant against the local Express API and Firebase Auth emulator needs a
/// seeded account and the photo review script; see
/// docs/features/auth-screens.md and docs/features/onboarding-flow.md.
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('sign-in and onboarding happy path on device', (tester) async {
    final backend = FakeBackend();
    final picker = FakePhotoPicker();
    await pumpLemon(
      tester,
      backend: backend,
      picker: picker,
      auth: FakeAuthRepository(signedIn: false),
    );

    await signInFromWelcome(tester);
    await completeBirthDate(tester);
    await completeTerms(tester);
    await completeBasics(tester);
    await completeLocation(tester);
    await completePreferences(tester);
    await completePhotos(tester, picker);
    await completePrompts(tester);
    await skipAbout(tester);
    expect(find.text('Almost there'), findsOneWidget);

    backend
      ..approveAllPhotos()
      ..approveAllPrompts();
    await tapText(tester, 'Check again');
    await tapText(tester, 'Start exploring');
    expect(find.byType(NavigationBar), findsOneWidget);
  });
}
