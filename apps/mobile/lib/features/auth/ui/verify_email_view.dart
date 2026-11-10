import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/l10n/l10n.dart';
import '../../../core/theme/lemon_spacing.dart';
import '../../../core/theme/lemon_typography.dart';
import '../../../core/widgets/inline_message.dart';
import '../../../core/widgets/lemon_button.dart';
import '../../profile/ui/form_host.dart';
import '../application/auth_controller.dart';
import 'auth_messages.dart';
import 'auth_widgets.dart';

/// Shown while Firebase has not confirmed the email address.
class VerifyEmailScreen extends ConsumerWidget {
  const VerifyEmailScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return AuthPage(
      showAppBar: false,
      children: [
        VerifyEmailView(
          onCheck: ref.read(authControllerProvider.notifier).refreshVerification,
        ),
      ],
    );
  }
}

/// "Check your inbox" content: "I've verified" (reloads the Firebase user),
/// resend with a cooldown, and a way out to another account. Also used by
/// the onboarding step when the server still lacks the verified claim.
class VerifyEmailView extends ConsumerStatefulWidget {
  const VerifyEmailView({super.key, required this.onCheck});

  /// Re-checks verification; returns true once verified (the caller moves
  /// on). Errors are shown here.
  final Future<bool> Function() onCheck;

  @override
  ConsumerState<VerifyEmailView> createState() => _VerifyEmailViewState();
}

class _VerifyEmailViewState extends ConsumerState<VerifyEmailView> {
  bool _checking = false;
  bool _resending = false;
  String? _message;
  MessageTone _tone = MessageTone.info;
  int _waitSeconds = 0;
  Timer? _ticker;

  AuthController get _controller => ref.read(authControllerProvider.notifier);

  @override
  void initState() {
    super.initState();
    _syncCooldown();
  }

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  int _secondsLeft() =>
      (_controller.resendWaitRemaining().inMilliseconds / 1000).ceil();

  void _syncCooldown() {
    _ticker?.cancel();
    _waitSeconds = _secondsLeft();
    if (_waitSeconds <= 0) return;
    _ticker = Timer.periodic(const Duration(seconds: 1), (timer) {
      final left = _secondsLeft();
      if (left <= 0) timer.cancel();
      if (mounted) setState(() => _waitSeconds = left);
    });
  }

  void _show(String message, MessageTone tone) => setState(() {
    _message = message;
    _tone = tone;
  });

  Future<void> _check() async {
    final l10n = context.l10n;
    setState(() {
      _checking = true;
      _message = null;
    });
    try {
      final verified = await widget.onCheck();
      if (!verified && mounted) {
        _show(l10n.verifyEmailStillMissing, MessageTone.error);
      }
    } on Object catch (e) {
      if (mounted) _show(describeAuthError(l10n, e), MessageTone.error);
    } finally {
      if (mounted) setState(() => _checking = false);
    }
  }

  Future<void> _resend() async {
    final l10n = context.l10n;
    setState(() {
      _resending = true;
      _message = null;
    });
    try {
      await _controller.resendVerificationEmail();
      if (mounted) {
        _show(l10n.verifyEmailResent, MessageTone.success);
        setState(_syncCooldown);
      }
    } on Object catch (e) {
      if (mounted) _show(describeAuthError(l10n, e), MessageTone.error);
    } finally {
      if (mounted) setState(() => _resending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final email = ref.watch(authControllerProvider.select((s) => s.user?.email));
    final message = _message;
    final waiting = _waitSeconds > 0;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SectionHeader(
          title: l10n.verifyEmailTitle,
          subtitle: email == null
              ? l10n.verifyEmailBody
              : l10n.verifyEmailSentTo(email),
        ),
        Text(l10n.verifyEmailSpamHint, style: LemonTypography.caption),
        const SizedBox(height: LemonSpacing.lg),
        if (message != null) ...[
          InlineMessage(message: message, tone: _tone),
          const SizedBox(height: LemonSpacing.base),
        ],
        LemonButton(
          label: l10n.verifyEmailCheck,
          onPressed: _check,
          isLoading: _checking,
        ),
        const SizedBox(height: LemonSpacing.md),
        Semantics(
          liveRegion: waiting,
          child: LemonButton(
            label: waiting
                ? l10n.verifyEmailResendIn(_waitSeconds)
                : l10n.verifyEmailResend,
            isOutlined: true,
            onPressed: waiting || _resending ? null : _resend,
          ),
        ),
        const SizedBox(height: LemonSpacing.base),
        TextButton(
          onPressed: () => ref.read(authControllerProvider.notifier).signOut(),
          child: Text(l10n.verifyEmailOtherAccount),
        ),
      ],
    );
  }
}

/// Signed-out screen after the session stopped working.
class SessionExpiredScreen extends StatelessWidget {
  const SessionExpiredScreen({super.key, required this.onSignIn});

  final VoidCallback onSignIn;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return AuthPage(
      showAppBar: false,
      children: [
        const SizedBox(height: LemonSpacing.xl),
        const Wordmark(),
        const SizedBox(height: LemonSpacing.xl),
        SectionHeader(
          title: l10n.sessionExpiredTitle,
          subtitle: l10n.sessionExpiredBody,
        ),
        LemonButton(label: l10n.sessionExpiredSignIn, onPressed: onSignIn),
      ],
    );
  }
}
