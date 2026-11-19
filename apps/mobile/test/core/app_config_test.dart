import 'package:flutter_test/flutter_test.dart';
import 'package:lemon/app/config.dart';

void main() {
  group('API base URL', () {
    String? problem(String url, {required bool release}) =>
        AppConfig.apiBaseUrlProblem(Uri.parse(url), release: release);

    test('release builds require https', () {
      expect(problem('https://api.example.com', release: true), isNull);
      expect(problem('http://localhost:3000', release: true), isNotNull);
      expect(problem('http://api.example.com', release: true), isNotNull);
    });

    test('development builds allow local http', () {
      expect(problem('http://localhost:3000', release: false), isNull);
      expect(problem('http://10.0.2.2:3000', release: false), isNull);
      expect(problem('https://api.example.com', release: false), isNull);
    });

    test('rejects URLs that are not http(s) or have no host', () {
      expect(problem('ftp://api.example.com', release: false), isNotNull);
      expect(problem('/v1', release: false), isNotNull);
      expect(problem('https://', release: true), isNotNull);
    });

    test('validate throws only for an unusable configuration', () {
      final local = AppConfig(apiBaseUrl: Uri.parse('http://localhost:3000'));
      expect(() => local.validate(release: false), returnsNormally);
      expect(() => local.validate(release: true), throwsStateError);

      final secure = AppConfig(
        apiBaseUrl: Uri.parse('https://api.example.com'),
      );
      expect(() => secure.validate(release: true), returnsNormally);
    });
  });
}
