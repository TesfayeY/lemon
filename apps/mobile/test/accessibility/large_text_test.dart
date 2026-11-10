import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lemon/app/shell.dart';
import 'package:lemon/core/widgets/bottom_nav.dart';
import 'package:lemon/features/onboarding/data/account.dart';
import 'package:lemon/features/onboarding/ui/readiness_view.dart';
import 'package:lemon/features/profile/ui/photo_editor.dart';
import 'package:lemon/features/profile/ui/prompt_editor.dart';

import '../features/profile/editing_test.dart' show readyBackend;
import '../helpers/fake_backend.dart';
import '../helpers/harness.dart';

/// A small phone at 200% text. Any overflow fails the test.
const phone = Size(360, 690);
const largeText = 2.0;

/// Scrolls through the whole page so every part is laid out at least once.
Future<void> scrollThrough(WidgetTester tester) async {
  final list = find.byType(ListView);
  if (list.evaluate().isEmpty) return;
  for (var i = 0; i < 12; i++) {
    await tester.drag(list.last, const Offset(0, -300));
    await tester.pumpAndSettle();
  }
}

void main() {
  final cases = <String, FakeBackend Function()>{
    'birth date step': FakeBackend.new,
    'terms step': () => FakeBackend()..birthDate = '1994-06-15',
    'basics step': () => FakeBackend()
      ..birthDate = '1994-06-15'
      ..termsVersion = '1.0',
    'location step': () => FakeBackend()
      ..completeBasics()
      ..profile['cityId'] = null,
    'preferences step': () => FakeBackend()
      ..completeBasics()
      ..preferences['acceptedGenderCategories'] = <String>[],
    'photos step': () => FakeBackend()
      ..completeBasics()
      ..seedPhoto()
      ..seedPhoto(state: 'pending')
      ..seedPhoto(
        state: 'rejected',
        rejection: {'code': 'low_quality', 'message': 'Low quality'},
      ),
  };

  for (final entry in cases.entries) {
    testWidgets('${entry.key} fits at 200% text on a small phone', (
      tester,
    ) async {
      await pumpLemon(
        tester,
        backend: entry.value(),
        textScale: largeText,
        surfaceSize: phone,
      );
      final context = tester.element(find.byType(Scaffold).first);
      expect(MediaQuery.textScalerOf(context).scale(16), 32);
      await scrollThrough(tester);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('prompt editor with every review state fits at 200% text', (
    tester,
  ) async {
    final backend = FakeBackend()
      ..seedPrompt('prompt-tradition', approvedText: 'Coffee with my aunts.')
      ..seedPrompt(
        'prompt-sunday',
        approvedText: 'Walks.',
        pendingText: 'A long walk, then injera at home.',
        state: 'pending',
      )
      ..seedPrompt('prompt-home', pendingText: 'Declined.', state: 'rejected');
    await pumpLemon(
      tester,
      backend: backend,
      home: const Scaffold(body: PromptEditor()),
      textScale: largeText,
      surfaceSize: phone,
    );
    await scrollThrough(tester);
    expect(tester.takeException(), isNull);
  });

  testWidgets('readiness summary fits at 200% text', (tester) async {
    await pumpLemon(
      tester,
      backend: FakeBackend(),
      home: Scaffold(
        body: ReadinessView(
          readiness: const Readiness(
            ready: false,
            missing: [
              ReadinessRequirement.location,
              ReadinessRequirement.photos,
              ReadinessRequirement.promptAnswers,
            ],
          ),
          onCheckAgain: () {},
          onFix: (_) {},
        ),
      ),
      textScale: largeText,
      surfaceSize: phone,
    );
    await scrollThrough(tester);
    expect(tester.takeException(), isNull);
  });

  testWidgets('photo editor fits at 200% text', (tester) async {
    final backend = FakeBackend()
      ..seedPhoto()
      ..seedPhoto(state: 'processing');
    await pumpLemon(
      tester,
      backend: backend,
      home: const Scaffold(body: PhotoEditor()),
      textScale: largeText,
      surfaceSize: phone,
    );
    await scrollThrough(tester);
    expect(tester.takeException(), isNull);
  });

  testWidgets('You tab and preview fit at 200% text', (tester) async {
    await pumpLemon(
      tester,
      backend: readyBackend(),
      home: const AppShell(initialTab: LemonTab.you),
      textScale: largeText,
      surfaceSize: phone,
    );
    await tapVisible(tester, find.text('Preview your profile'));
    await scrollThrough(tester);
    await tester.pageBack();
    await tester.pumpAndSettle();
    await scrollThrough(tester);
    expect(tester.takeException(), isNull);
  });

  testWidgets('onboarding controls meet tap target and label guidelines', (
    tester,
  ) async {
    await pumpLemon(
      tester,
      backend: FakeBackend()
        ..completeBasics()
        ..preferences['acceptedGenderCategories'] = <String>[],
    );
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
    await expectLater(tester, meetsGuideline(textContrastGuideline));
  });
}
