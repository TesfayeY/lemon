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
import 'sign_in_screen.dart';

void openCreateAccount(BuildContext context) => Navigator.of(context).push(
  MaterialPageRoute<void>(builder: (_) => const CreateAccountScreen()),
);

void replaceWithCreateAccount(BuildContext context) =>
    Navigator.of(context).pushReplacement(
      MaterialPageRoute<void>(builder: (_) => const CreateAccountScreen()),
    );

/// Email, password (checked live against the Firebase password policy) and
/// confirmation. Firebase sends the verification email after sign-up.
class CreateAccountScreen extends ConsumerStatefulWidget {
  const CreateAccountScreen({super.key});

  @override
  ConsumerState<CreateAccountScreen> createState() =>
      _CreateAccountScreenState();
}

class _CreateAccountScreenState extends ConsumerState<CreateAccountScreen> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _confirm = TextEditingController();
  bool _attempted = false;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    _confirm.dispose();
    super.dispose();
  }

  String? _passwordError() {
    if (!_attempted) return null;
    final l10n = context.l10n;
    if (_password.text.isEmpty) return l10n.authPasswordRequired;
    if (!ref.read(passwordPolicyProvider).accepts(_password.text)) {
      return l10n.authPasswordWeak;
    }
    return null;
  }

  String? _confirmError() {
    if (!_attempted || _password.text.isEmpty) return null;
    return _confirm.text == _password.text
        ? null
        : context.l10n.authPasswordsDontMatch;
  }

  Future<void> _submit() async {
    final l10n = context.l10n;
    setState(() {
      _attempted = true;
      _error = null;
    });
    if (emailError(l10n, _email.text) != null ||
        _passwordError() != null ||
        _confirmError() != null) {
      return;
    }
    setState(() => _busy = true);
    try {
      await ref
          .read(authControllerProvider.notifier)
          .createAccount(email: _email.text, password: _password.text);
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
        SectionHeader(
          title: l10n.createAccountTitle,
          subtitle: l10n.createAccountSubtitle,
        ),
        AutofillGroup(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
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
                autofillHints: const [AutofillHints.newPassword],
                textInputAction: TextInputAction.next,
                errorText: _passwordError(),
                onChanged: (_) => setState(() {}),
              ),
              const SizedBox(height: LemonSpacing.sm),
              PasswordRequirementsList(
                policy: ref.watch(passwordPolicyProvider),
                password: _password.text,
              ),
              const SizedBox(height: LemonSpacing.base),
              LemonTextField(
                label: l10n.authConfirmPasswordLabel,
                controller: _confirm,
                obscureText: true,
                autofillHints: const [AutofillHints.newPassword],
                textInputAction: TextInputAction.done,
                onSubmitted: (_) => _submit(),
                errorText: _confirmError(),
                onChanged: (_) => setState(() {}),
              ),
            ],
          ),
        ),
        const SizedBox(height: LemonSpacing.lg),
        if (error != null) ...[
          InlineMessage(message: error, tone: MessageTone.error),
          const SizedBox(height: LemonSpacing.base),
        ],
        LemonButton(
          label: l10n.createAccountSubmit,
          onPressed: _submit,
          isLoading: _busy,
        ),
        const SizedBox(height: LemonSpacing.base),
        TextButton(
          onPressed: () => Navigator.of(context).pushReplacement(
            MaterialPageRoute<void>(builder: (_) => const SignInScreen()),
          ),
          child: Text(l10n.createAccountHaveAccount, textAlign: TextAlign.center),
        ),
      ],
    );
  }
}
