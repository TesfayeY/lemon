import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/config.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/theme/lemon_colors.dart';
import '../../../core/theme/lemon_spacing.dart';
import '../../../core/theme/lemon_typography.dart';
import '../application/auth_controller.dart';
import '../domain/credentials.dart';
import 'auth_messages.dart';

/// Page frame for sign-in screens: app bar with back, safe area, a single
/// scrolling column (large text never overflows), width capped on tablets.
class AuthPage extends StatelessWidget {
  const AuthPage({super.key, required this.children, this.showAppBar = true});

  final List<Widget> children;
  final bool showAppBar;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: showAppBar ? AppBar() : null,
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 520),
            child: ListView(
              padding: const EdgeInsets.all(LemonSpacing.lg),
              children: children,
            ),
          ),
        ),
      ),
    );
  }
}

/// Live checklist of the password rules. Each rule has an icon and text and
/// a "Done"/"Still needed" label, so state never relies on color alone.
class PasswordRequirementsList extends StatelessWidget {
  const PasswordRequirementsList({
    super.key,
    required this.policy,
    required this.password,
  });

  final PasswordPolicy policy;
  final String password;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final unmet = policy.unmet(password).toSet();
    final shown = [
      ...policy.requirements,
      if (unmet.contains(PasswordRequirement.maxLength))
        PasswordRequirement.maxLength,
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(l10n.passwordRulesTitle, style: LemonTypography.caption),
        const SizedBox(height: LemonSpacing.xs),
        for (final requirement in shown)
          _RequirementRow(
            label: passwordRequirementLabel(l10n, policy, requirement),
            met: !unmet.contains(requirement),
          ),
      ],
    );
  }
}

class _RequirementRow extends StatelessWidget {
  const _RequirementRow({required this.label, required this.met});

  final String label;
  final bool met;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final color = met ? LemonColors.success : LemonColors.textSecondary;
    return MergeSemantics(
      child: Semantics(
        label: met ? l10n.passwordRuleMet(label) : l10n.passwordRuleUnmet(label),
        excludeSemantics: true,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 2),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Icon(
                  met ? Icons.check_circle : Icons.radio_button_unchecked,
                  size: 18,
                  color: color,
                ),
              ),
              const SizedBox(width: LemonSpacing.sm),
              Expanded(
                child: Text(
                  label,
                  style: LemonTypography.caption.copyWith(
                    color: met ? LemonColors.success : LemonColors.textPrimary,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The placeholder wordmark (branding is open, P-01) with a restrained
/// woven-line accent.
class Wordmark extends StatelessWidget {
  const Wordmark({super.key});

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Semantics(
          header: true,
          child: Text(
            appName,
            style: LemonTypography.display.copyWith(color: LemonColors.primary),
          ),
        ),
        const SizedBox(height: LemonSpacing.sm),
        const ExcludeSemantics(
          child: SizedBox(
            width: 120,
            height: 10,
            child: CustomPaint(painter: _WovenLinePainter()),
          ),
        ),
      ],
    );
  }
}

class _WovenLinePainter extends CustomPainter {
  const _WovenLinePainter();

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = LemonColors.accent
      ..strokeWidth = 2
      ..style = PaintingStyle.stroke;
    const step = 10.0;
    final over = Path();
    final under = Path();
    for (var x = 0.0; x < size.width; x += step * 2) {
      over
        ..moveTo(x, size.height)
        ..lineTo(x + step, 0)
        ..lineTo(x + step * 2, size.height);
      under
        ..moveTo(x, 0)
        ..lineTo(x + step, size.height)
        ..lineTo(x + step * 2, 0);
    }
    canvas.drawPath(over, paint);
    canvas.drawPath(under, paint..color = LemonColors.accent.withValues(alpha: 0.45));
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

/// Asks before signing out; the app gate then shows the welcome screen.
Future<void> confirmSignOut(BuildContext context, WidgetRef ref) async {
  final l10n = context.l10n;
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(l10n.signOutConfirmTitle(appName)),
      content: Text(l10n.signOutConfirmBody),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(false),
          child: Text(l10n.commonCancel),
        ),
        TextButton(
          onPressed: () => Navigator.of(context).pop(true),
          child: Text(l10n.signOut),
        ),
      ],
    ),
  );
  if (confirmed ?? false) {
    await ref.read(authControllerProvider.notifier).signOut();
  }
}
