import '../../../core/api/wire_enum.dart';

enum LocationScope implements WireEnum {
  city('city'),
  state('state'),
  nationwide('nationwide');

  const LocationScope(this.wire);

  @override
  final String wire;
}

/// Private dating preferences from `GET /v1/me/preferences`.
/// Bounds (ages 18-99, at least one interest) are enforced by the server.
class Preferences {
  const Preferences({
    required this.acceptedGenderCategories,
    required this.minAge,
    required this.maxAge,
    required this.locationScope,
    required this.longDistance,
    required this.revision,
  });

  factory Preferences.fromJson(Map<String, dynamic> json) => Preferences(
    acceptedGenderCategories:
        (json['acceptedGenderCategories'] as List<dynamic>).cast<String>(),
    minAge: json['minAge'] as int,
    maxAge: json['maxAge'] as int,
    locationScope: parseWire(LocationScope.values, json['locationScope']),
    longDistance: json['longDistance'] as bool,
    revision: json['revision'] as int,
  );

  final List<String> acceptedGenderCategories;
  final int minAge;
  final int maxAge;
  final LocationScope locationScope;
  final bool longDistance;

  /// Send back as `expectedRevision` when editing preferences.
  final int revision;

  Map<String, dynamic> toJson() => {
    'acceptedGenderCategories': acceptedGenderCategories,
    'minAge': minAge,
    'maxAge': maxAge,
    'locationScope': locationScope.wire,
    'longDistance': longDistance,
    'revision': revision,
  };
}
