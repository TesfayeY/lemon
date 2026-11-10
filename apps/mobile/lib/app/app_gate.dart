import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api/api_exception.dart';
import '../core/l10n/l10n.dart';
import '../core/theme/lemon_spacing.dart';
import '../core/widgets/async_loader.dart';
import '../core/widgets/state_views.dart';
import '../features/onboarding/data/account.dart';
import '../features/onboarding/ui/onboarding_flow.dart';
import '../features/profile/ui/form_host.dart';
import 'config.dart';
import 'providers.dart';
import 'shell.dart';

/// Decides what to show from the server's account snapshot: onboarding for
/// accounts still onboarding, the app for active ones, and an explanation for
/// restricted ones. The client never grants access on its own.
class AppGate extends ConsumerStatefulWidget {
  const AppGate({super.key});

  @override
  ConsumerState<AppGate> createState() => _AppGateState();
}

class _AppGateState extends ConsumerState<AppGate> {
  late Future<Account> _account = _load();

  Future<Account> _load() async {
    final api = ref.read(apiClientProvider);
    await api.bootstrap();
    return api.getAccount();
  }

  void _reload() {
    final next = _load();
    setState(() {
      _account = next;
    });
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<Account>(
      future: _account,
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return Scaffold(
            body: LemonLoadingView(message: context.l10n.commonLoading),
          );
        }
        final error = snapshot.error;
        if (error is NotSignedInException) {
          return const _MessageScreen(kind: _GateMessage.signedOut);
        }
        if (error is ApiException && error.code == 'ACCOUNT_RESTRICTED') {
          return const _MessageScreen(kind: _GateMessage.restricted);
        }
        if (error != null) {
          return Scaffold(
            body: SafeArea(child: FailureView(error: error, onRetry: _reload)),
          );
        }
        final account = snapshot.data!;
        return switch (account.accountStatus) {
          AccountStatus.onboarding => OnboardingFlow(
            initialAccount: account,
            onFinished: _reload,
          ),
          AccountStatus.active => const AppShell(),
          AccountStatus.suspended ||
          AccountStatus.deletionPending ||
          AccountStatus.deleted => const _MessageScreen(
            kind: _GateMessage.restricted,
          ),
        };
      },
    );
  }
}

enum _GateMessage { signedOut, restricted }

class _MessageScreen extends StatelessWidget {
  const _MessageScreen({required this.kind});

  final _GateMessage kind;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final (title, body) = switch (kind) {
      _GateMessage.signedOut => (
        l10n.gateSignedOutTitle,
        l10n.gateSignedOutBody(appName),
      ),
      _GateMessage.restricted => (
        l10n.gateRestrictedTitle,
        l10n.gateRestrictedBody,
      ),
    };
    return Scaffold(
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(LemonSpacing.lg),
          children: [SectionHeader(title: title, subtitle: body)],
        ),
      ),
    );
  }
}
