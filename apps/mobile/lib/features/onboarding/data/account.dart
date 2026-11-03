import '../../../core/api/wire_enum.dart';

enum AccountStatus implements WireEnum {
  onboarding('onboarding'),
  active('active'),
  suspended('suspended'),
  deletionPending('deletion_pending'),
  deleted('deleted');

  const AccountStatus(this.wire);

  @override
  final String wire;
}

/// A readiness requirement the profile does not yet meet, in onboarding order.
/// Onboarding resumes from the first missing requirement.
enum ReadinessRequirement implements WireEnum {
  emailVerified('emailVerified'),
  adultEligible('adultEligible'),
  termsAccepted('termsAccepted'),
  displayName('displayName'),
  genderIdentity('genderIdentity'),
  interests('interests'),
  location('location'),
  intention('intention'),
  photos('photos'),
  promptAnswers('promptAnswers'),
  accountSuspended('accountSuspended'),

  /// A requirement added by a newer server; treat it as "not ready yet".
  unknown('unknown');

  const ReadinessRequirement(this.wire);

  @override
  final String wire;

  static ReadinessRequirement fromWire(Object? value) =>
      values.firstWhere((r) => r.wire == value, orElse: () => unknown);
}

/// Server-computed readiness. The client never decides readiness itself.
class Readiness {
  const Readiness({required this.ready, required this.missing});

  factory Readiness.fromJson(Map<String, dynamic> json) => Readiness(
    ready: json['ready'] as bool,
    missing: (json['missing'] as List<dynamic>)
        .map(ReadinessRequirement.fromWire)
        .toList(),
  );

  final bool ready;
  final List<ReadinessRequirement> missing;

  Map<String, dynamic> toJson() => {
    'ready': ready,
    'missing': missing.map((r) => r.wire).toList(),
  };
}

class Agreements {
  const Agreements({required this.termsVersion, required this.acceptedAt});

  factory Agreements.fromJson(Map<String, dynamic> json) => Agreements(
    termsVersion: json['termsVersion'] as String?,
    acceptedAt: json['acceptedAt'] == null
        ? null
        : DateTime.parse(json['acceptedAt'] as String),
  );

  final String? termsVersion;
  final DateTime? acceptedAt;

  Map<String, dynamic> toJson() => {
    'termsVersion': termsVersion,
    'acceptedAt': acceptedAt?.toUtc().toIso8601String(),
  };
}

/// Private own-account snapshot from `GET /v1/me`.
class Account {
  const Account({
    required this.userId,
    required this.accountStatus,
    required this.emailVerified,
    required this.birthDate,
    required this.adultEligible,
    required this.profileReady,
    required this.discoverPaused,
    required this.agreements,
    required this.readiness,
  });

  factory Account.fromJson(Map<String, dynamic> json) => Account(
    userId: json['userId'] as String,
    accountStatus: parseWire(AccountStatus.values, json['accountStatus']),
    emailVerified: json['emailVerified'] as bool,
    birthDate: json['birthDate'] as String?,
    adultEligible: json['adultEligible'] as bool,
    profileReady: json['profileReady'] as bool,
    discoverPaused: json['discoverPaused'] as bool,
    agreements: Agreements.fromJson(json['agreements'] as Map<String, dynamic>),
    readiness: Readiness.fromJson(json['readiness'] as Map<String, dynamic>),
  );

  final String userId;
  final AccountStatus accountStatus;
  final bool emailVerified;

  /// Date-only ISO string (`YYYY-MM-DD`); kept as text to avoid time zone shifts.
  final String? birthDate;
  final bool adultEligible;
  final bool profileReady;
  final bool discoverPaused;
  final Agreements agreements;
  final Readiness readiness;

  Map<String, dynamic> toJson() => {
    'userId': userId,
    'accountStatus': accountStatus.wire,
    'emailVerified': emailVerified,
    'birthDate': birthDate,
    'adultEligible': adultEligible,
    'profileReady': profileReady,
    'discoverPaused': discoverPaused,
    'agreements': agreements.toJson(),
    'readiness': readiness.toJson(),
  };
}
