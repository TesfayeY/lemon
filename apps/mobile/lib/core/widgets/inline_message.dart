import 'package:flutter/material.dart';

import '../theme/lemon_colors.dart';
import '../theme/lemon_spacing.dart';
import '../theme/lemon_typography.dart';

enum MessageTone { info, error, success }

/// A short message with an icon, so meaning never relies on color alone.
/// Errors are a live region, so screen readers announce them when they appear.
class InlineMessage extends StatelessWidget {
  const InlineMessage({
    super.key,
    required this.message,
    this.tone = MessageTone.info,
  });

  final String message;
  final MessageTone tone;

  @override
  Widget build(BuildContext context) {
    final (icon, color, background) = switch (tone) {
      MessageTone.info => (
        Icons.info_outline,
        LemonColors.textSecondary,
        LemonColors.softAccent,
      ),
      MessageTone.error => (
        Icons.error_outline,
        LemonColors.error,
        LemonColors.error.withValues(alpha: 0.08),
      ),
      MessageTone.success => (
        Icons.check_circle_outline,
        LemonColors.success,
        LemonColors.success.withValues(alpha: 0.08),
      ),
    };
    return Semantics(
      liveRegion: tone == MessageTone.error,
      container: true,
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.all(LemonSpacing.md),
        decoration: BoxDecoration(
          color: background,
          borderRadius: BorderRadius.circular(LemonRadius.input),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            ExcludeSemantics(child: Icon(icon, color: color, size: 20)),
            const SizedBox(width: LemonSpacing.sm),
            Expanded(
              child: Text(
                message,
                style: LemonTypography.caption.copyWith(
                  color: tone == MessageTone.info
                      ? LemonColors.textPrimary
                      : color,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A labeled state chip with an icon, e.g. "In review".
class StatusBadge extends StatelessWidget {
  const StatusBadge({
    super.key,
    required this.label,
    required this.icon,
    this.color = LemonColors.textSecondary,
  });

  final String label;
  final IconData icon;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: LemonSpacing.sm,
        vertical: LemonSpacing.xs,
      ),
      decoration: BoxDecoration(
        color: LemonColors.surface.withValues(alpha: 0.94),
        borderRadius: BorderRadius.circular(LemonRadius.input),
        border: Border.all(color: color.withValues(alpha: 0.4)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          ExcludeSemantics(child: Icon(icon, size: 16, color: color)),
          const SizedBox(width: LemonSpacing.xs),
          Flexible(
            child: Text(
              label,
              style: LemonTypography.caption.copyWith(
                color: color,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
