import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app/app.dart';
import 'features/auth/application/auth_controller.dart';
import 'features/auth/data/firebase_setup.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final auth = await createAuthRepository(FirebaseSettings.fromEnvironment());
  runApp(
    ProviderScope(
      overrides: [authRepositoryProvider.overrideWithValue(auth)],
      child: const LemonApp(),
    ),
  );
}
