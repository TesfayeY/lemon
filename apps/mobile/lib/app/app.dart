import 'package:flutter/material.dart';
import '../core/theme/lemon_theme.dart';
import 'shell.dart';

/// Root application widget.
class LemonApp extends StatelessWidget {
  const LemonApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Lemon',
      theme: buildLemonTheme(),
      debugShowCheckedModeBanner: false,
      home: const AppShell(),
    );
  }
}
