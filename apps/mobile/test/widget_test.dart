import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lemon/app/app.dart';
import 'package:lemon/core/widgets/lemon_button.dart';
import 'package:lemon/core/widgets/lemon_text_field.dart';
import 'package:lemon/core/widgets/lemon_card.dart';
import 'package:lemon/core/widgets/prompt_tile.dart';
import 'package:lemon/core/widgets/state_views.dart';
import 'package:lemon/core/widgets/bottom_nav.dart';
import 'package:lemon/core/theme/lemon_colors.dart';
import 'package:lemon/core/theme/lemon_theme.dart';

Widget wrapWithTheme(Widget child) {
  return MaterialApp(
    theme: buildLemonTheme(),
    home: Scaffold(body: child),
  );
}

void main() {
  group('LemonApp', () {
    testWidgets('renders with navigation bar', (tester) async {
      await tester.pumpWidget(const LemonApp());
      expect(find.text('Discover'), findsWidgets);
      expect(find.text('Likes'), findsWidgets);
      expect(find.text('Chats'), findsWidgets);
      expect(find.text('You'), findsWidgets);
    });

    testWidgets('switches tabs on navigation tap', (tester) async {
      await tester.pumpWidget(const LemonApp());

      // Tap Likes tab
      await tester.tap(find.text('Likes').last);
      await tester.pump();
      expect(find.text('Likes will be available soon.'), findsOneWidget);

      // Tap Chats tab
      await tester.tap(find.text('Chats').last);
      await tester.pump();
      expect(find.text('Chats will be available soon.'), findsOneWidget);
    });
  });

  group('LemonButton', () {
    testWidgets('renders label and responds to tap', (tester) async {
      var tapped = false;
      await tester.pumpWidget(wrapWithTheme(
        LemonButton(label: 'Sign up', onPressed: () => tapped = true),
      ));

      expect(find.text('Sign up'), findsOneWidget);
      await tester.tap(find.text('Sign up'));
      expect(tapped, isTrue);
    });

    testWidgets('shows loading indicator and disables tap', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        LemonButton(
          label: 'Sign up',
          onPressed: () {},
          isLoading: true,
        ),
      ));

      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(find.text('Sign up'), findsNothing);
      // Button should be disabled during loading
      final button = tester.widget<ElevatedButton>(find.byType(ElevatedButton));
      expect(button.onPressed, isNull);
    });

    testWidgets('disabled when onPressed is null', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        const LemonButton(label: 'Next', onPressed: null),
      ));

      final button = tester.widget<ElevatedButton>(find.byType(ElevatedButton));
      expect(button.onPressed, isNull);
    });

    testWidgets('renders outlined variant', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        LemonButton(label: 'Cancel', onPressed: () {}, isOutlined: true),
      ));

      expect(find.byType(OutlinedButton), findsOneWidget);
    });
  });

  group('LemonTextField', () {
    testWidgets('renders label', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        const LemonTextField(label: 'Email'),
      ));

      expect(find.text('Email'), findsOneWidget);
    });

    testWidgets('shows error text', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        const LemonTextField(label: 'Email', errorText: 'Required'),
      ));

      expect(find.text('Required'), findsOneWidget);
    });

    testWidgets('toggles password visibility', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        const LemonTextField(label: 'Password', obscureText: true),
      ));

      // Should show visibility toggle
      expect(find.byIcon(Icons.visibility_off), findsOneWidget);

      // Tap to show password
      await tester.tap(find.byIcon(Icons.visibility_off));
      await tester.pump();
      expect(find.byIcon(Icons.visibility), findsOneWidget);
    });
  });

  group('LemonCard', () {
    testWidgets('renders child content', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        const LemonCard(child: Text('Card content')),
      ));

      expect(find.text('Card content'), findsOneWidget);
    });
  });

  group('PromptTile', () {
    testWidgets('shows question and answer', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        const PromptTile(
          question: 'A tradition I would love to share...',
          answer: 'Ethiopian coffee ceremony',
        ),
      ));

      expect(find.text('A tradition I would love to share...'), findsOneWidget);
      expect(find.text('Ethiopian coffee ceremony'), findsOneWidget);
    });

    testWidgets('shows like button when enabled', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        PromptTile(
          question: 'Q',
          answer: 'A',
          onLike: () {},
        ),
      ));

      expect(find.byIcon(Icons.favorite_border), findsOneWidget);
    });

    testWidgets('hides like button when disabled', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        const PromptTile(
          question: 'Q',
          answer: 'A',
          showLike: false,
        ),
      ));

      expect(find.byIcon(Icons.favorite_border), findsNothing);
    });
  });

  group('State views', () {
    testWidgets('LemonLoadingView shows spinner', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        const LemonLoadingView(message: 'Loading...'),
      ));

      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(find.text('Loading...'), findsOneWidget);
    });

    testWidgets('LemonEmptyView shows message and action', (tester) async {
      var tapped = false;
      await tester.pumpWidget(wrapWithTheme(
        LemonEmptyView(
          message: 'No results',
          actionLabel: 'Retry',
          onAction: () => tapped = true,
          icon: Icons.search_off,
        ),
      ));

      expect(find.text('No results'), findsOneWidget);
      await tester.tap(find.text('Retry'));
      expect(tapped, isTrue);
    });

    testWidgets('LemonErrorView shows error and retry', (tester) async {
      var retried = false;
      await tester.pumpWidget(wrapWithTheme(
        LemonErrorView(
          message: 'Something went wrong',
          onRetry: () => retried = true,
        ),
      ));

      expect(find.text('Something went wrong'), findsOneWidget);
      await tester.tap(find.text('Try again'));
      expect(retried, isTrue);
    });
  });

  group('LemonBottomNav', () {
    testWidgets('renders all four tabs', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        LemonBottomNav(
          currentTab: LemonTab.discover,
          onTabSelected: (_) {},
        ),
      ));

      for (final tab in LemonTab.values) {
        expect(find.text(tab.label), findsOneWidget);
      }
    });

    testWidgets('calls onTabSelected when tapped', (tester) async {
      LemonTab? selected;
      await tester.pumpWidget(wrapWithTheme(
        LemonBottomNav(
          currentTab: LemonTab.discover,
          onTabSelected: (tab) => selected = tab,
        ),
      ));

      await tester.tap(find.text('Chats'));
      expect(selected, LemonTab.chats);
    });

    testWidgets('shows badge count', (tester) async {
      await tester.pumpWidget(wrapWithTheme(
        LemonBottomNav(
          currentTab: LemonTab.discover,
          onTabSelected: (_) {},
          badges: const {LemonTab.likes: 3},
        ),
      ));

      expect(find.text('3'), findsWidgets);
    });
  });

  group('Theme', () {
    testWidgets('uses Lemon primary color', (tester) async {
      await tester.pumpWidget(const LemonApp());
      // Access theme from a descendant widget inside MaterialApp
      final context = tester.element(find.byType(Scaffold).first);
      final theme = Theme.of(context);
      expect(theme.colorScheme.primary, equals(LemonColors.primary));
    });

    testWidgets('uses warm ivory scaffold background', (tester) async {
      await tester.pumpWidget(const LemonApp());
      final context = tester.element(find.byType(Scaffold).first);
      final theme = Theme.of(context);
      expect(theme.scaffoldBackgroundColor, equals(LemonColors.canvas));
    });
  });
}
