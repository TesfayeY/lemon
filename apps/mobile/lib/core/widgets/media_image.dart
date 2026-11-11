import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../theme/lemon_colors.dart';

/// An image from an authenticated media path such as `/v1/media/x/thumb`.
class MediaImage extends ConsumerStatefulWidget {
  const MediaImage({super.key, required this.path, this.semanticLabel});

  final String path;
  final String? semanticLabel;

  @override
  ConsumerState<MediaImage> createState() => _MediaImageState();
}

class _MediaImageState extends ConsumerState<MediaImage> {
  late Future<ImageProvider> _image;

  @override
  void initState() {
    super.initState();
    _image = ref.read(mediaImageLoaderProvider)(widget.path);
  }

  @override
  void didUpdateWidget(MediaImage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.path != widget.path) {
      _image = ref.read(mediaImageLoaderProvider)(widget.path);
    }
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<ImageProvider>(
      future: _image,
      builder: (context, snapshot) {
        final image = snapshot.data;
        if (image == null) return const _Placeholder();
        return Image(
          image: image,
          fit: BoxFit.cover,
          semanticLabel: widget.semanticLabel,
          excludeFromSemantics: widget.semanticLabel == null,
          errorBuilder: (_, _, _) => const _Placeholder(),
        );
      },
    );
  }
}

class _Placeholder extends StatelessWidget {
  const _Placeholder();

  @override
  Widget build(BuildContext context) {
    return const ColoredBox(
      color: LemonColors.softAccent,
      child: Center(
        child: Icon(
          Icons.image_outlined,
          color: LemonColors.textSecondary,
          size: 32,
        ),
      ),
    );
  }
}
