import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
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
import 'create_account_screen.dart';
import 'forgot_password_screen.dart';

void openSignIn(BuildContext context) => Navigator.of(context).push(
  MaterialPageRoute<void>(builder: (_) => const SignInScreen()),
);

/// Email and password sign-in. On success the app gate moves on by itself
/// (verify email, or the server bootstrap).
class SignInScreen extends ConsumerStatefulWidget {
  const SignInScreen({super.key});

  @override
  ConsumerState<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends ConsumerState<SignInScreen> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _attempted = false;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final l10n = context.l10n;
    setState(() {
      _attempted = true;
      _error = null;
    });
    if (emailError(l10n, _email.text) != null || _password.text.isEmpty) {
      return;
    }
    setState(() => _busy = true);
    try {
      await ref
          .read(authControllerProvider.notifier)
          .signIn(email: _email.text, password: _password.text);
      TextInput.finishAutofillContext();
    } on Object catch (e) {
      if (mounted) setState(() => _error = describeAuthError(l10n, e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final error = _error;
    return AuthPage(
      children: [
        SectionHeader(title: l10n.signInTitle),
        AutofillGroup(
          child: Column(
            children: [
              LemonTextField(
                label: l10n.authEmailLabel,
                controller: _email,
                keyboardType: TextInputType.emailAddress,
                autofillHints: const [AutofillHints.email],
                autocorrect: false,
                textInputAction: TextInputAction.next,
                errorText: _attempted ? emailError(l10n, _email.text) : null,
                onChanged: (_) => setState(() {}),
              ),
              const SizedBox(height: LemonSpacing.base),
              LemonTextField(
                label: l10n.authPasswordLabel,
                controller: _password,
                obscureText: true,
                autofillHints: const [AutofillHints.password],
                textInputAction: TextInputAction.done,
                onSubmitted: (_) => _submit(),
                errorText: _attempted && _password.text.isEmpty
                    ? l10n.authPasswordRequired
                    : null,
                onChanged: (_) => setState(() {}),
              ),
            ],
          ),
        ),
        Align(
          alignment: AlignmentDirectional.centerEnd,
          child: TextButton(
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => ForgotPasswordScreen(initialEmail: _email.text),
              ),
            ),
            child: Text(l10n.signInForgot),
          ),
        ),
        const SizedBox(height: LemonSpacing.sm),
        if (error != null) ...[
          InlineMessage(message: error, tone: MessageTone.error),
          const SizedBox(height: LemonSpacing.base),
        ],
        LemonButton(
          label: l10n.signInSubmit,
          onPressed: _submit,
          isLoading: _busy,
        ),
        const SizedBox(height: LemonSpacing.base),
        TextButton(
          onPressed: () => replaceWithCreateAccount(context),
          child: Text(l10n.signInNoAccount, textAlign: TextAlign.center),
        ),
      ],
    );
  }
}
