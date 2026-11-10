import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/providers.dart';
import '../../../core/catalogs/catalogs.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/theme/lemon_colors.dart';
import '../../../core/theme/lemon_spacing.dart';
import '../../../core/theme/lemon_typography.dart';
import '../../../core/widgets/async_loader.dart';
import '../../../core/widgets/inline_message.dart';
import '../../../core/widgets/media_image.dart';
import '../../../core/widgets/prompt_tile.dart';
import '../data/photos.dart';
import '../data/profile.dart';
import 'profile_forms.dart';

/// A profile as other people see it: the same presentation Discover will
/// use. Only fields present in the public projection are shown.
class PublicProfileView extends StatelessWidget {
  const PublicProfileView({
    super.key,
    required this.profile,
    required this.photoPaths,
    this.catalogs,
    this.showLikeActions = false,
  });

  final PublicProfile profile;

  /// Display paths of approved photos, in order.
  final List<String> photoPaths;
  final Catalogs? catalogs;
  final bool showLikeActions;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final name = profile.displayName;
    final city = profile.cityName;
    final state = profile.stateCode;
    final age = profile.age;
    final prompts = profile.promptAnswers;
    final photos = photoPaths;

    // Alternate photos and prompts after the lead photo
    final items = <Widget>[];
    final rest = photos.skip(1).toList();
    for (var i = 0; i < prompts.length || i < rest.length; i++) {
      if (i < prompts.length) {
        items.add(
          PromptTile(
            question: prompts[i].promptText,
            answer: prompts[i].text,
            showLike: showLikeActions,
          ),
        );
      }
      if (i < rest.length) {
        items.add(_Photo(path: rest[i], label: l10n.photoPosition(i + 2)));
      }
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (photos.isNotEmpty)
          _Photo(path: photos.first, label: l10n.photoPosition(1))
        else
          InlineMessage(message: l10n.previewNoPhotos),
        const SizedBox(height: LemonSpacing.base),
        Semantics(
          header: true,
          child: Text(
            switch ((name, age)) {
              (final String name, final int age) => l10n.previewNameAge(
                name,
                age,
              ),
              (final String name, null) => name,
              _ => l10n.previewNoName,
            },
            style: LemonTypography.title,
          ),
        ),
        if (city != null && state != null)
          Text(l10n.cityState(city, state), style: LemonTypography.body),
        if (profile.intentionLabel case final intention?) ...[
          const SizedBox(height: LemonSpacing.sm),
          Align(
            alignment: Alignment.centerLeft,
            child: Chip(
              label: Text(intention),
              backgroundColor: LemonColors.softAccent,
              side: BorderSide.none,
            ),
          ),
        ],
        const SizedBox(height: LemonSpacing.base),
        if (profile.bio case final bio?) ...[
          Text(bio, style: LemonTypography.body),
          const SizedBox(height: LemonSpacing.base),
        ],
        ..._facts(l10n),
        for (final item in items) ...[
          const SizedBox(height: LemonSpacing.base),
          item,
        ],
      ],
    );
  }

  List<Widget> _facts(AppLocalizations l10n) {
    final languageLabels = {
      for (final option in catalogs?.languages ?? const <CatalogOption>[])
        option.id: option.label,
    };
    final languages = [
      for (final id in profile.languages) ?languageLabels[id],
    ];
    final height = profile.height;
    final facts = <(String, String)>[
      if (profile.genderLabel case final v?) (l10n.genderLabel, v),
      if (profile.hometown case final v?) (l10n.hometownLabel, v),
      if (profile.occupation case final v?) (l10n.occupationLabel, v),
      if (profile.education case final v?) (l10n.educationLabel, v),
      if (height != null) (l10n.heightLabel, heightLabel(l10n, height)),
      if (languages.isNotEmpty) (l10n.languagesLabel, languages.join(', ')),
      if (profile.religion case final v?) (l10n.religionLabel, v),
    ];
    return [
      for (final (label, value) in facts)
        Padding(
          padding: const EdgeInsets.only(bottom: LemonSpacing.sm),
          child: MergeSemantics(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label, style: LemonTypography.caption),
                Text(value, style: LemonTypography.body),
              ],
            ),
          ),
        ),
    ];
  }
}

class _Photo extends StatelessWidget {
  const _Photo({required this.path, required this.label});

  final String path;
  final String label;

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(LemonRadius.card),
      child: AspectRatio(
        aspectRatio: 4 / 5,
        child: MediaImage(path: path, semanticLabel: label),
      ),
    );
  }
}

/// The owner's profile exactly as others see it, from
/// `GET /v1/me/profile/preview` plus approved photos.
class ProfilePreviewScreen extends ConsumerWidget {
  const ProfilePreviewScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final api = ref.read(apiClientProvider);
    final catalogs = ref.read(catalogsRepositoryProvider);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.previewTitle)),
      body: SafeArea(
        child: AsyncLoader<(PublicProfile, PhotoSet, Catalogs)>(
          load: () async => (
            await api.getProfilePreview(),
            await api.getPhotos(),
            await catalogs.load(),
          ),
          builder: (context, data, _) {
            final (preview, photos, catalogData) = data;
            final approved = [
              for (final photo in photos.active)
                if (photo.state == PhotoState.approved)
                  if (photo.media case final media?) media.display,
            ];
            return ListView(
              padding: const EdgeInsets.all(LemonSpacing.lg),
              children: [
                InlineMessage(message: l10n.previewNote),
                const SizedBox(height: LemonSpacing.base),
                PublicProfileView(
                  profile: preview,
                  photoPaths: approved,
                  catalogs: catalogData,
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}
