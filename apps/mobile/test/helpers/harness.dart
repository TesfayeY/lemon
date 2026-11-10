import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lemon/app/app.dart';
import 'package:lemon/app/config.dart';
import 'package:lemon/app/providers.dart';
import 'package:lemon/core/api/id_token_source.dart';
import 'package:lemon/core/api/lemon_api_client.dart';
import 'package:lemon/features/profile/data/photo_picker.dart';

import 'fake_backend.dart';

/// A 1x1 transparent PNG, standing in for every media image in tests.
final Uint8List transparentPng = Uint8List.fromList(const [
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, //
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00,
  0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
]);

/// Returns queued photos, or null (cancelled) when the queue is empty.
class FakePhotoPicker implements PhotoPicker {
  final queue = <PickedPhoto>[];

  void add([String name = 'photo.jpg']) =>
      queue.add(PickedPhoto(bytes: transparentPng, filename: name));

  @override
  Future<PickedPhoto?> pick() async =>
      queue.isEmpty ? null : queue.removeAt(0);
}

/// Fixed "today" for date rules: 10 November 2026.
DateTime fixedToday() => DateTime(2026, 11, 10);

LemonApiClient apiFor(FakeBackend backend) => LemonApiClient(
  baseUrl: Uri.parse('http://lemon.test'),
  tokens: const StaticIdTokenSource('test-token'),
  httpClient: backend.client,
);

/// Pumps the app (or [home]) against [backend] with test doubles.
Future<void> pumpLemon(
  WidgetTester tester, {
  required FakeBackend backend,
  Widget? home,
  FakePhotoPicker? picker,
  bool showSensitiveFields = false,
  double textScale = 1,
  Size? surfaceSize,
}) async {
  if (surfaceSize != null) {
    await tester.binding.setSurfaceSize(surfaceSize);
    addTearDown(() => tester.binding.setSurfaceSize(null));
  }
  if (textScale != 1) {
    tester.platformDispatcher.textScaleFactorTestValue = textScale;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
  }
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        appConfigProvider.overrideWithValue(
          AppConfig(
            apiBaseUrl: Uri.parse('http://lemon.test'),
            showSensitiveFields: showSensitiveFields,
          ),
        ),
        idTokenSourceProvider.overrideWithValue(
          const StaticIdTokenSource('test-token'),
        ),
        apiClientProvider.overrideWithValue(apiFor(backend)),
        photoPickerProvider.overrideWithValue(picker ?? FakePhotoPicker()),
        mediaImageLoaderProvider.overrideWithValue(
          (path) async => MemoryImage(transparentPng),
        ),
        clockProvider.overrideWithValue(fixedToday),
      ],
      child: LemonApp(home: home),
    ),
  );
  await tester.pumpAndSettle();
}

/// Scrolls the page's list (not a text field's internal scrollable) until
/// [finder] is built and visible.
Future<void> scrollToVisible(WidgetTester tester, Finder finder) =>
    tester.scrollUntilVisible(
      finder,
      200,
      scrollable: find
          .descendant(
            of: find.byType(ListView).last,
            matching: find.byType(Scrollable),
          )
          .first,
    );

/// Scrolls until [finder] is visible, then taps it. Pass [settle] false when
/// something keeps animating afterwards (e.g. a button spinner behind a
/// dialog).
Future<void> tapVisible(
  WidgetTester tester,
  Finder finder, {
  bool settle = true,
}) async {
  await scrollToVisible(tester, finder);
  await tester.pump();
  await tester.tap(finder);
  if (settle) {
    await tester.pumpAndSettle();
  } else {
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
  }
}
