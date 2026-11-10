import 'package:flutter/material.dart';

import '../api/api_exception.dart';
import '../l10n/failure_messages.dart';
import '../l10n/l10n.dart';
import 'state_views.dart';

/// Loads data once, with loading, offline and error states and a retry.
class AsyncLoader<T> extends StatefulWidget {
  const AsyncLoader({super.key, required this.load, required this.builder});

  final Future<T> Function() load;
  final Widget Function(
    BuildContext context,
    T data,
    Future<void> Function() reload,
  )
  builder;

  @override
  State<AsyncLoader<T>> createState() => _AsyncLoaderState<T>();
}

class _AsyncLoaderState<T> extends State<AsyncLoader<T>> {
  late Future<T> _future;

  @override
  void initState() {
    super.initState();
    _future = widget.load();
  }

  Future<void> _reload() async {
    final next = widget.load();
    setState(() {
      _future = next;
    });
    try {
      await next;
    } on Object {
      // Shown by the builder below
    }
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<T>(
      future: _future,
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return LemonLoadingView(message: context.l10n.commonLoading);
        }
        final error = snapshot.error;
        if (error != null) {
          return FailureView(error: error, onRetry: _reload);
        }
        return widget.builder(context, snapshot.data as T, _reload);
      },
    );
  }
}

/// Full-screen failure with offline-aware copy and a retry.
class FailureView extends StatelessWidget {
  const FailureView({super.key, required this.error, this.onRetry});

  final Object error;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final message = describeFailure(context.l10n, error);
    if (error is NetworkException) {
      return LemonEmptyView(
        message: message,
        icon: Icons.wifi_off,
        actionLabel: context.l10n.commonRetry,
        onAction: onRetry,
      );
    }
    return Semantics(
      liveRegion: true,
      child: LemonErrorView(message: message, onRetry: onRetry),
    );
  }
}
