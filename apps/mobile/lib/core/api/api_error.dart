/// Error body returned by the Lemon API inside `{ error, requestId }`.
class ApiError {
  const ApiError({
    required this.code,
    required this.message,
    required this.retryable,
    this.fieldErrors = const [],
    this.currentRevision,
  });

  factory ApiError.fromJson(Map<String, dynamic> json) => ApiError(
    code: json['code'] as String,
    message: json['message'] as String,
    retryable: json['retryable'] as bool,
    fieldErrors: (json['fieldErrors'] as List<dynamic>? ?? const [])
        .map((e) => FieldError.fromJson(e as Map<String, dynamic>))
        .toList(),
    currentRevision: json['currentRevision'] as int?,
  );

  final String code;

  /// Server text for diagnostics; the UI shows localized copy keyed by [code].
  final String message;
  final bool retryable;
  final List<FieldError> fieldErrors;

  /// Set on a revision conflict: refresh to this revision, then reapply.
  final int? currentRevision;

  bool get isRevisionConflict => code == 'REVISION_CONFLICT';

  Map<String, dynamic> toJson() => {
    'code': code,
    'message': message,
    if (fieldErrors.isNotEmpty)
      'fieldErrors': fieldErrors.map((e) => e.toJson()).toList(),
    if (currentRevision != null) 'currentRevision': currentRevision,
    'retryable': retryable,
  };
}

class FieldError {
  const FieldError({required this.field, required this.message});

  factory FieldError.fromJson(Map<String, dynamic> json) => FieldError(
    field: json['field'] as String,
    message: json['message'] as String,
  );

  final String field;
  final String message;

  Map<String, dynamic> toJson() => {'field': field, 'message': message};
}
