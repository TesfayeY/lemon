import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/providers.dart';
import '../../../core/catalogs/catalogs.dart';
import '../../../core/widgets/async_loader.dart';
import '../data/preferences.dart';
import '../data/profile.dart';
import 'form_host.dart';
import 'profile_forms.dart';

/// Profile form sections shared by onboarding and the You tab.
enum ProfileSection { basics, location, about }

/// Loads the profile and catalogs, shows one section's form and saves it.
/// Used unchanged by onboarding (with "Continue") and editing (with "Save").
class ProfileSectionEditor extends ConsumerWidget {
  const ProfileSectionEditor({
    super.key,
    required this.section,
    required this.submitLabel,
    required this.onSaved,
    this.header,
    this.skipLabel,
  });

  final ProfileSection section;
  final String submitLabel;
  final ValueChanged<SelfProfile> onSaved;
  final Widget? header;
  final String? skipLabel;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final api = ref.read(apiClientProvider);
    final catalogs = ref.read(catalogsRepositoryProvider);
    final showSensitive = ref.read(appConfigProvider).showSensitiveFields;
    return AsyncLoader<(SelfProfile, Catalogs)>(
      load: () async => (await api.getProfile(), await catalogs.load()),
      builder: (context, data, _) => RevisionedFormHost<SelfProfile>(
        initial: data.$1,
        revisionOf: (p) => p.revision,
        toJson: (p) => p.toJson(),
        send: (revision, changes) =>
            api.updateProfile(expectedRevision: revision, changes: changes),
        reload: api.getProfile,
        submitLabel: submitLabel,
        onSaved: onSaved,
        header: header,
        skipLabel: skipLabel,
        formBuilder: (context, profile, key, serverErrors) => switch (section) {
          ProfileSection.basics => BasicsForm(
            key: key,
            profile: profile,
            catalogs: data.$2,
            serverErrors: serverErrors,
          ),
          ProfileSection.location => LocationForm(
            key: key,
            profile: profile,
            catalogs: data.$2,
            serverErrors: serverErrors,
          ),
          ProfileSection.about => AboutForm(
            key: key,
            profile: profile,
            catalogs: data.$2,
            showSensitiveFields: showSensitive,
            serverErrors: serverErrors,
          ),
        },
      ),
    );
  }
}

/// Loads, edits and saves dating preferences.
class PreferencesEditor extends ConsumerWidget {
  const PreferencesEditor({
    super.key,
    required this.submitLabel,
    required this.onSaved,
    this.header,
  });

  final String submitLabel;
  final ValueChanged<Preferences> onSaved;
  final Widget? header;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final api = ref.read(apiClientProvider);
    final catalogs = ref.read(catalogsRepositoryProvider);
    return AsyncLoader<(Preferences, Catalogs)>(
      load: () async => (await api.getPreferences(), await catalogs.load()),
      builder: (context, data, _) => RevisionedFormHost<Preferences>(
        initial: data.$1,
        revisionOf: (p) => p.revision,
        toJson: (p) => p.toJson(),
        send: (revision, changes) =>
            api.updatePreferences(expectedRevision: revision, changes: changes),
        reload: api.getPreferences,
        submitLabel: submitLabel,
        onSaved: onSaved,
        header: header,
        formBuilder: (context, prefs, key, serverErrors) => PreferencesForm(
          key: key,
          preferences: prefs,
          catalogs: data.$2,
          serverErrors: serverErrors,
        ),
      ),
    );
  }
}
