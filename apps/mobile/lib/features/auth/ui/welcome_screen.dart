import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/config.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/theme/lemon_spacing.dart';
import '../../../core/theme/lemon_typography.dart';
import '../../../core/widgets/inline_message.dart';
import '../../../core/widgets/lemon_button.dart';
import '../application/auth_controller.dart';
import 'auth_widgets.dart';
import 'create_account_screen.dart';
import 'sign_in_screen.dart';

/// First screen when signed out: wordmark, value statement, adult-only note
/// and the create-account / sign-in actions.
class WelcomeScreen extends ConsumerWidget {
  const WelcomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final configured = ref.watch(authRepositoryProvider).isConfigured;
    return AuthPage(
      showAppBar: false,
      children: [
        const SizedBox(height: LemonSpacing.xl),
        const Wordmark(),
        const SizedBox(height: LemonSpacing.lg),
        Text(l10n.welcomeTagline, style: LemonTypography.section),
        const SizedBox(height: LemonSpacing.md),
        Text(l10n.birthDateAdultOnly(appName), style: LemonTypography.body),
        const SizedBox(height: LemonSpacing.xl),
        if (!configured) ...[
          InlineMessage(message: l10n.authNotConfigured),
          const SizedBox(height: LemonSpacing.base),
        ],
        LemonButton(
          label: l10n.welcomeCreateAccount,
          onPressed: () => openCreateAccount(context),
        ),
        const SizedBox(height: LemonSpacing.md),
        LemonButton(
          label: l10n.welcomeSignIn,
          isOutlined: true,
          onPressed: () => openSignIn(context),
        ),
        const SizedBox(height: LemonSpacing.lg),
        Text(l10n.termsDraftNote, style: LemonTypography.caption),
      ],
    );
  }
}
