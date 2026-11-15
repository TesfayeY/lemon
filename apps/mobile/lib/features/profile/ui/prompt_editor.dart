import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/providers.dart';
import '../../../core/catalogs/catalogs.dart';
import '../../../core/l10n/failure_messages.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/theme/lemon_spacing.dart';
import '../../../core/theme/lemon_typography.dart';
import '../../../core/widgets/async_loader.dart';
import '../../../core/widgets/inline_message.dart';
import '../../../core/widgets/lemon_button.dart';
import '../../../core/widgets/lemon_card.dart';
import '../../../core/widgets/revision_conflict.dart';
import '../data/profile.dart';
import '../domain/validation.dart';

/// Three prompt answers and actions to add, edit or remove them. Each action
/// saves immediately, and answers are on the profile as soon as they are
/// saved (D-13): there is no review step for prompts.
class PromptEditor extends ConsumerStatefulWidget {
  const PromptEditor({
    super.key,
    this.header,
    this.continueLabel,
    this.onContinue,
  });

  final Widget? header;
  final String? continueLabel;
  final VoidCallback? onContinue;

  @override
  ConsumerState<PromptEditor> createState() => _PromptEditorState();
}

class _PromptEditorState extends ConsumerState<PromptEditor> {
  late final _api = ref.read(apiClientProvider);
  SelfProfile? _profile;
  Catalogs? _catalogs;
  bool _busy = false;
  String? _error;

  Future<void> _load() async {
    final catalogs = await ref.read(catalogsRepositoryProvider).load();
    final profile = await _api.getProfile();
    _catalogs = catalogs;
    _profile = profile;
  }

  Future<void> _refresh() async {
    final profile = await _api.getProfile();
    if (mounted) setState(() => _profile = profile);
  }

  Future<void> _add() async {
    final answered = {for (final a in _profile!.promptAnswers) a.promptId};
    final submitted = await Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (_) => PromptPickerScreen(
          catalogs: _catalogs!,
          excludedPromptIds: answered,
        ),
      ),
    );
    if (submitted == true) await _refreshSafely();
  }

  Future<void> _edit(SelfPromptAnswer answer) async {
    final submitted = await Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (_) => PromptComposerScreen(
          promptId: answer.promptId,
          promptText: answer.promptText,
          existing: answer,
        ),
      ),
    );
    if (submitted == true) await _refreshSafely();
  }

  Future<void> _remove(SelfPromptAnswer answer) async {
    final l10n = context.l10n;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(l10n.promptRemoveTitle),
        content: SingleChildScrollView(child: Text(l10n.promptRemoveBody)),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: Text(l10n.commonCancel),
          ),
          TextButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(l10n.promptRemove),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await _api.deletePromptAnswer(answer.id);
      await _refresh();
    } on Object catch (e) {
      if (mounted) setState(() => _error = describeFailure(context.l10n, e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _refreshSafely() async {
    try {
      await _refresh();
    } on Object catch (e) {
      if (mounted) setState(() => _error = describeFailure(context.l10n, e));
    }
  }

  @override
  Widget build(BuildContext context) {
    return AsyncLoader<void>(
      load: _load,
      builder: (context, _, _) => _buildEditor(context, _profile!),
    );
  }

  Widget _buildEditor(BuildContext context, SelfProfile profile) {
    final l10n = context.l10n;
    const total = ProfileLimits.promptAnswersRequired;
    final answers = profile.promptAnswers;
    final counted = answers.length;
    final error = _error;
    return ListView(
      padding: const EdgeInsets.all(LemonSpacing.lg),
      children: [
        ?widget.header,
        Text(l10n.promptsCount(counted, total), style: LemonTypography.section),
        const SizedBox(height: LemonSpacing.base),
        for (final answer in answers) ...[
          PromptAnswerCard(
            answer: answer,
            onEdit: _busy ? null : () => _edit(answer),
            onRemove: _busy ? null : () => _remove(answer),
          ),
          const SizedBox(height: LemonSpacing.base),
        ],
        if (answers.length < total)
          LemonButton(
            label: l10n.promptsChoose,
            isOutlined: true,
            onPressed: _busy ? null : _add,
          ),
        if (error != null) ...[
          const SizedBox(height: LemonSpacing.base),
          InlineMessage(message: error, tone: MessageTone.error),
        ],
        if (widget.onContinue case final onContinue?) ...[
          const SizedBox(height: LemonSpacing.lg),
          if (counted < total) ...[
            InlineMessage(message: l10n.promptsNeedMore(total)),
            const SizedBox(height: LemonSpacing.base),
          ],
          LemonButton(
            label: widget.continueLabel ?? l10n.commonContinue,
            onPressed: counted >= total ? onContinue : null,
          ),
        ],
      ],
    );
  }
}

/// One answer as its owner sees it, exactly as it appears on the profile.
class PromptAnswerCard extends StatelessWidget {
  const PromptAnswerCard({
    super.key,
    required this.answer,
    required this.onEdit,
    required this.onRemove,
  });

  final SelfPromptAnswer answer;
  final VoidCallback? onEdit;
  final VoidCallback? onRemove;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return LemonCard(
      margin: EdgeInsets.zero,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            answer.promptText,
            style: LemonTypography.caption.copyWith(fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: LemonSpacing.sm),
          Text(answer.text, style: LemonTypography.body),
          const SizedBox(height: LemonSpacing.sm),
          Wrap(
            children: [
              TextButton(onPressed: onEdit, child: Text(l10n.promptEdit)),
              TextButton(onPressed: onRemove, child: Text(l10n.promptRemove)),
            ],
          ),
        ],
      ),
    );
  }
}

/// Searchable prompt catalog with category filters. Prompts already
/// answered are left out so the same prompt is never answered twice.
class PromptPickerScreen extends StatefulWidget {
  const PromptPickerScreen({
    super.key,
    required this.catalogs,
    required this.excludedPromptIds,
  });

  final Catalogs catalogs;
  final Set<String> excludedPromptIds;

  @override
  State<PromptPickerScreen> createState() => _PromptPickerScreenState();
}

class _PromptPickerScreenState extends State<PromptPickerScreen> {
  final _search = TextEditingController();
  String? _category;

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  String _categoryLabel(AppLocalizations l10n, String category) =>
      switch (category) {
        'general' => l10n.promptCategoryGeneral,
        'cultural' => l10n.promptCategoryCultural,
        'lifestyle' => l10n.promptCategoryLifestyle,
        'dating' => l10n.promptCategoryDating,
        _ => category,
      };

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final query = _search.text.trim().toLowerCase();
    final available = widget.catalogs.prompts
        .where((p) => p.active && !widget.excludedPromptIds.contains(p.id))
        .toList();
    final categories = {for (final p in available) p.category}.toList();
    final shown = available
        .where((p) => _category == null || p.category == _category)
        .where((p) => query.isEmpty || p.text.toLowerCase().contains(query))
        .toList();
    return Scaffold(
      appBar: AppBar(title: Text(l10n.promptsChoose)),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(LemonSpacing.lg),
          children: [
            TextField(
              controller: _search,
              onChanged: (_) => setState(() {}),
              decoration: InputDecoration(
                labelText: l10n.promptPickerSearch,
                prefixIcon: const Icon(Icons.search),
              ),
            ),
            const SizedBox(height: LemonSpacing.md),
            Wrap(
              spacing: LemonSpacing.sm,
              runSpacing: LemonSpacing.sm,
              children: [
                ChoiceChip(
                  label: Text(l10n.promptCategoryAll),
                  selected: _category == null,
                  onSelected: (_) => setState(() => _category = null),
                ),
                for (final category in categories)
                  ChoiceChip(
                    label: Text(_categoryLabel(l10n, category)),
                    selected: _category == category,
                    onSelected: (_) => setState(() => _category = category),
                  ),
              ],
            ),
            const SizedBox(height: LemonSpacing.md),
            if (shown.isEmpty) InlineMessage(message: l10n.promptPickerNoResults),
            for (final prompt in shown)
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(prompt.text),
                subtitle: Text(_categoryLabel(l10n, prompt.category)),
                trailing: const Icon(Icons.chevron_right),
                onTap: () async {
                  final navigator = Navigator.of(context);
                  final submitted = await navigator.push<bool>(
                    MaterialPageRoute(
                      builder: (_) => PromptComposerScreen(
                        promptId: prompt.id,
                        promptText: prompt.text,
                      ),
                    ),
                  );
                  if (submitted == true) navigator.pop(true);
                },
              ),
          ],
        ),
      ),
    );
  }
}

/// Writes a new answer, or new text for [existing]. Either is on the profile
/// as soon as it is saved.
class PromptComposerScreen extends ConsumerStatefulWidget {
  const PromptComposerScreen({
    super.key,
    required this.promptId,
    required this.promptText,
    this.existing,
  });

  final String promptId;
  final String promptText;
  final SelfPromptAnswer? existing;

  @override
  ConsumerState<PromptComposerScreen> createState() =>
      _PromptComposerScreenState();
}

class _PromptComposerScreenState extends ConsumerState<PromptComposerScreen> {
  late final _text = TextEditingController(text: widget.existing?.text);
  bool _attempted = false;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() => _attempted = true);
    if (validateRequiredText(_text.text, max: ProfileLimits.promptAnswerMax) !=
        null) {
      return;
    }
    final text = normalizeWhitespace(_text.text);
    final api = ref.read(apiClientProvider);
    final existing = widget.existing;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      if (existing == null) {
        await api.submitPromptAnswer(promptId: widget.promptId, text: text);
      } else {
        final outcome = await saveWithConflictRecovery<SelfPromptAnswer?>(
          context: context,
          baseRevision: existing.revision,
          send: (revision) => api.replacePromptAnswer(
            answerId: existing.id,
            expectedRevision: revision,
            text: text,
          ),
          reload: () async {
            final profile = await api.getProfile();
            for (final a in profile.promptAnswers) {
              if (a.id == existing.id) return a;
            }
            return null;
          },
          revisionOf: (a) => a?.revision ?? existing.revision,
        );
        if (outcome is! Saved<SelfPromptAnswer?>) {
          // The person chose the other device's version
          if (mounted) Navigator.of(context).pop(true);
          return;
        }
      }
      // The editor reloads and shows the saved answer
      if (mounted) Navigator.of(context).pop(true);
    } on Object catch (e) {
      if (mounted) setState(() => _error = describeFailure(context.l10n, e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final validation = !_attempted
        ? null
        : switch (validateRequiredText(
            _text.text,
            max: ProfileLimits.promptAnswerMax,
          )) {
            TextError.required => l10n.promptAnswerRequired,
            TextError.tooLong => l10n.commonTextTooLong(
              ProfileLimits.promptAnswerMax,
            ),
            null => null,
          };
    final error = _error;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.promptAnswerLabel)),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(LemonSpacing.lg),
          children: [
            Semantics(
              header: true,
              child: Text(widget.promptText, style: LemonTypography.section),
            ),
            const SizedBox(height: LemonSpacing.base),
            TextField(
              controller: _text,
              autofocus: true,
              minLines: 3,
              maxLines: 8,
              maxLength: ProfileLimits.promptAnswerMax,
              textCapitalization: TextCapitalization.sentences,
              onChanged: (_) {
                if (_attempted) setState(() {});
              },
              decoration: InputDecoration(
                labelText: l10n.promptAnswerLabel,
                alignLabelWithHint: true,
                errorText: validation,
                errorMaxLines: 3,
              ),
            ),
            const SizedBox(height: LemonSpacing.base),
            if (error != null) ...[
              InlineMessage(message: error, tone: MessageTone.error),
              const SizedBox(height: LemonSpacing.base),
            ],
            LemonButton(
              label: l10n.promptSubmit,
              onPressed: _submit,
              isLoading: _busy,
            ),
          ],
        ),
      ),
    );
  }
}
