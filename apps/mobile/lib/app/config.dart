import 'package:flutter/foundation.dart';

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
  const AppConfig({required this.apiBaseUrl, this.showSensitiveFields = false});

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
  ///
  /// The default (`http://localhost:3000`) is for local development only;
  /// release builds must pass an `https` URL (see [validate]).
  final Uri apiBaseUrl;

  /// Why [url] can't be the API origin for this kind of build, or null if it
  /// can.
  ///
  /// Every request carries the person's Firebase ID token, so release builds
  /// must reach the API over HTTPS. Plain HTTP is only for local development.
  static String? apiBaseUrlProblem(Uri url, {required bool release}) {
    if (url.scheme != 'https' && url.scheme != 'http') {
      return 'LEMON_API_BASE_URL must be an http or https URL';
    }
    if (url.host.isEmpty) return 'LEMON_API_BASE_URL must include a host';
    if (release && url.scheme != 'https') {
      return 'LEMON_API_BASE_URL must use https in release builds';
    }
    return null;
  }

  /// Throws a [StateError] when this configuration can't be used safely, so a
  /// misconfigured release build fails at launch instead of sending sign-in
  /// tokens over plain HTTP.
  void validate({bool release = kReleaseMode}) {
    final problem = apiBaseUrlProblem(apiBaseUrl, release: release);
    if (problem != null) throw StateError(problem);
  }

  /// Product decision P-03 (which sensitive fields ship at launch) is open.
  ///
  /// Every sensitive optional field (today: religion) is built behind this one
  /// flag and stays hidden unless it is explicitly enabled.
  final bool showSensitiveFields;
}
