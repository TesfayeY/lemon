import '../../app/config.dart';
import '../api/api_exception.dart';
import 'l10n.dart';

/// Localized, person-friendly copy for an API failure. Server messages are
/// diagnostics only and never shown directly.
String describeFailure(AppLocalizations l10n, Object error, {int maxPhotos = 6}) =>
    switch (error) {
      NetworkException() => l10n.errorOffline,
      NotSignedInException() => l10n.errorNotSignedIn,
      ApiException(:final code) => switch (code) {
        'ACCOUNT_RESTRICTED' || 'TOKEN_REVOKED' => l10n.errorRestricted,
        'UNAUTHENTICATED' => l10n.errorNotSignedIn,
        'AGE_INELIGIBLE' => l10n.birthDateUnderage(appName),
        'DUPLICATE_PROMPT' => l10n.promptDuplicate,
        'PROMPT_LIMIT' => l10n.promptLimit,
        'PHOTO_LIMIT_REACHED' => l10n.photoLimit(maxPhotos),
        'UNSUPPORTED_MEDIA_TYPE' => l10n.photoUnsupported,
        'PAYLOAD_TOO_LARGE' => l10n.photoTooLarge,
        'IMAGE_DIMENSIONS_INVALID' => l10n.photoDimensions,
        'INVALID_IMAGE' => l10n.photoInvalid,
        'VALIDATION_ERROR' => l10n.errorValidation,
        'NOT_FOUND' || 'PHOTO_NOT_FOUND' => l10n.errorNotFound,
        _ => l10n.errorGeneric,
      },
      _ => l10n.errorGeneric,
    };
