import 'dart:convert';
import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lemon/core/l10n/l10n.dart';

final Map<String, dynamic> arb =
    jsonDecode(File('lib/l10n/app_en.arb').readAsStringSync())
        as Map<String, dynamic>;

Iterable<File> sourceFiles() => Directory('lib')
    .listSync(recursive: true)
    .whereType<File>()
    .where((f) => f.path.endsWith('.dart'))
    .where((f) => !f.path.contains('/l10n/generated/'));

void main() {
  test('English is the only launch locale', () {
    expect(AppLocalizations.supportedLocales, [const Locale('en')]);
  });

  test('every message is non-empty and declares its placeholders', () {
    final messages = arb.entries.where((e) => !e.key.startsWith('@'));
    expect(messages, isNotEmpty);
    for (final entry in messages) {
      final value = entry.value as String;
      expect(value.trim(), isNotEmpty, reason: entry.key);
      final placeholders = RegExp(
        r'\{(\w+)\}',
      ).allMatches(value).map((m) => m.group(1)).toSet();
      if (placeholders.isEmpty) continue;
      final meta = arb['@${entry.key}'] as Map<String, dynamic>?;
      final declared =
          (meta?['placeholders'] as Map<String, dynamic>? ?? const {}).keys
              .toSet();
      expect(declared, placeholders, reason: entry.key);
    }
  });

  test('every key used in code exists in the ARB file', () {
    final used = <String>{};
    final pattern = RegExp(r'\bl10n\.(\w+)');
    for (final file in sourceFiles()) {
      for (final line in file.readAsLinesSync()) {
        if (line.startsWith('import ') || line.startsWith('export ')) continue;
        for (final m in pattern.allMatches(line)) {
          used.add(m.group(1)!);
        }
      }
    }
    expect(used.difference(arb.keys.toSet()), isEmpty);
  });

  test('no user-facing string literals in widgets', () {
    final literal = RegExp(
      r'''(Text\(\s*['"]|(label|labelText|helperText|hintText|tooltip|semanticLabel|semanticsLabel|message|title|subtitle):\s*['"])''',
    );
    final offenders = <String>[];
    for (final file in sourceFiles()) {
      final lines = file.readAsLinesSync();
      for (var i = 0; i < lines.length; i++) {
        if (literal.hasMatch(lines[i])) offenders.add('${file.path}:${i + 1}');
      }
    }
    expect(offenders, isEmpty);
  });

  test('the brand name comes only from the APP_NAME constant', () {
    final offenders = [
      for (final file in sourceFiles())
        if (file.path != 'lib/app/config.dart' &&
            RegExp(r'''['"][^'"\n]*\bLemon\b''').hasMatch(file.readAsStringSync()))
          file.path,
    ];
    expect(offenders, isEmpty);
    for (final entry in arb.entries.where((e) => !e.key.startsWith('@'))) {
      expect(
        (entry.value as String).contains('Lemon'),
        isFalse,
        reason: '${entry.key} should use the {appName} placeholder',
      );
    }
  });
}
