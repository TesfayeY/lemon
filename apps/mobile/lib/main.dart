import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app/app.dart';
import 'app/config.dart';
import 'features/auth/application/auth_controller.dart';
import 'features/auth/data/firebase_setup.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Release builds refuse a non-HTTPS API origin before anything is sent
  AppConfig.fromEnvironment().validate();
  final auth = await createAuthRepository(FirebaseSettings.fromEnvironment());
  runApp(
    ProviderScope(
      overrides: [authRepositoryProvider.overrideWithValue(auth)],
      child: const LemonApp(),
    ),
  );
}
