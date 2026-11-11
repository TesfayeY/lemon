import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/providers.dart';
import '../../../core/l10n/failure_messages.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/widgets/async_loader.dart';
import '../../profile/ui/form_host.dart';
import '../../profile/ui/photo_editor.dart';
import '../../profile/ui/prompt_editor.dart';
import '../../profile/ui/section_editors.dart';
import '../../profile/domain/validation.dart';
import '../data/account.dart';
import '../domain/onboarding_steps.dart';
import 'onboarding_steps_ui.dart';
import 'readiness_view.dart';

/// Step-by-step onboarding. Every step saves to the server before moving on,
/// so it resumes from the server's readiness list on any device. Readiness
/// itself is only ever read from the server.
class OnboardingFlow extends ConsumerStatefulWidget {
  const OnboardingFlow({
    super.key,
    required this.initialAccount,
    required this.onFinished,
  });

  final Account initialAccount;

  /// Called after the server reports the profile ready and the person
  /// chooses to continue into the app.
  final VoidCallback onFinished;

  @override
  ConsumerState<OnboardingFlow> createState() => _OnboardingFlowState();
}

class _OnboardingFlowState extends ConsumerState<OnboardingFlow> {
  late Account _account = widget.initialAccount;
  late final List<OnboardingStep> _steps = visibleSteps(_account.readiness);
  late int _index = _steps.indexOf(resumeStep(_account.readiness));

  OnboardingStep get _step => _steps[_index];

  void _goTo(OnboardingStep step) {
    final index = _steps.indexOf(step);
    if (index >= 0) setState(() => _index = index);
  }

  /// Refreshes the account (birth date and terms live there) and moves on.
  Future<void> _next() async {
    final completed = _step;
    if (_index < _steps.length - 1) setState(() => _index++);
    if (completed == OnboardingStep.terms ||
        completed == OnboardingStep.birthDate) {
      try {
        final account = await ref.read(apiClientProvider).getAccount();
        if (mounted) setState(() => _account = account);
      } on Object {
        // The step still works from the last known account
      }
    }
  }

  void _back() {
    if (_index > 0) setState(() => _index--);
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final progress = l10n.onboardingProgress(_index + 1, _steps.length);
    return PopScope(
      canPop: _index == 0,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _back();
      },
      child: Scaffold(
        appBar: AppBar(
          automaticallyImplyLeading: false,
          leading: _index > 0
              ? BackButton(onPressed: _back)
              : null,
          title: Text(progress),
          bottom: PreferredSize(
            preferredSize: const Size.fromHeight(4),
            child: ExcludeSemantics(
              child: LinearProgressIndicator(
                value: (_index + 1) / _steps.length,
              ),
            ),
          ),
        ),
        body: SafeArea(
          child: KeyedSubtree(
            key: ValueKey(_step),
            child: _buildStep(context),
          ),
        ),
      ),
    );
  }

  Widget _buildStep(BuildContext context) {
    final l10n = context.l10n;
    void next() => _next();
    return switch (_step) {
      OnboardingStep.verifyEmail => VerifyEmailStep(
        onVerified: (account) {
          setState(() => _account = account);
          next();
        },
      ),
      OnboardingStep.birthDate => BirthDateStep(
        account: _account,
        onSaved: next,
      ),
      OnboardingStep.terms => TermsStep(account: _account, onSaved: next),
      OnboardingStep.basics => ProfileSectionEditor(
        section: ProfileSection.basics,
        submitLabel: l10n.commonContinue,
        header: SectionHeader(title: l10n.basicsTitle),
        onSaved: (_) => next(),
      ),
      OnboardingStep.location => ProfileSectionEditor(
        section: ProfileSection.location,
        submitLabel: l10n.commonContinue,
        header: SectionHeader(
          title: l10n.locationTitle,
          subtitle: l10n.locationHelp,
        ),
        onSaved: (_) => next(),
      ),
      OnboardingStep.preferences => PreferencesEditor(
        submitLabel: l10n.commonContinue,
        header: SectionHeader(title: l10n.preferencesTitle),
        onSaved: (_) => next(),
      ),
      OnboardingStep.photos => PhotoEditor(
        header: SectionHeader(
          title: l10n.photosTitle,
          subtitle: l10n.photosHelp(
            ProfileLimits.minPhotos,
            ProfileLimits.maxPhotos,
          ),
        ),
        onContinue: next,
      ),
      OnboardingStep.prompts => PromptEditor(
        header: SectionHeader(
          title: l10n.promptsTitle,
          subtitle: l10n.promptsHelp,
        ),
        onContinue: next,
      ),
      OnboardingStep.about => ProfileSectionEditor(
        section: ProfileSection.about,
        submitLabel: l10n.commonContinue,
        skipLabel: l10n.commonSkip,
        header: SectionHeader(title: l10n.aboutTitle, subtitle: l10n.aboutHelp),
        onSaved: (_) => next(),
      ),
      OnboardingStep.readiness => _ReadinessStep(
        onFix: _goTo,
        onFinished: widget.onFinished,
      ),
    };
  }
}

class _ReadinessStep extends ConsumerStatefulWidget {
  const _ReadinessStep({required this.onFix, required this.onFinished});

  final ValueChanged<OnboardingStep> onFix;
  final VoidCallback onFinished;

  @override
  ConsumerState<_ReadinessStep> createState() => _ReadinessStepState();
}

class _ReadinessStepState extends ConsumerState<_ReadinessStep> {
  bool _checking = false;

  @override
  Widget build(BuildContext context) {
    final api = ref.read(apiClientProvider);
    return AsyncLoader<Account>(
      load: api.getAccount,
      builder: (context, account, reload) => ReadinessView(
        readiness: account.readiness,
        checking: _checking,
        onFix: widget.onFix,
        onStart: widget.onFinished,
        onCheckAgain: () async {
          setState(() => _checking = true);
          try {
            await reload();
          } on Object catch (e) {
            if (context.mounted) {
              ScaffoldMessenger.maybeOf(context)?.showSnackBar(
                SnackBar(content: Text(describeFailure(context.l10n, e))),
              );
            }
          } finally {
            if (mounted) setState(() => _checking = false);
          }
        },
      ),
    );
  }
}
