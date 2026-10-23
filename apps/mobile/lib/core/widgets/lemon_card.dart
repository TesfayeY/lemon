import 'package:flutter/material.dart';
import '../theme/lemon_colors.dart';
import '../theme/lemon_spacing.dart';

/// Content card with optional header and padding.
class LemonCard extends StatelessWidget {
  const LemonCard({
    super.key,
    required this.child,
    this.padding,
    this.margin,
  });

  final Widget child;
  final EdgeInsets? padding;
  final EdgeInsets? margin;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: margin ?? const EdgeInsets.symmetric(horizontal: LemonSpacing.base),
      decoration: BoxDecoration(
        color: LemonColors.surface,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: LemonColors.divider, width: 0.5),
      ),
      child: Padding(
        padding: padding ?? const EdgeInsets.all(LemonSpacing.base),
        child: child,
      ),
    );
  }
}
