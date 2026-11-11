import 'package:characters/characters.dart';

/// Client-side checks that mirror the server's limits so people get instant
/// feedback. The server re-validates everything and has the final say.
abstract final class ProfileLimits {
  static const displayNameMax = 40;
  static const promptAnswerMax = 300;
  static const bioMax = 500;
  static const optionalTextMax = 100;
  static const minAge = 18;
  static const maxAge = 99;
  static const minHeightCm = 100;
  static const maxHeightCm = 250;
  static const promptAnswersRequired = 3;
  static const minPhotos = 3;
  static const maxPhotos = 6;
}

/// Collapses runs of whitespace and trims, like the server does before saving.
String normalizeWhitespace(String value) =>
    value.replaceAll(RegExp(r'\s+'), ' ').trim();

/// Length in user-perceived characters, so Ethiopic and emoji count as one.
int graphemeLength(String value) => value.characters.length;

enum TextError { required, tooLong }

/// Validates required text such as a display name or prompt answer.
TextError? validateRequiredText(String raw, {required int max}) {
  final normalized = normalizeWhitespace(raw);
  if (normalized.isEmpty) return TextError.required;
  if (graphemeLength(normalized) > max) return TextError.tooLong;
  return null;
}

/// Validates optional text; empty is fine.
TextError? validateOptionalText(String raw, {required int max}) {
  if (graphemeLength(normalizeWhitespace(raw)) > max) return TextError.tooLong;
  return null;
}

/// Empty optional text is stored as null.
String? optionalTextValue(String raw) {
  final normalized = normalizeWhitespace(raw);
  return normalized.isEmpty ? null : normalized;
}

/// Formats centimeters as feet and inches for US display, e.g. `5′ 5″`.
({int feet, int inches}) feetAndInches(int centimeters) {
  final totalInches = (centimeters / 2.54).round();
  return (feet: totalInches ~/ 12, inches: totalInches % 12);
}
