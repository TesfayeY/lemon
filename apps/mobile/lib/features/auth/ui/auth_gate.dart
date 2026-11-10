import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/app_gate.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/widgets/state_views.dart';
import '../application/auth_controller.dart';
import 'sign_in_screen.dart';
import 'verify_email_view.dart';
import 'welcome_screen.dart';

/// Root of the app: signed out → welcome and sign-in screens; unverified →
/// verify email; signed in → [AppGate] (server bootstrap, then onboarding or
/// the main app). Firebase decides who is signed in; the server decides
/// everything after that.
class AuthGate extends ConsumerWidget {
  const AuthGate({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Any session change replaces the whole stack, so pushed sign-in or
    // settings screens never linger above the new state
    ref.listen(authControllerProvider.select((s) => s.status), (previous, next) {
      if (previous != next) {
        Navigator.of(context).popUntil((route) => route.isFirst);
      }
    });
    final status = ref.watch(authControllerProvider.select((s) => s.status));
    return switch (status) {
      SessionStatus.starting => Scaffold(
        body: LemonLoadingView(message: context.l10n.commonLoading),
      ),
      SessionStatus.signedOut => const WelcomeScreen(),
      SessionStatus.expired => SessionExpiredScreen(
        onSignIn: () => openSignIn(context),
      ),
      SessionStatus.unverified => const VerifyEmailScreen(),
      SessionStatus.signedIn => const AppGate(),
    };
  }
}
