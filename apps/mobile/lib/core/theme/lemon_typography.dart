import 'package:flutter/material.dart';
import 'lemon_colors.dart';

/// Lemon App design tokens — typography.
///
/// Uses system fonts for now. A bundled licensed typeface with Ethiopic
/// script coverage will be added before launch.
abstract final class LemonTypography {
  static const TextStyle display = TextStyle(
    fontSize: 32,
    fontWeight: FontWeight.w700,
    color: LemonColors.textPrimary,
    height: 1.2,
  );

  static const TextStyle title = TextStyle(
    fontSize: 26,
    fontWeight: FontWeight.w600,
    color: LemonColors.textPrimary,
    height: 1.25,
  );

  static const TextStyle section = TextStyle(
    fontSize: 20,
    fontWeight: FontWeight.w600,
    color: LemonColors.textPrimary,
    height: 1.3,
  );

  static const TextStyle body = TextStyle(
    fontSize: 16,
    fontWeight: FontWeight.w400,
    color: LemonColors.textPrimary,
    height: 1.5,
  );

  static const TextStyle caption = TextStyle(
    fontSize: 14,
    fontWeight: FontWeight.w400,
    color: LemonColors.textSecondary,
    height: 1.4,
  );
}
