/// One rule of a [PasswordPolicy].
enum PasswordRequirement { minLength, maxLength, lowercase, uppercase, numeric, nonAlphanumeric }

/// Client copy of the Firebase Auth password policy, used for instant
/// feedback while typing. Firebase enforces the real policy on sign-up.
///
/// Character classes follow Firebase's definitions (ASCII letters and digits;
/// special characters from Firebase's allowed set). Keep [lemon] identical to
/// the policy configured in the Firebase console (Authentication → Settings →
/// Password policy); see `docs/features/auth-screens.md`.
class PasswordPolicy {
  const PasswordPolicy({
    this.minLength = 6,
    this.maxLength = 4096,
    this.requireLowercase = false,
    this.requireUppercase = false,
    this.requireNumeric = false,
    this.requireNonAlphanumeric = false,
  });

  /// The policy the Firebase project must enforce: at least 8 characters with
  /// a lowercase letter, an uppercase letter and a number.
  static const lemon = PasswordPolicy(
    minLength: 8,
    requireLowercase: true,
    requireUppercase: true,
    requireNumeric: true,
  );

  /// Firebase's allowed special characters.
  static const nonAlphanumericCharacters = r'''^$*.[]{}()?"!@#%&/\,><':;|_~`=+-''';

  final int minLength;
  final int maxLength;
  final bool requireLowercase;
  final bool requireUppercase;
  final bool requireNumeric;
  final bool requireNonAlphanumeric;

  /// The rules this policy enforces, in display order. [maxLength] is only
  /// listed once it is broken (see [unmet]).
  List<PasswordRequirement> get requirements => [
    PasswordRequirement.minLength,
    if (requireLowercase) PasswordRequirement.lowercase,
    if (requireUppercase) PasswordRequirement.uppercase,
    if (requireNumeric) PasswordRequirement.numeric,
    if (requireNonAlphanumeric) PasswordRequirement.nonAlphanumeric,
  ];

  bool isMet(PasswordRequirement requirement, String password) {
    final units = password.codeUnits;
    bool any(bool Function(int c) test) => units.any(test);
    return switch (requirement) {
      PasswordRequirement.minLength => password.length >= minLength,
      PasswordRequirement.maxLength => password.length <= maxLength,
      PasswordRequirement.lowercase => any((c) => c >= 0x61 && c <= 0x7A),
      PasswordRequirement.uppercase => any((c) => c >= 0x41 && c <= 0x5A),
      PasswordRequirement.numeric => any((c) => c >= 0x30 && c <= 0x39),
      PasswordRequirement.nonAlphanumeric => any(
        (c) => nonAlphanumericCharacters.codeUnits.contains(c),
      ),
    };
  }

  /// Rules [password] breaks, in display order.
  List<PasswordRequirement> unmet(String password) => [
    for (final r in requirements)
      if (!isMet(r, password)) r,
    if (!isMet(PasswordRequirement.maxLength, password))
      PasswordRequirement.maxLength,
  ];

  bool accepts(String password) => unmet(password).isEmpty;
}

/// A light shape check before asking Firebase. Firebase has the final word.
bool looksLikeEmail(String value) =>
    RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$').hasMatch(value.trim());
