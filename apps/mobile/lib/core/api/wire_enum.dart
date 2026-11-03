/// An enum with a stable wire value defined in contracts/openapi.yaml.
abstract interface class WireEnum {
  String get wire;
}

/// Parses [value] into one of [values]; an unknown value violates the contract.
T parseWire<T extends WireEnum>(List<T> values, Object? value) {
  for (final candidate in values) {
    if (candidate.wire == value) return candidate;
  }
  throw FormatException('Unknown $T value: $value');
}
