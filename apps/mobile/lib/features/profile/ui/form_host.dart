import 'package:flutter/material.dart';

import '../../../core/api/api_exception.dart';
import '../../../core/api/changes.dart';
import '../../../core/l10n/failure_messages.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/theme/lemon_spacing.dart';
import '../../../core/theme/lemon_typography.dart';
import '../../../core/widgets/inline_message.dart';
import '../../../core/widgets/lemon_button.dart';
import '../../../core/widgets/revision_conflict.dart';

/// A form section that validates locally and returns the wire values of the
/// fields it owns, or null when something needs fixing.
abstract class SectionFormState<T extends StatefulWidget> extends State<T> {
  Map<String, Object?>? collect();
}

/// Builds a form for [data]. [serverErrors] holds field names the server
/// rejected, so the form can point at them.
typedef SectionFormBuilder<T> =
    Widget Function(
      BuildContext context,
      T data,
      GlobalKey<SectionFormState> key,
      Set<String> serverErrors,
    );

/// Hosts a form over a revisioned resource (profile or preferences).
///
/// Local edits stay in the form until the server confirms them. Only changed
/// fields are sent, always with `expectedRevision`; a conflict refreshes from
/// the server and lets the person keep their edits or take the latest.
class RevisionedFormHost<T> extends StatefulWidget {
  const RevisionedFormHost({
    super.key,
    required this.initial,
    required this.revisionOf,
    required this.toJson,
    required this.send,
    required this.reload,
    required this.formBuilder,
    required this.submitLabel,
    required this.onSaved,
    this.header,
    this.skipLabel,
  });

  final T initial;
  final int Function(T data) revisionOf;
  final Map<String, Object?> Function(T data) toJson;
  final Future<void> Function(int expectedRevision, Map<String, Object?> changes)
  send;
  final Future<T> Function() reload;
  final SectionFormBuilder<T> formBuilder;
  final String submitLabel;

  /// Called with server-confirmed data after a save (or when nothing changed).
  final ValueChanged<T> onSaved;
  final Widget? header;

  /// When set, a secondary action continues without saving.
  final String? skipLabel;

  @override
  State<RevisionedFormHost<T>> createState() => _RevisionedFormHostState<T>();
}

class _RevisionedFormHostState<T> extends State<RevisionedFormHost<T>> {
  var _formKey = GlobalKey<SectionFormState>();
  late T _data = widget.initial;
  int _formVersion = 0;
  bool _busy = false;
  String? _error;
  Set<String> _serverErrors = const {};

  Future<void> _submit() async {
    final edited = _formKey.currentState?.collect();
    if (edited == null) return;
    final changes = changedFields(widget.toJson(_data), edited);
    if (changes.isEmpty) {
      widget.onSaved(_data);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
      _serverErrors = const {};
    });
    try {
      final outcome = await saveWithConflictRecovery<T>(
        context: context,
        baseRevision: widget.revisionOf(_data),
        send: (revision) => widget.send(revision, changes),
        reload: widget.reload,
        revisionOf: widget.revisionOf,
      );
      if (!mounted) return;
      switch (outcome) {
        case Saved(:final latest):
          setState(() => _data = latest);
          widget.onSaved(latest);
        case ReloadedLatest(:final latest):
          setState(() {
            _data = latest;
            _formVersion++;
            _formKey = GlobalKey<SectionFormState>();
          });
          ScaffoldMessenger.maybeOf(context)?.showSnackBar(
            SnackBar(content: Text(context.l10n.conflictReloaded)),
          );
        case SaveAbandoned():
          break;
      }
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = describeFailure(context.l10n, e);
        _serverErrors = {for (final f in e.error.fieldErrors) f.field};
      });
    } on Object catch (e) {
      if (!mounted) return;
      setState(() => _error = describeFailure(context.l10n, e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final error = _error;
    return ListView(
      padding: const EdgeInsets.all(LemonSpacing.lg),
      children: [
        ?widget.header,
        KeyedSubtree(
          key: ValueKey(_formVersion),
          child: widget.formBuilder(context, _data, _formKey, _serverErrors),
        ),
        const SizedBox(height: LemonSpacing.lg),
        if (error != null) ...[
          InlineMessage(message: error, tone: MessageTone.error),
          const SizedBox(height: LemonSpacing.base),
        ],
        LemonButton(
          label: widget.submitLabel,
          onPressed: _submit,
          isLoading: _busy,
        ),
        if (widget.skipLabel case final skip?) ...[
          const SizedBox(height: LemonSpacing.sm),
          TextButton(
            onPressed: _busy ? null : () => widget.onSaved(_data),
            child: Text(skip),
          ),
        ],
      ],
    );
  }
}

/// Large heading and supporting text at the top of a step or section.
class SectionHeader extends StatelessWidget {
  const SectionHeader({super.key, required this.title, this.subtitle});

  final String title;
  final String? subtitle;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: LemonSpacing.lg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Semantics(
            header: true,
            child: Text(title, style: LemonTypography.title),
          ),
          if (subtitle case final text?) ...[
            const SizedBox(height: LemonSpacing.sm),
            Text(text, style: LemonTypography.body),
          ],
        ],
      ),
    );
  }
}

/// A labeled group of fields, with an optional error under the label.
class FieldGroup extends StatelessWidget {
  const FieldGroup({
    super.key,
    required this.label,
    required this.child,
    this.help,
    this.error,
  });

  final String label;
  final String? help;
  final String? error;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final error = this.error;
    return Padding(
      padding: const EdgeInsets.only(bottom: LemonSpacing.lg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Semantics(
            header: true,
            child: Text(label, style: LemonTypography.section),
          ),
          if (help case final text?) ...[
            const SizedBox(height: LemonSpacing.xs),
            Text(text, style: LemonTypography.caption),
          ],
          const SizedBox(height: LemonSpacing.sm),
          child,
          if (error != null) ...[
            const SizedBox(height: LemonSpacing.sm),
            InlineMessage(message: error, tone: MessageTone.error),
          ],
        ],
      ),
    );
  }
}

/// Single-select chips from a catalog.
class SingleChoiceChips extends StatelessWidget {
  const SingleChoiceChips({
    super.key,
    required this.options,
    required this.selected,
    required this.onSelected,
  });

  final List<({String id, String label})> options;
  final String? selected;
  final ValueChanged<String> onSelected;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: LemonSpacing.sm,
      runSpacing: LemonSpacing.sm,
      children: [
        for (final option in options)
          ChoiceChip(
            label: Text(option.label),
            selected: option.id == selected,
            onSelected: (_) => onSelected(option.id),
          ),
      ],
    );
  }
}

/// Multi-select chips from a catalog.
class MultiChoiceChips extends StatelessWidget {
  const MultiChoiceChips({
    super.key,
    required this.options,
    required this.selected,
    required this.onChanged,
  });

  final List<({String id, String label})> options;
  final Set<String> selected;
  final ValueChanged<Set<String>> onChanged;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: LemonSpacing.sm,
      runSpacing: LemonSpacing.sm,
      children: [
        for (final option in options)
          FilterChip(
            label: Text(option.label),
            selected: selected.contains(option.id),
            onSelected: (on) => onChanged(
              on ? {...selected, option.id} : ({...selected}..remove(option.id)),
            ),
          ),
      ],
    );
  }
}
