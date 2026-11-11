import 'package:flutter/widgets.dart';

import '../../l10n/generated/app_localizations.dart';

export '../../l10n/generated/app_localizations.dart';

extension L10nContext on BuildContext {
  /// Localized strings. Every user-facing string comes from `lib/l10n/*.arb`.
  AppLocalizations get l10n => AppLocalizations.of(this);
}
