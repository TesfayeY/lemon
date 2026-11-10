import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lemon/features/profile/data/profile.dart';
import 'package:lemon/features/profile/ui/photo_editor.dart';
import 'package:lemon/features/profile/ui/prompt_editor.dart';

import '../../helpers/fake_backend.dart';
import '../../helpers/harness.dart';
import '../../helpers/journey.dart';

Widget photoScreen({VoidCallback? onContinue}) =>
    Scaffold(body: PhotoEditor(onContinue: onContinue));

Widget promptScreen({VoidCallback? onContinue}) =>
    Scaffold(body: PromptEditor(onContinue: onContinue));

Future<void> openPhotoOptions(WidgetTester tester, int position) async {
  await tester.tap(find.byTooltip('Options for photo $position'));
  await tester.pumpAndSettle();
}

void main() {
  group('photo editor', () {
    testWidgets('shows each review state with a label, not color alone', (
      tester,
    ) async {
      final backend = FakeBackend()
        ..seedPhoto()
        ..seedPhoto(state: 'pending')
        ..seedPhoto(state: 'processing');
      await pumpLemon(tester, backend: backend, home: photoScreen());

      expect(find.text('3 of 6 photos'), findsOneWidget);
      expect(find.text('Approved'), findsOneWidget);
      expect(find.text('In review'), findsOneWidget);
      expect(find.text('Processing'), findsOneWidget);
      expect(find.text("Photos in review aren't shown to anyone yet."), findsOneWidget);
    });

    testWidgets('a rejected photo shows a respectful reason and can be '
        'replaced', (tester) async {
      final backend = FakeBackend()
        ..seedPhoto()
        ..seedPhoto()
        ..seedPhoto(
          state: 'rejected',
          rejection: {'code': 'face_not_clear', 'message': 'English default'},
        );
      final picker = FakePhotoPicker();
      await pumpLemon(tester, backend: backend, home: photoScreen(), picker: picker);

      expect(find.text('Needs a new photo'), findsOneWidget);
      expect(find.text('Not approved'), findsOneWidget);
      expect(
        find.text("We couldn't see your face clearly in this photo."),
        findsOneWidget,
      );
      expect(find.text('English default'), findsNothing);

      picker.add();
      await tapVisible(tester, find.text('Replace photo'));

      expect(backend.sent('POST', '/v1/me/photos'), hasLength(1));
      expect(backend.sent('DELETE', '/v1/me/photos/photo-3'), hasLength(1));
      expect(find.text('Needs a new photo'), findsNothing);
      expect(find.text('In review'), findsOneWidget);
    });

    testWidgets('upload sends an idempotency key and shows the photo as in '
        'review', (tester) async {
      final backend = FakeBackend();
      final picker = FakePhotoPicker()..add();
      await pumpLemon(tester, backend: backend, home: photoScreen(), picker: picker);

      await tapVisible(tester, find.byIcon(Icons.add_a_photo_outlined));

      final upload = backend.sent('POST', '/v1/me/photos').single;
      expect(upload.headers['idempotency-key'], matches(RegExp(r'^[A-Za-z0-9]{32}$')));
      expect(find.text('In review'), findsOneWidget);
      expect(find.text('1 of 6 photos'), findsOneWidget);
    });

    testWidgets('a failed upload says so and retries with the same key', (
      tester,
    ) async {
      final backend = FakeBackend()..offline = true;
      final picker = FakePhotoPicker()..add();
      await pumpLemon(tester, backend: backend, home: photoScreen(), picker: picker);
      // The photo list loaded before the connection dropped
      expect(find.textContaining('You are offline'), findsOneWidget);
      backend.offline = false;
      await tester.tap(find.text('Try again'));
      await tester.pumpAndSettle();

      backend.offline = true;
      await tapVisible(tester, find.byIcon(Icons.add_a_photo_outlined));
      expect(
        find.text('This photo did not finish uploading. Try again.'),
        findsOneWidget,
      );

      backend.offline = false;
      await tapVisible(tester, find.widgetWithText(TextButton, 'Try again'));
      final keys = backend.requests
          .where((r) => r.method == 'POST' && r.path == '/v1/me/photos')
          .map((r) => r.headers['idempotency-key'])
          .toSet();
      expect(keys, hasLength(1));
      expect(backend.photos, hasLength(1));
      expect(find.text('In review'), findsOneWidget);
    });

    testWidgets('an unsupported format explains which formats work', (
      tester,
    ) async {
      final backend = FakeBackend()
        ..failNext(
          'POST',
          '/v1/me/photos',
          status: 415,
          error: {
            'code': 'UNSUPPORTED_MEDIA_TYPE',
            'message': 'HEIC photos are not supported yet.',
            'detectedFormat': 'heic',
            'acceptedFormats': ['jpeg', 'png', 'webp'],
            'retryable': false,
          },
        );
      final picker = FakePhotoPicker()..add('IMG_0001.HEIC');
      await pumpLemon(tester, backend: backend, home: photoScreen(), picker: picker);

      await tapVisible(tester, find.byIcon(Icons.add_a_photo_outlined));
      expect(
        find.text(
          "This type of photo isn't supported yet. Choose a JPEG, PNG or WebP "
          'photo.',
        ),
        findsOneWidget,
      );
      expect(find.text('0 of 6 photos'), findsOneWidget);
    });

    testWidgets('reorder sends the full order with the photo-set revision', (
      tester,
    ) async {
      final backend = FakeBackend()
        ..seedPhoto()
        ..seedPhoto()
        ..seedPhoto(state: 'pending');
      await pumpLemon(tester, backend: backend, home: photoScreen());

      await openPhotoOptions(tester, 2);
      await tester.tap(find.text('Move earlier'));
      await tester.pumpAndSettle();

      expect(backend.sent('PATCH', '/v1/me/photos/order').single.body, {
        'expectedRevision': 4,
        'photoIds': ['photo-2', 'photo-1', 'photo-3'],
      });
    });

    testWidgets('a stale reorder refreshes and tells the person', (tester) async {
      final backend = FakeBackend()
        ..seedPhoto()
        ..seedPhoto();
      await pumpLemon(tester, backend: backend, home: photoScreen());
      backend.photoRevision = 10; // another device changed the set

      await openPhotoOptions(tester, 1);
      await tester.tap(find.text('Move later'));
      await tester.pumpAndSettle();

      expect(
        find.text('We loaded the latest version of your profile.'),
        findsOneWidget,
      );
      expect(backend.photos.first['id'], 'photo-1');
    });

    testWidgets('removing an approved photo at the minimum warns that the '
        'profile will be hidden', (tester) async {
      final backend = FakeBackend()
        ..seedPhoto()
        ..seedPhoto()
        ..seedPhoto();
      await pumpLemon(tester, backend: backend, home: photoScreen());

      await openPhotoOptions(tester, 1);
      await tester.tap(find.text('Remove photo'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Your profile needs 3 approved photos'), findsOneWidget);

      await tester.tap(find.widgetWithText(TextButton, 'Remove photo'));
      await tester.pumpAndSettle();
      expect(backend.sent('DELETE', '/v1/me/photos/photo-1'), hasLength(1));
      expect(find.text('2 of 6 photos'), findsOneWidget);
    });

    testWidgets('continue needs at least three photos', (tester) async {
      var continued = false;
      final backend = FakeBackend()
        ..seedPhoto(state: 'pending')
        ..seedPhoto(state: 'pending');
      final picker = FakePhotoPicker();
      await pumpLemon(
        tester,
        backend: backend,
        home: photoScreen(onContinue: () => continued = true),
        picker: picker,
      );

      expect(find.text('Add at least 3 photos to continue.'), findsOneWidget);
      final button = find.widgetWithText(ElevatedButton, 'Continue');
      await scrollToVisible(tester, button);
      expect(tester.widget<ElevatedButton>(button).onPressed, isNull);

      picker.add();
      await tapVisible(tester, find.byIcon(Icons.add_a_photo_outlined));
      await tapVisible(tester, button);
      expect(continued, isTrue);
    });
  });

  group('prompt editor', () {
    testWidgets('shows approved, pending and rejected answers with the right '
        'copy and actions', (tester) async {
      final backend = FakeBackend()
        ..seedPrompt('prompt-tradition', approvedText: 'Coffee with my aunts.')
        ..seedPrompt(
          'prompt-sunday',
          approvedText: 'A long walk by the lake.',
          pendingText: 'A long walk, then injera at home.',
          state: 'pending',
          revision: 2,
        )
        ..seedPrompt(
          'prompt-home',
          pendingText: 'Something the reviewer declined.',
          state: 'rejected',
        );
      await pumpLemon(tester, backend: backend, home: promptScreen());

      expect(find.text('Approved'), findsOneWidget);
      expect(find.text('Coffee with my aunts.'), findsOneWidget);

      // Edit awaiting review: published text stays and is explained
      expect(find.text('In review'), findsOneWidget);
      expect(find.text('A long walk by the lake.'), findsOneWidget);
      expect(find.text('A long walk, then injera at home.'), findsOneWidget);
      expect(
        find.text(
          'Your current answer stays on your profile until the new one is '
          'reviewed.',
        ),
        findsOneWidget,
      );

      await scrollToVisible(tester, find.text('Not approved'));
      expect(
        find.text(
          "This answer doesn't fit our community guidelines. Please write a new "
          'one.',
        ),
        findsOneWidget,
      );
      expect(find.text('Something the reviewer declined.'), findsNothing);
      expect(find.text('Write a new answer'), findsOneWidget);
      // A rejected first answer does not count toward the three
      expect(find.text('2 of 3 answered', skipOffstage: false), findsOneWidget);
    });

    testWidgets('replacing a rejected answer patches it with its revision', (
      tester,
    ) async {
      final backend = FakeBackend()
        ..seedPrompt(
          'prompt-home',
          pendingText: 'Declined text.',
          state: 'rejected',
          revision: 3,
        );
      await pumpLemon(tester, backend: backend, home: promptScreen());

      await tapText(tester, 'Write a new answer');
      expect(find.widgetWithText(TextField, 'Declined text.'), findsNothing);
      await tester.enterText(
        find.widgetWithText(TextField, 'Your answer'),
        'My grandmother\'s kitchen in the morning.',
      );
      await tapVisible(tester, find.widgetWithText(ElevatedButton, 'Submit for review'));

      expect(backend.sent('PATCH', '/v1/me/prompts/answer-1').single.body, {
        'expectedRevision': 3,
        'text': 'My grandmother\'s kitchen in the morning.',
      });
      expect(find.text('In review'), findsOneWidget);
    });

    testWidgets('the picker leaves out prompts already answered', (tester) async {
      final backend = FakeBackend()
        ..seedPrompt('prompt-tradition', approvedText: 'Coffee.');
      await pumpLemon(tester, backend: backend, home: promptScreen());

      await tapVisible(tester, find.widgetWithText(OutlinedButton, 'Choose a prompt'));
      expect(find.text('My ideal Sunday looks like…'), findsOneWidget);
      expect(find.text('A tradition I would love to share with you…'), findsNothing);

      await tester.tap(find.widgetWithText(ChoiceChip, 'Dating'));
      await tester.pumpAndSettle();
      expect(find.text('A first date I would enjoy…'), findsOneWidget);
      expect(find.text('My ideal Sunday looks like…'), findsNothing);
    });

    testWidgets('a duplicate prompt from another device is explained', (
      tester,
    ) async {
      final backend = FakeBackend()
        ..failNext(
          'POST',
          '/v1/me/prompts',
          status: 409,
          error: {
            'code': 'DUPLICATE_PROMPT',
            'message': 'You already answered this prompt',
            'retryable': false,
          },
        );
      await pumpLemon(tester, backend: backend, home: promptScreen());

      await tapVisible(tester, find.widgetWithText(OutlinedButton, 'Choose a prompt'));
      await tapText(tester, 'My ideal Sunday looks like…');
      await tester.enterText(find.widgetWithText(TextField, 'Your answer'), 'Church, then brunch.');
      await tapVisible(tester, find.widgetWithText(ElevatedButton, 'Submit for review'));

      expect(
        find.text('You already answered this prompt. Choose a different one.'),
        findsOneWidget,
      );
    });

    testWidgets('an empty answer is not submitted', (tester) async {
      final backend = FakeBackend();
      await pumpLemon(tester, backend: backend, home: promptScreen());

      await tapVisible(tester, find.widgetWithText(OutlinedButton, 'Choose a prompt'));
      await tapText(tester, 'My ideal Sunday looks like…');
      await tester.enterText(find.widgetWithText(TextField, 'Your answer'), '   ');
      await tapVisible(tester, find.widgetWithText(ElevatedButton, 'Submit for review'));

      expect(find.text('Write an answer.'), findsOneWidget);
      expect(backend.sent('POST', '/v1/me/prompts'), isEmpty);
    });

    testWidgets('removing an answer asks first', (tester) async {
      final backend = FakeBackend()
        ..seedPrompt('prompt-tradition', approvedText: 'Coffee.');
      await pumpLemon(tester, backend: backend, home: promptScreen());

      await tapText(tester, 'Remove answer');
      expect(find.text('Remove this answer?'), findsOneWidget);
      await tester.tap(find.widgetWithText(TextButton, 'Remove answer').last);
      await tester.pumpAndSettle();
      expect(backend.prompts, isEmpty);
    });

    test('only answers with published or pending text count', () {
      SelfPromptAnswer answer({String? approved, required ReviewState state}) =>
          SelfPromptAnswer(
            id: 'a',
            promptId: 'p',
            promptText: 'q',
            approvedText: approved,
            pendingText: 'text',
            state: state,
            revision: 1,
          );
      expect(answerCounts(answer(state: ReviewState.pending)), isTrue);
      expect(answerCounts(answer(state: ReviewState.rejected)), isFalse);
      // A declined edit leaves the published answer in place
      expect(
        answerCounts(answer(approved: 'Published.', state: ReviewState.rejected)),
        isTrue,
      );
    });
  });
}
