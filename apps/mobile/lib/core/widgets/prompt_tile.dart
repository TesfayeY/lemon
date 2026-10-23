import 'package:flutter/material.dart';
import '../theme/lemon_colors.dart';
import '../theme/lemon_spacing.dart';
import '../theme/lemon_typography.dart';

/// Displays a profile prompt question and answer.
class PromptTile extends StatelessWidget {
  const PromptTile({
    super.key,
    required this.question,
    required this.answer,
    this.onLike,
    this.showLike = true,
  });

  final String question;
  final String answer;
  final VoidCallback? onLike;
  final bool showLike;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(LemonSpacing.base),
      decoration: BoxDecoration(
        color: LemonColors.softAccent,
        borderRadius: BorderRadius.circular(20),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            question,
            style: LemonTypography.caption.copyWith(
              fontWeight: FontWeight.w600,
              color: LemonColors.textSecondary,
            ),
          ),
          const SizedBox(height: LemonSpacing.sm),
          Text(
            answer,
            style: LemonTypography.body,
          ),
          if (showLike) ...[
            const SizedBox(height: LemonSpacing.md),
            Align(
              alignment: Alignment.centerRight,
              child: SizedBox(
                width: LemonSize.touchTarget,
                height: LemonSize.touchTarget,
                child: IconButton(
                  icon: const Icon(Icons.favorite_border),
                  color: LemonColors.primary,
                  onPressed: onLike,
                  tooltip: 'Like this answer',
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

abstract final class LemonSize {
  static const double touchTarget = 48;
}
