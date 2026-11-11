import 'package:flutter/material.dart';

import '../api/api_exception.dart';
import '../l10n/l10n.dart';

/// How a revisioned save ended.
sealed class SaveOutcome<T> {
  const SaveOutcome();
}

/// Saved; [latest] is the server-confirmed state after the save.
class Saved<T> extends SaveOutcome<T> {
  const Saved(this.latest);
  final T latest;
}

/// Another device changed the data and the person chose the latest version;
/// their unsent edits were discarded.
class ReloadedLatest<T> extends SaveOutcome<T> {
  const ReloadedLatest(this.latest);
  final T latest;
}

/// The screen went away while resolving a conflict.
class SaveAbandoned<T> extends SaveOutcome<T> {
  const SaveAbandoned();
}

enum ConflictChoice { keepMine, useLatest }

/// Explains a revision conflict and asks whether to reapply local edits.
Future<ConflictChoice> showConflictDialog(BuildContext context) async {
  final l10n = context.l10n;
  final choice = await showDialog<ConflictChoice>(
    context: context,
    barrierDismissible: false,
    builder: (context) => AlertDialog(
      title: Text(l10n.conflictTitle),
      content: SingleChildScrollView(child: Text(l10n.conflictBody)),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(ConflictChoice.useLatest),
          child: Text(l10n.conflictUseLatest),
        ),
        TextButton(
          onPressed: () => Navigator.of(context).pop(ConflictChoice.keepMine),
          child: Text(l10n.conflictKeepMine),
        ),
      ],
    ),
  );
  return choice ?? ConflictChoice.useLatest;
}

/// Sends an edit based on [baseRevision]. On `409 REVISION_CONFLICT` it
/// refreshes from the server, tells the person, and either reapplies their
/// edits on the new revision or returns the latest data unchanged.
///
/// Other failures are rethrown for the screen to show.
Future<SaveOutcome<T>> saveWithConflictRecovery<T>({
  required BuildContext context,
  required int baseRevision,
  required Future<void> Function(int expectedRevision) send,
  required Future<T> Function() reload,
  required int Function(T latest) revisionOf,
  Future<ConflictChoice> Function(BuildContext context) ask =
      showConflictDialog,
}) async {
  var revision = baseRevision;
  while (true) {
    try {
      await send(revision);
      return Saved(await reload());
    } on ApiException catch (e) {
      if (!e.isRevisionConflict) rethrow;
      final latest = await reload();
      if (!context.mounted) return const SaveAbandoned();
      final choice = await ask(context);
      if (choice == ConflictChoice.useLatest) return ReloadedLatest(latest);
      revision = revisionOf(latest);
    }
  }
}
