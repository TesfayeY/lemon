/// Display name of the app (the `APP_NAME` constant in CLAUDE.md).
///
/// Branding is still a placeholder (P-01), so every user-facing reference goes
/// through this constant instead of a hardcoded name.
const String appName = String.fromEnvironment(
  'APP_NAME',
  defaultValue: 'Lemon',
);

/// Build-time configuration, read from `--dart-define` values.
class AppConfig {
  const AppConfig({
    required this.apiBaseUrl,
    this.showSensitiveFields = false,
  });

  factory AppConfig.fromEnvironment() => AppConfig(
    apiBaseUrl: Uri.parse(
      const String.fromEnvironment(
        'LEMON_API_BASE_URL',
        defaultValue: 'http://localhost:3000',
      ),
    ),
    showSensitiveFields: const bool.fromEnvironment(
      'LEMON_SHOW_SENSITIVE_FIELDS',
    ),
  );

  /// Express API origin. Android emulators reach the host at `10.0.2.2`.
  final Uri apiBaseUrl;

  /// Product decision P-03 (which sensitive fields ship at launch) is open.
  ///
  /// Every sensitive optional field (today: religion) is built behind this one
  /// flag and stays hidden unless it is explicitly enabled.
  final bool showSensitiveFields;
}
