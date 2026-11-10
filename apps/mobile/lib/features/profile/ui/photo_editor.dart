import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/providers.dart';
import '../../../core/api/api_exception.dart';
import '../../../core/l10n/failure_messages.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/theme/lemon_colors.dart';
import '../../../core/theme/lemon_spacing.dart';
import '../../../core/theme/lemon_typography.dart';
import '../../../core/widgets/async_loader.dart';
import '../../../core/widgets/inline_message.dart';
import '../../../core/widgets/lemon_button.dart';
import '../../../core/widgets/media_image.dart';
import '../data/photo_picker.dart';
import '../data/photos.dart';

/// Client-generated key reused on every retry of one upload.
String newIdempotencyKey([Random? random]) {
  final rng = random ?? Random.secure();
  const alphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return List.generate(32, (_) => alphabet[rng.nextInt(alphabet.length)]).join();
}

/// Localized, respectful copy for a photo rejection code.
String rejectionMessage(AppLocalizations l10n, RejectionReason? reason) =>
    switch (reason?.code) {
      'face_not_clear' => l10n.photoReasonFaceNotClear,
      'multiple_people' => l10n.photoReasonMultiplePeople,
      'low_quality' => l10n.photoReasonLowQuality,
      'contact_details' => l10n.photoReasonContactDetails,
      _ => l10n.photoReasonCommunityGuidelines,
    };

class _Upload {
  _Upload(this.photo) : key = newIdempotencyKey();

  final PickedPhoto photo;
  final String key;

  /// Photo this upload replaces, removed once the upload succeeds.
  String? replaces;
  bool failed = false;
}

/// Ordered photo grid with upload, review state, reorder, replace and remove.
///
/// Every change is saved immediately. The server decides which photos are
/// approved and whether the profile is ready; this only shows its answers.
class PhotoEditor extends ConsumerStatefulWidget {
  const PhotoEditor({super.key, this.header, this.continueLabel, this.onContinue});

  final Widget? header;
  final String? continueLabel;
  final VoidCallback? onContinue;

  @override
  ConsumerState<PhotoEditor> createState() => _PhotoEditorState();
}

class _PhotoEditorState extends ConsumerState<PhotoEditor> {
  late final _api = ref.read(apiClientProvider);
  PhotoSet? _set;
  final _uploads = <_Upload>[];
  bool _busy = false;
  String? _error;

  Future<PhotoSet> _load() async {
    final set = await _api.getPhotos();
    _set = set;
    return set;
  }

  Future<void> _refresh() async {
    final set = await _api.getPhotos();
    if (mounted) setState(() => _set = set);
  }

  void _fail(Object error) {
    if (!mounted) return;
    setState(
      () => _error = describeFailure(
        context.l10n,
        error,
        maxPhotos: _set?.maxPhotos ?? 6,
      ),
    );
  }

  Future<void> _pickAndUpload({String? replaces}) async {
    setState(() => _error = null);
    final picked = await ref.read(photoPickerProvider).pick();
    if (picked == null || !mounted) return;
    final upload = _Upload(picked)..replaces = replaces;
    setState(() => _uploads.add(upload));
    await _upload(upload);
  }

  Future<void> _upload(_Upload upload) async {
    setState(() {
      upload.failed = false;
      _error = null;
    });
    try {
      await _api.uploadPhoto(
        bytes: upload.photo.bytes,
        filename: upload.photo.filename,
        idempotencyKey: upload.key,
      );
      final replaced = upload.replaces;
      if (replaced != null) await _api.deletePhoto(replaced);
      _uploads.remove(upload);
      await _refresh();
    } on Object catch (e) {
      final retryable =
          e is NetworkException || (e is ApiException && e.error.retryable);
      if (!mounted) return;
      if (retryable) {
        setState(() => upload.failed = true);
      } else {
        setState(() => _uploads.remove(upload));
        _fail(e);
      }
    }
  }

  Future<void> _move(OwnerPhoto photo, int delta) async {
    final set = _set!;
    final ids = set.active.map((p) => p.id).toList();
    final from = ids.indexOf(photo.id);
    final to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    ids
      ..removeAt(from)
      ..insert(to, photo.id);
    await _run(() async {
      try {
        await _api.reorderPhotos(expectedRevision: set.revision, photoIds: ids);
      } on ApiException catch (e) {
        if (!e.isRevisionConflict && e.code != 'PHOTO_SET_MISMATCH') rethrow;
        // Photos changed on another device: show the latest and say so
        await _refresh();
        if (mounted) setState(() => _error = context.l10n.conflictReloaded);
        return;
      }
      await _refresh();
    });
  }

  Future<void> _remove(OwnerPhoto photo) async {
    final set = _set!;
    final l10n = context.l10n;
    final dropsBelowMinimum =
        photo.state == PhotoState.approved &&
        set.approvedCount <= set.minPhotos;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(l10n.photoRemoveTitle),
        content: SingleChildScrollView(
          child: Text(
            dropsBelowMinimum
                ? l10n.photoRemoveBelowMinimum(set.minPhotos)
                : l10n.photoRemoveBody,
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: Text(l10n.commonCancel),
          ),
          TextButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(l10n.photoRemove),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    await _run(() async {
      await _api.deletePhoto(photo.id);
      await _refresh();
    });
  }

  Future<void> _run(Future<void> Function() action) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await action();
    } on Object catch (e) {
      _fail(e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AsyncLoader<PhotoSet>(
      load: _load,
      builder: (context, _, _) => _buildEditor(context, _set!),
    );
  }

  Widget _buildEditor(BuildContext context, PhotoSet set) {
    final l10n = context.l10n;
    final active = set.active;
    final canAdd = active.length + _uploads.length < set.maxPhotos;
    final error = _error;
    final textScale = MediaQuery.textScalerOf(context).scale(1);
    return ListView(
      padding: const EdgeInsets.all(LemonSpacing.lg),
      children: [
        ?widget.header,
        Text(
          l10n.photosCount(active.length, set.maxPhotos),
          style: LemonTypography.section,
        ),
        const SizedBox(height: LemonSpacing.sm),
        InlineMessage(message: l10n.photosReviewNote),
        const SizedBox(height: LemonSpacing.base),
        LayoutBuilder(
          builder: (context, constraints) {
            final columns = textScale >= 1.5 || constraints.maxWidth < 330
                ? 2
                : 3;
            const gap = LemonSpacing.md;
            final width = (constraints.maxWidth - gap * (columns - 1)) / columns;
            return Wrap(
              spacing: gap,
              runSpacing: gap,
              children: [
                for (final (index, photo) in active.indexed)
                  SizedBox(
                    width: width,
                    child: _PhotoTile(
                      photo: photo,
                      position: index + 1,
                      canMoveEarlier: index > 0 && !_busy,
                      canMoveLater: index < active.length - 1 && !_busy,
                      onMove: (delta) => _move(photo, delta),
                      onRemove: _busy ? null : () => _remove(photo),
                    ),
                  ),
                for (final upload in _uploads)
                  SizedBox(
                    width: width,
                    child: _UploadTile(
                      upload: upload,
                      onRetry: () => _upload(upload),
                      onDiscard: () => setState(() => _uploads.remove(upload)),
                    ),
                  ),
                if (canAdd)
                  SizedBox(
                    width: width,
                    child: _AddTile(onTap: _busy ? null : _pickAndUpload),
                  ),
              ],
            );
          },
        ),
        if (set.rejected.isNotEmpty) ...[
          const SizedBox(height: LemonSpacing.lg),
          Semantics(
            header: true,
            child: Text(
              l10n.photosRejectedSection,
              style: LemonTypography.section,
            ),
          ),
          const SizedBox(height: LemonSpacing.sm),
          for (final photo in set.rejected)
            _RejectedPhotoRow(
              photo: photo,
              onReplace: _busy || !canAdd
                  ? null
                  : () => _pickAndUpload(replaces: photo.id),
              onRemove: _busy ? null : () => _remove(photo),
            ),
        ],
        if (error != null) ...[
          const SizedBox(height: LemonSpacing.base),
          InlineMessage(message: error, tone: MessageTone.error),
        ],
        if (widget.onContinue case final onContinue?) ...[
          const SizedBox(height: LemonSpacing.lg),
          if (active.length < set.minPhotos) ...[
            InlineMessage(message: l10n.photosNeedMore(set.minPhotos)),
            const SizedBox(height: LemonSpacing.base),
          ],
          LemonButton(
            label: widget.continueLabel ?? l10n.commonContinue,
            onPressed: active.length >= set.minPhotos && _uploads.isEmpty
                ? onContinue
                : null,
          ),
        ],
      ],
    );
  }
}

/// Labeled review state for a photo.
StatusBadge photoStateBadge(AppLocalizations l10n, PhotoState state) =>
    switch (state) {
      PhotoState.processing => StatusBadge(
        label: l10n.photoStateProcessing,
        icon: Icons.hourglass_empty,
      ),
      PhotoState.pending => StatusBadge(
        label: l10n.photoStatePending,
        icon: Icons.schedule,
      ),
      PhotoState.approved => StatusBadge(
        label: l10n.photoStateApproved,
        icon: Icons.check_circle_outline,
        color: LemonColors.success,
      ),
      PhotoState.rejected => StatusBadge(
        label: l10n.photoStateRejected,
        icon: Icons.error_outline,
        color: LemonColors.error,
      ),
    };

enum _PhotoAction { earlier, later, remove }

class _PhotoTile extends StatelessWidget {
  const _PhotoTile({
    required this.photo,
    required this.position,
    required this.canMoveEarlier,
    required this.canMoveLater,
    required this.onMove,
    required this.onRemove,
  });

  final OwnerPhoto photo;
  final int position;
  final bool canMoveEarlier;
  final bool canMoveLater;
  final ValueChanged<int> onMove;
  final VoidCallback? onRemove;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final media = photo.media;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(LemonRadius.input),
          child: AspectRatio(
            aspectRatio: 3 / 4,
            child: media == null
                ? const ColoredBox(
                    color: LemonColors.softAccent,
                    child: Center(child: CircularProgressIndicator()),
                  )
                : MediaImage(
                    path: media.thumb,
                    semanticLabel: l10n.photoPosition(position),
                  ),
          ),
        ),
        const SizedBox(height: LemonSpacing.xs),
        Row(
          children: [
            Expanded(child: photoStateBadge(l10n, photo.state)),
            PopupMenuButton<_PhotoAction>(
              tooltip: l10n.photoOptions(position),
              onSelected: (action) => switch (action) {
                _PhotoAction.earlier => onMove(-1),
                _PhotoAction.later => onMove(1),
                _PhotoAction.remove => onRemove?.call(),
              },
              itemBuilder: (context) => [
                PopupMenuItem(
                  value: _PhotoAction.earlier,
                  enabled: canMoveEarlier,
                  child: Text(l10n.photoMoveEarlier),
                ),
                PopupMenuItem(
                  value: _PhotoAction.later,
                  enabled: canMoveLater,
                  child: Text(l10n.photoMoveLater),
                ),
                PopupMenuItem(
                  value: _PhotoAction.remove,
                  enabled: onRemove != null,
                  child: Text(l10n.photoRemove),
                ),
              ],
            ),
          ],
        ),
      ],
    );
  }
}

class _UploadTile extends StatelessWidget {
  const _UploadTile({
    required this.upload,
    required this.onRetry,
    required this.onDiscard,
  });

  final _Upload upload;
  final VoidCallback onRetry;
  final VoidCallback onDiscard;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(LemonRadius.input),
          child: AspectRatio(
            aspectRatio: 3 / 4,
            child: Stack(
              fit: StackFit.expand,
              children: [
                Image.memory(
                  upload.photo.bytes,
                  fit: BoxFit.cover,
                  excludeFromSemantics: true,
                  errorBuilder: (_, _, _) =>
                      const ColoredBox(color: LemonColors.softAccent),
                ),
                if (!upload.failed)
                  const ColoredBox(
                    color: Color(0x66FFFFFF),
                    child: Center(child: CircularProgressIndicator()),
                  ),
              ],
            ),
          ),
        ),
        const SizedBox(height: LemonSpacing.xs),
        if (upload.failed) ...[
          InlineMessage(message: l10n.photoUploadFailed, tone: MessageTone.error),
          TextButton(onPressed: onRetry, child: Text(l10n.commonRetry)),
          TextButton(onPressed: onDiscard, child: Text(l10n.commonRemove)),
        ] else
          Semantics(
            liveRegion: true,
            child: Text(l10n.photoUploading, style: LemonTypography.caption),
          ),
      ],
    );
  }
}

class _AddTile extends StatelessWidget {
  const _AddTile({required this.onTap});

  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return Semantics(
      button: true,
      label: l10n.photosAdd,
      excludeSemantics: true,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(LemonRadius.input),
        child: AspectRatio(
          aspectRatio: 3 / 4,
          child: DecoratedBox(
            decoration: BoxDecoration(
              color: LemonColors.surface,
              borderRadius: BorderRadius.circular(LemonRadius.input),
              border: Border.all(color: LemonColors.accent),
            ),
            child: Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.add_a_photo_outlined, color: LemonColors.primary),
                  const SizedBox(height: LemonSpacing.xs),
                  Flexible(
                    child: Text(
                      l10n.photosAdd,
                      textAlign: TextAlign.center,
                      overflow: TextOverflow.ellipsis,
                      maxLines: 2,
                      style: LemonTypography.caption.copyWith(
                        color: LemonColors.primary,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _RejectedPhotoRow extends StatelessWidget {
  const _RejectedPhotoRow({
    required this.photo,
    required this.onReplace,
    required this.onRemove,
  });

  final OwnerPhoto photo;
  final VoidCallback? onReplace;
  final VoidCallback? onRemove;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final media = photo.media;
    return Padding(
      padding: const EdgeInsets.only(bottom: LemonSpacing.base),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 72,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(LemonRadius.input),
              child: AspectRatio(
                aspectRatio: 3 / 4,
                child: media == null
                    ? const ColoredBox(color: LemonColors.softAccent)
                    : MediaImage(path: media.thumb),
              ),
            ),
          ),
          const SizedBox(width: LemonSpacing.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                photoStateBadge(l10n, photo.state),
                const SizedBox(height: LemonSpacing.xs),
                Text(
                  rejectionMessage(l10n, photo.rejectionReason),
                  style: LemonTypography.body,
                ),
                Wrap(
                  children: [
                    TextButton(onPressed: onReplace, child: Text(l10n.photoReplace)),
                    TextButton(onPressed: onRemove, child: Text(l10n.photoRemove)),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
