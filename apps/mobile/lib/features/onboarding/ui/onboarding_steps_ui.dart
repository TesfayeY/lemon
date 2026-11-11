import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/config.dart';
import '../../../app/providers.dart';
import '../../../core/api/api_exception.dart';
import '../../../core/l10n/failure_messages.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/theme/lemon_spacing.dart';
import '../../../core/theme/lemon_typography.dart';
import '../../../core/widgets/inline_message.dart';
import '../../../core/widgets/lemon_button.dart';
import '../../auth/application/auth_controller.dart';
import '../../auth/ui/verify_email_view.dart';
import '../../profile/ui/form_host.dart';
import '../data/account.dart';
import '../domain/birth_date.dart';

/// Email verification happens through Firebase. The server still lacks the
/// verified claim (e.g. a token from before the link was opened), so this
/// refreshes the Firebase user and token, re-bootstraps and re-checks.
class VerifyEmailStep extends ConsumerWidget {
  const VerifyEmailStep({super.key, required this.onVerified});

  final ValueChanged<Account> onVerified;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    Future<bool> check() async {
      final auth = ref.read(authControllerProvider.notifier);
      if (!await auth.refreshVerification()) return false;
      final api = ref.read(apiClientProvider);
      await api.bootstrap();
      final account = await api.getAccount();
      if (account.readiness.missing.contains(
        ReadinessRequirement.emailVerified,
      )) {
        return false;
      }
      onVerified(account);
      return true;
    }

    return ListView(
      padding: const EdgeInsets.all(LemonSpacing.lg),
      children: [VerifyEmailView(onCheck: check)],
    );
  }
}

/// Adult gate: a self-declared birth date the server checks for 18+.
/// This is not identity or age verification (P-02).
class BirthDateStep extends ConsumerStatefulWidget {
  const BirthDateStep({
    super.key,
    required this.account,
    required this.onSaved,
  });

  final Account account;
  final VoidCallback onSaved;

  @override
  ConsumerState<BirthDateStep> createState() => _BirthDateStepState();
}

class _BirthDateStepState extends ConsumerState<BirthDateStep> {
  late DateTime? _date = parseIsoDate(widget.account.birthDate);
  bool _attempted = false;
  bool _busy = false;
  bool _ineligible = false;
  String? _error;

  Future<void> _choose() async {
    final today = ref.read(clockProvider)();
    final l10n = context.l10n;
    final picked = await showDatePicker(
      context: context,
      initialDate: _date ?? DateTime(today.year - 25, today.month, today.day),
      firstDate: DateTime(today.year - 120),
      lastDate: today,
      initialEntryMode: DatePickerEntryMode.input,
      helpText: l10n.birthDatePickerHelp,
      fieldLabelText: l10n.birthDatePickerHelp,
    );
    if (picked != null) {
      setState(() {
        _date = picked;
        _ineligible = false;
        _error = null;
      });
    }
  }

  Future<void> _submit() async {
    final today = ref.read(clockProvider)();
    setState(() => _attempted = true);
    final problem = validateBirthDate(_date, today);
    if (problem == BirthDateError.underage) {
      setState(() => _ineligible = true);
      return;
    }
    if (problem != null) return;
    final iso = isoDate(_date!);
    if (iso == widget.account.birthDate && widget.account.adultEligible) {
      widget.onSaved();
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(apiClientProvider).saveOnboarding(birthDate: iso);
      if (mounted) widget.onSaved();
    } on ApiException catch (e) {
      if (!mounted) return;
      if (e.code == 'AGE_INELIGIBLE') {
        setState(() => _ineligible = true);
      } else {
        setState(() => _error = describeFailure(context.l10n, e));
      }
    } on Object catch (e) {
      if (mounted) setState(() => _error = describeFailure(context.l10n, e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    if (_ineligible) {
      return ListView(
        padding: const EdgeInsets.all(LemonSpacing.lg),
        children: [
          SectionHeader(
            title: l10n.birthDateIneligibleTitle,
            subtitle: l10n.birthDateIneligibleBody(appName),
          ),
          LemonButton(
            label: l10n.birthDateChange,
            isOutlined: true,
            onPressed: () => setState(() => _ineligible = false),
          ),
        ],
      );
    }
    final date = _date;
    final validation = _attempted
        ? switch (validateBirthDate(date, ref.read(clockProvider)())) {
            BirthDateError.required => l10n.birthDateRequired,
            BirthDateError.future => l10n.birthDateFuture,
            BirthDateError.underage => l10n.birthDateUnderage(appName),
            null => null,
          }
        : null;
    final error = validation ?? _error;
    return ListView(
      padding: const EdgeInsets.all(LemonSpacing.lg),
      children: [
        SectionHeader(
          title: l10n.birthDateTitle,
          subtitle: l10n.birthDateAdultOnly(appName),
        ),
        InlineMessage(message: l10n.birthDatePrivacy),
        const SizedBox(height: LemonSpacing.lg),
        if (date != null) ...[
          Text(
            l10n.birthDateSelected(
              MaterialLocalizations.of(context).formatFullDate(date),
            ),
            style: LemonTypography.section,
          ),
          const SizedBox(height: LemonSpacing.sm),
        ],
        LemonButton(
          label: date == null ? l10n.birthDateChoose : l10n.birthDateChange,
          isOutlined: true,
          onPressed: _busy ? null : _choose,
        ),
        const SizedBox(height: LemonSpacing.lg),
        if (error != null) ...[
          InlineMessage(message: error, tone: MessageTone.error),
          const SizedBox(height: LemonSpacing.base),
        ],
        LemonButton(
          label: l10n.commonContinue,
          onPressed: _submit,
          isLoading: _busy,
        ),
      ],
    );
  }
}

/// Community statement and terms acceptance. Final legal text and the
/// eligibility wording (P-09) are still pending owner input.
class TermsStep extends ConsumerStatefulWidget {
  const TermsStep({super.key, required this.account, required this.onSaved});

  final Account account;
  final VoidCallback onSaved;

  @override
  ConsumerState<TermsStep> createState() => _TermsStepState();
}

class _TermsStepState extends ConsumerState<TermsStep> {
  late final bool _alreadyAccepted =
      widget.account.agreements.termsVersion != null;
  late bool _agreed = _alreadyAccepted;
  bool _attempted = false;
  bool _busy = false;
  String? _error;

  Future<void> _submit() async {
    setState(() => _attempted = true);
    if (!_agreed) return;
    if (_alreadyAccepted) {
      widget.onSaved();
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(apiClientProvider).saveOnboarding(acceptTerms: true);
      if (mounted) widget.onSaved();
    } on Object catch (e) {
      if (mounted) setState(() => _error = describeFailure(context.l10n, e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final error = _attempted && !_agreed ? l10n.termsRequired : _error;
    return ListView(
      padding: const EdgeInsets.all(LemonSpacing.lg),
      children: [
        SectionHeader(
          title: l10n.termsTitle,
          subtitle: l10n.termsAudience(appName),
        ),
        Text(l10n.termsRespect, style: LemonTypography.body),
        const SizedBox(height: LemonSpacing.base),
        InlineMessage(message: l10n.termsDraftNote),
        const SizedBox(height: LemonSpacing.base),
        if (_alreadyAccepted)
          InlineMessage(message: l10n.termsAccepted, tone: MessageTone.success)
        else
          CheckboxListTile(
            contentPadding: EdgeInsets.zero,
            controlAffinity: ListTileControlAffinity.leading,
            value: _agreed,
            title: Text(l10n.termsAgree),
            onChanged: (value) => setState(() => _agreed = value ?? false),
          ),
        const SizedBox(height: LemonSpacing.base),
        if (error != null) ...[
          InlineMessage(message: error, tone: MessageTone.error),
          const SizedBox(height: LemonSpacing.base),
        ],
        LemonButton(
          label: l10n.commonContinue,
          onPressed: _submit,
          isLoading: _busy,
        ),
      ],
    );
  }
}
