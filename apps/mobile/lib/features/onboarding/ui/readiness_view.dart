import 'package:flutter/material.dart';

import '../../../core/l10n/l10n.dart';
import '../../../core/theme/lemon_colors.dart';
import '../../../core/theme/lemon_spacing.dart';
import '../../../core/theme/lemon_typography.dart';
import '../../../core/widgets/inline_message.dart';
import '../../../core/widgets/lemon_button.dart';
import '../data/account.dart';
import '../domain/onboarding_steps.dart';

/// Localized label for a readiness requirement the server reports missing.
String requirementLabel(AppLocalizations l10n, ReadinessRequirement r) =>
    switch (r) {
      ReadinessRequirement.emailVerified => l10n.requirementEmailVerified,
      ReadinessRequirement.adultEligible => l10n.requirementAdultEligible,
      ReadinessRequirement.termsAccepted => l10n.requirementTermsAccepted,
      ReadinessRequirement.displayName => l10n.requirementDisplayName,
      ReadinessRequirement.genderIdentity => l10n.requirementGenderIdentity,
      ReadinessRequirement.interests => l10n.requirementInterests,
      ReadinessRequirement.location => l10n.requirementLocation,
      ReadinessRequirement.intention => l10n.requirementIntention,
      ReadinessRequirement.photos => l10n.requirementPhotos,
      ReadinessRequirement.promptAnswers => l10n.requirementPromptAnswers,
      ReadinessRequirement.accountSuspended =>
        l10n.requirementAccountSuspended,
      ReadinessRequirement.unknown => l10n.requirementUnknown,
    };

/// Summary driven entirely by the server's readiness response. The client
/// never decides that a profile is ready.
class ReadinessView extends StatelessWidget {
  const ReadinessView({
    super.key,
    required this.readiness,
    required this.onCheckAgain,
    this.onFix,
    this.onStart,
    this.checking = false,
  });

  final Readiness readiness;
  final VoidCallback onCheckAgain;

  /// Jumps to the step that fixes a requirement; null hides "Fix" buttons.
  final ValueChanged<OnboardingStep>? onFix;

  /// Shown only when the server says the profile is ready.
  final VoidCallback? onStart;
  final bool checking;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    if (readiness.ready) {
      return ListView(
        padding: const EdgeInsets.all(LemonSpacing.lg),
        children: [
          const ExcludeSemantics(
            child: Icon(
              Icons.check_circle_outline,
              size: 64,
              color: LemonColors.success,
            ),
          ),
          const SizedBox(height: LemonSpacing.base),
          Semantics(
            header: true,
            child: Text(
              l10n.readinessReadyTitle,
              style: LemonTypography.title,
              textAlign: TextAlign.center,
            ),
          ),
          const SizedBox(height: LemonSpacing.sm),
          Text(
            l10n.readinessReadyBody,
            style: LemonTypography.body,
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: LemonSpacing.xl),
          if (onStart != null)
            LemonButton(label: l10n.readinessStart, onPressed: onStart),
        ],
      );
    }
    final missing = readiness.missing;
    final awaitingReview = missing.any(
      (r) =>
          r == ReadinessRequirement.photos ||
          r == ReadinessRequirement.promptAnswers,
    );
    return ListView(
      padding: const EdgeInsets.all(LemonSpacing.lg),
      children: [
        Semantics(
          header: true,
          child: Text(l10n.readinessPendingTitle, style: LemonTypography.title),
        ),
        const SizedBox(height: LemonSpacing.sm),
        Text(l10n.readinessPendingBody, style: LemonTypography.body),
        const SizedBox(height: LemonSpacing.base),
        for (final requirement in missing)
          _MissingRow(
            label: requirementLabel(l10n, requirement),
            onFix: switch ((onFix, stepFor(requirement))) {
              (final fix?, final step?) => () => fix(step),
              _ => null,
            },
          ),
        if (awaitingReview) ...[
          const SizedBox(height: LemonSpacing.sm),
          InlineMessage(message: l10n.readinessReviewNote),
        ],
        const SizedBox(height: LemonSpacing.lg),
        LemonButton(
          label: l10n.readinessCheckAgain,
          isOutlined: true,
          isLoading: checking,
          onPressed: onCheckAgain,
        ),
      ],
    );
  }
}

class _MissingRow extends StatelessWidget {
  const _MissingRow({required this.label, required this.onFix});

  final String label;
  final VoidCallback? onFix;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: LemonSpacing.sm),
      child: Row(
        children: [
          const ExcludeSemantics(
            child: Icon(
              Icons.radio_button_unchecked,
              color: LemonColors.textSecondary,
            ),
          ),
          const SizedBox(width: LemonSpacing.md),
          Expanded(child: Text(label, style: LemonTypography.body)),
          if (onFix != null)
            TextButton(
              onPressed: onFix,
              child: Text(
                context.l10n.readinessFix,
                semanticsLabel: context.l10n.readinessFixItem(label),
              ),
            ),
        ],
      ),
    );
  }
}
