import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/providers.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/theme/lemon_colors.dart';
import '../../../core/theme/lemon_spacing.dart';
import '../../../core/theme/lemon_typography.dart';
import '../../../core/widgets/async_loader.dart';
import '../../../core/widgets/inline_message.dart';
import '../../../core/widgets/lemon_card.dart';
import '../../auth/application/auth_controller.dart';
import '../../auth/ui/auth_widgets.dart';
import '../../onboarding/data/account.dart';
import '../../onboarding/ui/readiness_view.dart';
import '../data/profile.dart';
import 'photo_editor.dart';
import 'prompt_editor.dart';
import 'public_profile_view.dart';
import 'section_editors.dart';

/// The You tab: own profile, server-reported visibility, and entry points to
/// edit each section with the same forms used in onboarding.
class YouScreen extends ConsumerStatefulWidget {
  const YouScreen({super.key});

  @override
  ConsumerState<YouScreen> createState() => _YouScreenState();
}

class _YouScreenState extends ConsumerState<YouScreen> {
  int _generation = 0;

  Future<void> _open(Widget screen) async {
    await Navigator.of(
      context,
    ).push(MaterialPageRoute<void>(builder: (_) => screen));
    // Reload so status and summary reflect what the server saved
    if (mounted) setState(() => _generation++);
  }

  @override
  Widget build(BuildContext context) {
    final api = ref.read(apiClientProvider);
    final l10n = context.l10n;
    return AsyncLoader<(Account, SelfProfile)>(
      key: ValueKey(_generation),
      load: () async => (await api.getAccount(), await api.getProfile()),
      builder: (context, data, reload) {
        final (account, profile) = data;
        final city = profile.cityName;
        final state = profile.stateCode;
        return RefreshIndicator(
          onRefresh: reload,
          child: ListView(
            padding: const EdgeInsets.all(LemonSpacing.lg),
            children: [
              Semantics(
                header: true,
                child: Text(
                  profile.displayName ?? l10n.youNameFallback,
                  style: LemonTypography.title,
                ),
              ),
              if (city != null && state != null)
                Text(l10n.cityState(city, state), style: LemonTypography.body),
              const SizedBox(height: LemonSpacing.base),
              _StatusCard(account: account),
              const SizedBox(height: LemonSpacing.lg),
              Semantics(
                header: true,
                child: Text(
                  l10n.youSectionProfile,
                  style: LemonTypography.section,
                ),
              ),
              const SizedBox(height: LemonSpacing.sm),
              _EditTile(
                icon: Icons.visibility_outlined,
                title: l10n.youPreview,
                onTap: () => _open(const ProfilePreviewScreen()),
              ),
              _EditTile(
                icon: Icons.photo_library_outlined,
                title: l10n.youEditPhotos,
                onTap: () => _open(
                  _EditScaffold(title: l10n.youEditPhotos, child: const PhotoEditor()),
                ),
              ),
              _EditTile(
                icon: Icons.format_quote_outlined,
                title: l10n.youEditPrompts,
                onTap: () => _open(
                  _EditScaffold(
                    title: l10n.youEditPrompts,
                    child: const PromptEditor(),
                  ),
                ),
              ),
              _EditTile(
                icon: Icons.badge_outlined,
                title: l10n.youEditBasics,
                onTap: () => _open(_sectionScreen(ProfileSection.basics)),
              ),
              _EditTile(
                icon: Icons.location_city_outlined,
                title: l10n.youEditLocation,
                onTap: () => _open(_sectionScreen(ProfileSection.location)),
              ),
              _EditTile(
                icon: Icons.tune,
                title: l10n.youEditPreferences,
                onTap: () => _open(
                  _EditScaffold(
                    title: l10n.youEditPreferences,
                    child: Builder(
                      builder: (context) => PreferencesEditor(
                        submitLabel: l10n.commonSave,
                        onSaved: (_) => _savedAndClose(context),
                      ),
                    ),
                  ),
                ),
              ),
              _EditTile(
                icon: Icons.person_outline,
                title: l10n.youEditAbout,
                onTap: () => _open(_sectionScreen(ProfileSection.about)),
              ),
              const SizedBox(height: LemonSpacing.lg),
              const _AccountSection(),
            ],
          ),
        );
      },
    );
  }

  Widget _sectionScreen(ProfileSection section) {
    final l10n = context.l10n;
    final title = switch (section) {
      ProfileSection.basics => l10n.youEditBasics,
      ProfileSection.location => l10n.youEditLocation,
      ProfileSection.about => l10n.youEditAbout,
    };
    return _EditScaffold(
      title: title,
      child: Builder(
        builder: (context) => ProfileSectionEditor(
          section: section,
          submitLabel: l10n.commonSave,
          onSaved: (_) => _savedAndClose(context),
        ),
      ),
    );
  }

  void _savedAndClose(BuildContext context) {
    final messenger = ScaffoldMessenger.maybeOf(context);
    Navigator.of(context).pop();
    messenger?.showSnackBar(SnackBar(content: Text(context.l10n.commonSaved)));
  }
}

class _StatusCard extends StatelessWidget {
  const _StatusCard({required this.account});

  final Account account;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final readiness = account.readiness;
    return LemonCard(
      margin: EdgeInsets.zero,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              ExcludeSemantics(
                child: Icon(
                  readiness.ready
                      ? Icons.check_circle_outline
                      : Icons.visibility_off_outlined,
                  color: readiness.ready
                      ? LemonColors.success
                      : LemonColors.textSecondary,
                ),
              ),
              const SizedBox(width: LemonSpacing.sm),
              Expanded(
                child: Text(
                  readiness.ready ? l10n.youStatusLive : l10n.youStatusHidden,
                  style: LemonTypography.section,
                ),
              ),
            ],
          ),
          const SizedBox(height: LemonSpacing.sm),
          Text(
            readiness.ready ? l10n.youStatusLiveBody : l10n.youStatusHiddenBody,
            style: LemonTypography.body,
          ),
          if (!readiness.ready)
            for (final requirement in readiness.missing)
              Padding(
                padding: const EdgeInsets.only(top: LemonSpacing.xs),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const ExcludeSemantics(
                      child: Padding(
                        padding: EdgeInsets.only(top: 4),
                        child: Icon(Icons.circle_outlined, size: 14),
                      ),
                    ),
                    const SizedBox(width: LemonSpacing.sm),
                    Expanded(
                      child: Text(
                        requirementLabel(l10n, requirement),
                        style: LemonTypography.body,
                      ),
                    ),
                  ],
                ),
              ),
          if (account.discoverPaused) ...[
            const SizedBox(height: LemonSpacing.sm),
            InlineMessage(message: l10n.youPaused),
          ],
        ],
      ),
    );
  }
}

/// Settings live inside You: the sign-in email (shown only to its owner)
/// and sign out.
class _AccountSection extends ConsumerWidget {
  const _AccountSection();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final email = ref.watch(
      authControllerProvider.select((s) => s.user?.email),
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Semantics(
          header: true,
          child: Text(l10n.youSectionAccount, style: LemonTypography.section),
        ),
        if (email != null) ...[
          const SizedBox(height: LemonSpacing.sm),
          Text(l10n.youSignedInAs(email), style: LemonTypography.body),
        ],
        const SizedBox(height: LemonSpacing.sm),
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.logout, color: LemonColors.primary),
          title: Text(l10n.signOut),
          onTap: () => confirmSignOut(context, ref),
        ),
      ],
    );
  }
}

class _EditTile extends StatelessWidget {
  const _EditTile({
    required this.icon,
    required this.title,
    required this.onTap,
  });

  final IconData icon;
  final String title;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: Icon(icon, color: LemonColors.primary),
      title: Text(title),
      trailing: const Icon(Icons.chevron_right),
      onTap: onTap,
    );
  }
}

class _EditScaffold extends StatelessWidget {
  const _EditScaffold({required this.title, required this.child});

  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(title)),
      body: SafeArea(child: child),
    );
  }
}
