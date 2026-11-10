import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

import '../core/api/id_token_source.dart';
import '../core/api/lemon_api_client.dart';
import '../core/catalogs/catalogs.dart';
import '../features/auth/application/auth_controller.dart';
import '../features/profile/data/photo_picker.dart';
import 'config.dart';

/// Dependencies, overridden in tests with `ProviderScope(overrides: ...)`.

final appConfigProvider = Provider<AppConfig>(
  (ref) => AppConfig.fromEnvironment(),
);

/// Firebase ID tokens for the signed-in person, via the auth controller (so
/// token failures end the session).
final idTokenSourceProvider = Provider<IdTokenSource>(
  (ref) => ref.watch(authControllerProvider.notifier),
);

/// HTTP transport for the API client; null uses the default client. Tests
/// swap in an in-memory backend here.
final httpClientProvider = Provider<http.Client?>((ref) => null);

final apiClientProvider = Provider<LemonApiClient>(
  (ref) => LemonApiClient(
    baseUrl: ref.watch(appConfigProvider).apiBaseUrl,
    tokens: ref.watch(idTokenSourceProvider),
    httpClient: ref.watch(httpClientProvider),
    onUnauthorized: () =>
        ref.read(authControllerProvider.notifier).sessionRejected(),
  ),
);

final catalogsRepositoryProvider = Provider<CatalogsRepository>(
  (ref) => CatalogsRepository(ref.watch(apiClientProvider)),
);

final photoPickerProvider = Provider<PhotoPicker>(
  (ref) => const ImagePickerPhotoPicker(),
);

/// Today's date source, so date rules are testable.
final clockProvider = Provider<DateTime Function()>((ref) => DateTime.now);

/// Builds the image for an authenticated media path. Every read carries the
/// bearer token and is access-checked by the server.
typedef MediaImageLoader = Future<ImageProvider> Function(String path);

final mediaImageLoaderProvider = Provider<MediaImageLoader>((ref) {
  final api = ref.watch(apiClientProvider);
  return (path) async => NetworkImage(
    api.mediaUri(path).toString(),
    headers: await api.authHeaders(),
  );
});

/// Catalogs are static per release; load once and reuse.
class CatalogsRepository {
  CatalogsRepository(this._api);

  final LemonApiClient _api;
  Future<Catalogs>? _pending;

  Future<Catalogs> load() {
    return _pending ??= _api.getCatalogs().catchError((Object error) {
      _pending = null;
      throw error;
    });
  }
}
