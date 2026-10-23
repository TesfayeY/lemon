import 'package:flutter/material.dart';

/// Lemon App design tokens — colors.
///
/// Warm, calm palette inspired by Ethiopian and Eritrean communities.
/// Berry primary, ivory canvas, copper accents.
abstract final class LemonColors {
  // Canvas & Surface
  static const Color canvas = Color(0xFFFBF7F1); // Warm ivory background
  static const Color surface = Color(0xFFFFFFFF); // Cards, sheets, inputs

  // Text
  static const Color textPrimary = Color(0xFF251C19); // Headings and body
  static const Color textSecondary = Color(0xFF675A54); // Captions

  // Primary — Deep berry
  static const Color primary = Color(0xFF6F263D);
  static const Color primaryOnColor = Color(0xFFFFFFFF); // Button text on primary

  // Accent — Copper
  static const Color accent = Color(0xFFB98046); // Decorative detail
  static const Color softAccent = Color(0xFFEFE3D4); // Chips, prompt backgrounds

  // Semantic
  static const Color success = Color(0xFF24624D);
  static const Color error = Color(0xFFA52B35);

  // Misc
  static const Color divider = Color(0xFFE8E0D8);
  static const Color disabled = Color(0xFFBDB3AB);
  static const Color shimmer = Color(0xFFE8E0D8);
}
