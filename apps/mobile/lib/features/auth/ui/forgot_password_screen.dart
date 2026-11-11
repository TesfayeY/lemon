import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/l10n/l10n.dart';
import '../../../core/theme/lemon_spacing.dart';
import '../../../core/widgets/inline_message.dart';
import '../../../core/widgets/lemon_button.dart';
import '../../../core/widgets/lemon_text_field.dart';
import '../../profile/ui/form_host.dart';
import '../application/auth_controller.dart';
import 'auth_messages.dart';
import 'auth_widgets.dart';

/// Sends a Firebase password reset link. The confirmation is the same
/// whether or not an account uses the address.
class ForgotPasswordScreen extends ConsumerStatefulWidget {
  const ForgotPasswordScreen({super.key, this.initialEmail = ''});

  final String initialEmail;

  @override
  ConsumerState<ForgotPasswordScreen> createState() =>
      _ForgotPasswordScreenState();
}

class _ForgotPasswordScreenState extends ConsumerState<ForgotPasswordScreen> {
  late final _email = TextEditingController(text: widget.initialEmail.trim());
  bool _attempted = false;
  bool _busy = false;
  String? _error;
  String? _sentTo;

  @override
  void dispose() {
    _email.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final l10n = context.l10n;
    setState(() {
      _attempted = true;
      _error = null;
    });
    if (emailError(l10n, _email.text) != null) return;
    setState(() => _busy = true);
    final email = _email.text.trim();
    try {
      await ref.read(authControllerProvider.notifier).sendPasswordReset(email);
      if (mounted) setState(() => _sentTo = email);
    } on Object catch (e) {
      if (mounted) setState(() => _error = describeAuthError(l10n, e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final sentTo = _sentTo;
    if (sentTo != null) {
      // A new page (and scroll position) so the confirmation starts at the top
      return AuthPage(
        key: const ValueKey('reset-sent'),
        children: [
          SectionHeader(title: l10n.forgotSentTitle),
          InlineMessage(
            message: l10n.forgotSent(sentTo),
            tone: MessageTone.success,
          ),
          const SizedBox(height: LemonSpacing.lg),
          LemonButton(
            label: l10n.forgotBackToSignIn,
            onPressed: () => Navigator.of(context).pop(),
          ),
        ],
      );
    }
    final error = _error;
    return AuthPage(
      children: [
        SectionHeader(title: l10n.forgotTitle, subtitle: l10n.forgotBody),
        LemonTextField(
          label: l10n.authEmailLabel,
          controller: _email,
          keyboardType: TextInputType.emailAddress,
          autofillHints: const [AutofillHints.email],
          autocorrect: false,
          textInputAction: TextInputAction.send,
          onSubmitted: (_) => _submit(),
          errorText: _attempted ? emailError(l10n, _email.text) : null,
          onChanged: (_) => setState(() {}),
        ),
        const SizedBox(height: LemonSpacing.lg),
        if (error != null) ...[
          InlineMessage(message: error, tone: MessageTone.error),
          const SizedBox(height: LemonSpacing.base),
        ],
        LemonButton(
          label: l10n.forgotSubmit,
          onPressed: _submit,
          isLoading: _busy,
        ),
      ],
    );
  }
}
