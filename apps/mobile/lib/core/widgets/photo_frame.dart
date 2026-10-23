import 'package:flutter/material.dart';
import '../theme/lemon_colors.dart';
import '../theme/lemon_spacing.dart';

/// Displays a profile photo with rounded corners and optional like action.
class PhotoFrame extends StatelessWidget {
  const PhotoFrame({
    super.key,
    required this.imageProvider,
    this.aspectRatio = 3 / 4,
    this.onLike,
    this.showLike = true,
  });

  final ImageProvider imageProvider;
  final double aspectRatio;
  final VoidCallback? onLike;
  final bool showLike;

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(20),
      child: AspectRatio(
        aspectRatio: aspectRatio,
        child: Stack(
          fit: StackFit.expand,
          children: [
            Image(
              image: imageProvider,
              fit: BoxFit.cover,
              errorBuilder: (_, _, _) => Container(
                color: LemonColors.softAccent,
                child: const Center(
                  child: Icon(
                    Icons.image_not_supported_outlined,
                    color: LemonColors.textSecondary,
                    size: 48,
                  ),
                ),
              ),
            ),
            if (showLike)
              Positioned(
                right: LemonSpacing.sm,
                bottom: LemonSpacing.sm,
                child: Container(
                  decoration: BoxDecoration(
                    color: LemonColors.surface.withValues(alpha: 0.9),
                    shape: BoxShape.circle,
                  ),
                  child: IconButton(
                    icon: const Icon(Icons.favorite_border),
                    color: LemonColors.primary,
                    onPressed: onLike,
                    tooltip: 'Like this photo',
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
