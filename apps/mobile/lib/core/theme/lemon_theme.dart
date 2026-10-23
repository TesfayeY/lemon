import 'package:flutter/material.dart';
import 'lemon_colors.dart';
import 'lemon_spacing.dart';
import 'lemon_typography.dart';

/// Builds the Lemon app ThemeData from design tokens.
ThemeData buildLemonTheme() {
  return ThemeData(
    useMaterial3: true,
    brightness: Brightness.light,
    scaffoldBackgroundColor: LemonColors.canvas,
    colorScheme: const ColorScheme.light(
      primary: LemonColors.primary,
      onPrimary: LemonColors.primaryOnColor,
      secondary: LemonColors.accent,
      surface: LemonColors.surface,
      error: LemonColors.error,
    ),
    textTheme: TextTheme(
      displayLarge: LemonTypography.display,
      titleLarge: LemonTypography.title,
      titleMedium: LemonTypography.section,
      bodyLarge: LemonTypography.body,
      bodyMedium: LemonTypography.body,
      bodySmall: LemonTypography.caption,
    ),
    appBarTheme: const AppBarTheme(
      backgroundColor: LemonColors.canvas,
      foregroundColor: LemonColors.textPrimary,
      elevation: 0,
      centerTitle: false,
      titleTextStyle: LemonTypography.section,
    ),
    cardTheme: CardThemeData(
      color: LemonColors.surface,
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(LemonRadius.card),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: LemonColors.surface,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(LemonRadius.input),
        borderSide: const BorderSide(color: LemonColors.divider),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(LemonRadius.input),
        borderSide: const BorderSide(color: LemonColors.divider),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(LemonRadius.input),
        borderSide: const BorderSide(color: LemonColors.primary, width: 2),
      ),
      errorBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(LemonRadius.input),
        borderSide: const BorderSide(color: LemonColors.error),
      ),
      contentPadding: const EdgeInsets.symmetric(
        horizontal: LemonSpacing.base,
        vertical: LemonSpacing.md,
      ),
    ),
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        backgroundColor: LemonColors.primary,
        foregroundColor: LemonColors.primaryOnColor,
        minimumSize: const Size(double.infinity, LemonSize.touchTarget),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(LemonRadius.input),
        ),
        textStyle: LemonTypography.body.copyWith(fontWeight: FontWeight.w600),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: LemonColors.primary,
        minimumSize: const Size(double.infinity, LemonSize.touchTarget),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(LemonRadius.input),
        ),
        side: const BorderSide(color: LemonColors.primary),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        foregroundColor: LemonColors.primary,
        minimumSize: const Size(LemonSize.touchTarget, LemonSize.touchTarget),
      ),
    ),
    bottomNavigationBarTheme: const BottomNavigationBarThemeData(
      backgroundColor: LemonColors.surface,
      selectedItemColor: LemonColors.primary,
      unselectedItemColor: LemonColors.textSecondary,
      type: BottomNavigationBarType.fixed,
      showUnselectedLabels: true,
    ),
    dividerTheme: const DividerThemeData(
      color: LemonColors.divider,
      thickness: 1,
      space: 0,
    ),
    pageTransitionsTheme: PageTransitionsTheme(
      builders: {
        TargetPlatform.iOS: const FadeForwardsPageTransitionsBuilder(),
        TargetPlatform.android: const FadeForwardsPageTransitionsBuilder(),
      },
    ),
  );
}
