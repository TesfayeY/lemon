import 'package:flutter/material.dart';
import '../theme/lemon_colors.dart';
import '../theme/lemon_spacing.dart';
import '../theme/lemon_typography.dart';

/// Full-screen loading indicator.
class LemonLoadingView extends StatelessWidget {
  const LemonLoadingView({super.key, this.message});
  final String? message;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const CircularProgressIndicator(color: LemonColors.primary),
          if (message != null) ...[
            const SizedBox(height: LemonSpacing.base),
            Text(message!, style: LemonTypography.caption),
          ],
        ],
      ),
    );
  }
}

/// Full-screen empty state with message and optional action.
class LemonEmptyView extends StatelessWidget {
  const LemonEmptyView({
    super.key,
    required this.message,
    this.actionLabel,
    this.onAction,
    this.icon,
  });

  final String message;
  final String? actionLabel;
  final VoidCallback? onAction;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(LemonSpacing.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (icon != null)
              Icon(icon, size: 64, color: LemonColors.disabled),
            const SizedBox(height: LemonSpacing.base),
            Text(
              message,
              style: LemonTypography.body.copyWith(color: LemonColors.textSecondary),
              textAlign: TextAlign.center,
            ),
            if (actionLabel != null && onAction != null) ...[
              const SizedBox(height: LemonSpacing.lg),
              TextButton(
                onPressed: onAction,
                child: Text(actionLabel!),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// Full-screen error state with retry.
class LemonErrorView extends StatelessWidget {
  const LemonErrorView({
    super.key,
    required this.message,
    this.onRetry,
  });

  final String message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(LemonSpacing.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, size: 64, color: LemonColors.error),
            const SizedBox(height: LemonSpacing.base),
            Text(
              message,
              style: LemonTypography.body.copyWith(color: LemonColors.textSecondary),
              textAlign: TextAlign.center,
            ),
            if (onRetry != null) ...[
              const SizedBox(height: LemonSpacing.lg),
              TextButton.icon(
                onPressed: onRetry,
                icon: const Icon(Icons.refresh),
                label: const Text('Try again'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
