import 'package:flutter/material.dart';

import '../core/l10n/l10n.dart';
import '../core/theme/lemon_theme.dart';
import '../features/auth/ui/auth_gate.dart';
import 'config.dart';

/// Root application widget. Expects a `ProviderScope` above it.
class LemonApp extends StatelessWidget {
  const LemonApp({super.key, this.home});

  /// Overrides the start screen (tests and previews); defaults to [AuthGate].
  final Widget? home;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      onGenerateTitle: (_) => appName,
      theme: buildLemonTheme(),
      debugShowCheckedModeBanner: false,
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: home ?? const AuthGate(),
    );
  }
}
