import '../../../core/l10n/failure_messages.dart';
import '../../../core/l10n/l10n.dart';
import '../data/auth_failure.dart';
import '../domain/credentials.dart';

/// Localized copy for a sign-in failure. Wrong password and unknown email
/// share one message, so the app never reveals whether an account exists.
String authFailureMessage(AppLocalizations l10n, AuthErrorCode code) =>
    switch (code) {
      AuthErrorCode.invalidCredentials => l10n.authErrorInvalidCredentials,
      AuthErrorCode.invalidEmail => l10n.authEmailInvalid,
      AuthErrorCode.emailInUse => l10n.authErrorEmailInUse,
      AuthErrorCode.weakPassword => l10n.authErrorWeakPassword,
      AuthErrorCode.tooManyRequests => l10n.authErrorTooManyRequests,
      AuthErrorCode.network => l10n.errorOffline,
      AuthErrorCode.userDisabled => l10n.authErrorUserDisabled,
      AuthErrorCode.sessionExpired => l10n.authErrorSessionExpired,
      AuthErrorCode.notConfigured => l10n.authNotConfigured,
      AuthErrorCode.unknown => l10n.errorGeneric,
    };

/// Copy for any error thrown by a sign-in action or an API call.
String describeAuthError(AppLocalizations l10n, Object error) =>
    error is AuthFailure
    ? authFailureMessage(l10n, error.code)
    : describeFailure(l10n, error);

String passwordRequirementLabel(
  AppLocalizations l10n,
  PasswordPolicy policy,
  PasswordRequirement requirement,
) => switch (requirement) {
  PasswordRequirement.minLength => l10n.passwordRuleMinLength(policy.minLength),
  PasswordRequirement.maxLength => l10n.passwordRuleMaxLength(policy.maxLength),
  PasswordRequirement.lowercase => l10n.passwordRuleLowercase,
  PasswordRequirement.uppercase => l10n.passwordRuleUppercase,
  PasswordRequirement.numeric => l10n.passwordRuleNumeric,
  PasswordRequirement.nonAlphanumeric => l10n.passwordRuleSpecial,
};

/// Field error for an email address, or null when it looks valid.
String? emailError(AppLocalizations l10n, String value) {
  if (value.trim().isEmpty) return l10n.authEmailRequired;
  if (!looksLikeEmail(value)) return l10n.authEmailInvalid;
  return null;
}
