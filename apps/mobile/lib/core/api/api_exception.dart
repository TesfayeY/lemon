import 'api_error.dart';

/// Any failure talking to the Lemon API. Screens map these to localized copy.
sealed class ApiFailure implements Exception {
  const ApiFailure();
}

/// The server answered with an `{ error, requestId }` body.
class ApiException extends ApiFailure {
  const ApiException({
    required this.statusCode,
    required this.error,
    this.requestId,
  });

  final int statusCode;
  final ApiError error;
  final String? requestId;

  String get code => error.code;
  bool get isRevisionConflict => error.isRevisionConflict;

  @override
  String toString() => 'ApiException($statusCode, ${error.code})';
}

/// The request never completed: offline, DNS failure, timeout.
class NetworkException extends ApiFailure {
  const NetworkException(this.cause);

  final Object cause;

  @override
  String toString() => 'NetworkException($cause)';
}

/// There is no signed-in Firebase user to send a token for.
class NotSignedInException extends ApiFailure {
  const NotSignedInException();
}

/// The server answered with something that is not the contract envelope.
class MalformedResponseException extends ApiFailure {
  const MalformedResponseException(this.statusCode, this.cause);

  final int statusCode;
  final Object cause;

  @override
  String toString() => 'MalformedResponseException($statusCode, $cause)';
}
