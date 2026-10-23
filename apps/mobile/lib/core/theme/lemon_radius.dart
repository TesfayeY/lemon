import 'package:flutter/material.dart';

/// Border radius tokens.
abstract final class LemonRadius {
  static const double input = 12;
  static const double card = 20;
  static const double sheet = 28;

  static final inputBorder = BorderRadius.circular(input);
  static final cardBorder = BorderRadius.circular(card);
  static final sheetBorder = BorderRadius.circular(sheet);
}
