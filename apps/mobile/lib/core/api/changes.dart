/// Returns the entries of [edited] whose value differs from [base].
///
/// Edits are sent as a partial update so that a field the person did not
/// touch is never overwritten with a stale value.
Map<String, Object?> changedFields(
  Map<String, Object?> base,
  Map<String, Object?> edited,
) {
  final changes = <String, Object?>{};
  for (final entry in edited.entries) {
    if (!_sameValue(base[entry.key], entry.value)) {
      changes[entry.key] = entry.value;
    }
  }
  return changes;
}

bool _sameValue(Object? a, Object? b) {
  if (a is List && b is List) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] != b[i]) return false;
    }
    return true;
  }
  return a == b;
}
