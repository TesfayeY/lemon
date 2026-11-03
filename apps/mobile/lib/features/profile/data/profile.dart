import '../../../core/api/wire_enum.dart';

/// Whether an optional profile field appears on the public profile.
enum FieldVisibility implements WireEnum {
  public('public'),
  private('private');

  const FieldVisibility(this.wire);

  @override
  final String wire;
}

/// Review state of the latest submission for a piece of profile content.
enum ReviewState implements WireEnum {
  pending('pending'),
  approved('approved'),
  rejected('rejected');

  const ReviewState(this.wire);

  @override
  final String wire;
}

/// A published prompt answer as other people see it.
class PromptAnswer {
  const PromptAnswer({
    required this.id,
    required this.promptId,
    required this.promptText,
    required this.text,
  });

  factory PromptAnswer.fromJson(Map<String, dynamic> json) => PromptAnswer(
    id: json['id'] as String,
    promptId: json['promptId'] as String,
    promptText: json['promptText'] as String,
    text: json['text'] as String,
  );

  final String id;
  final String promptId;
  final String promptText;
  final String text;

  Map<String, dynamic> toJson() => {
    'id': id,
    'promptId': promptId,
    'promptText': promptText,
    'text': text,
  };
}

/// The owner's view of an answer. [approvedText] stays published while
/// [pendingText] waits for review.
class SelfPromptAnswer {
  const SelfPromptAnswer({
    required this.id,
    required this.promptId,
    required this.promptText,
    required this.approvedText,
    required this.pendingText,
    required this.state,
    required this.revision,
  });

  factory SelfPromptAnswer.fromJson(Map<String, dynamic> json) =>
      SelfPromptAnswer(
        id: json['id'] as String,
        promptId: json['promptId'] as String,
        promptText: json['promptText'] as String,
        approvedText: json['approvedText'] as String?,
        pendingText: json['pendingText'] as String?,
        state: parseWire(ReviewState.values, json['state']),
        revision: json['revision'] as int,
      );

  final String id;
  final String promptId;
  final String promptText;
  final String? approvedText;
  final String? pendingText;
  final ReviewState state;

  /// Send back as `expectedRevision` when editing this answer.
  final int revision;

  Map<String, dynamic> toJson() => {
    'id': id,
    'promptId': promptId,
    'promptText': promptText,
    'approvedText': approvedText,
    'pendingText': pendingText,
    'state': state.wire,
    'revision': revision,
  };
}

/// Owner view of the profile draft from `GET /v1/me/profile`.
class SelfProfile {
  const SelfProfile({
    required this.userId,
    required this.displayName,
    required this.genderIdentity,
    required this.genderDisplay,
    required this.cityId,
    required this.cityName,
    required this.stateCode,
    required this.intention,
    required this.bio,
    required this.hometown,
    required this.hometownDisplay,
    required this.occupation,
    required this.occupationDisplay,
    required this.education,
    required this.educationDisplay,
    required this.height,
    required this.heightDisplay,
    required this.languages,
    required this.languagesDisplay,
    required this.religion,
    required this.religionDisplay,
    required this.promptAnswers,
    required this.revision,
    required this.profileReady,
  });

  factory SelfProfile.fromJson(Map<String, dynamic> json) => SelfProfile(
    userId: json['userId'] as String,
    displayName: json['displayName'] as String?,
    genderIdentity: json['genderIdentity'] as String?,
    genderDisplay: _visibility(json['genderDisplay']),
    cityId: json['cityId'] as String?,
    cityName: json['cityName'] as String?,
    stateCode: json['stateCode'] as String?,
    intention: json['intention'] as String?,
    bio: json['bio'] as String?,
    hometown: json['hometown'] as String?,
    hometownDisplay: _visibility(json['hometownDisplay']),
    occupation: json['occupation'] as String?,
    occupationDisplay: _visibility(json['occupationDisplay']),
    education: json['education'] as String?,
    educationDisplay: _visibility(json['educationDisplay']),
    height: json['height'] as int?,
    heightDisplay: _visibility(json['heightDisplay']),
    languages: (json['languages'] as List<dynamic>).cast<String>(),
    languagesDisplay: _visibility(json['languagesDisplay']),
    religion: json['religion'] as String?,
    religionDisplay: _visibility(json['religionDisplay']),
    promptAnswers: (json['promptAnswers'] as List<dynamic>)
        .map((e) => SelfPromptAnswer.fromJson(e as Map<String, dynamic>))
        .toList(),
    revision: json['revision'] as int,
    profileReady: json['profileReady'] as bool,
  );

  final String userId;
  final String? displayName;
  final String? genderIdentity;
  final FieldVisibility genderDisplay;
  final String? cityId;
  final String? cityName;
  final String? stateCode;
  final String? intention;
  final String? bio;
  final String? hometown;
  final FieldVisibility hometownDisplay;
  final String? occupation;
  final FieldVisibility occupationDisplay;
  final String? education;
  final FieldVisibility educationDisplay;

  /// Centimeters.
  final int? height;
  final FieldVisibility heightDisplay;
  final List<String> languages;
  final FieldVisibility languagesDisplay;
  final String? religion;
  final FieldVisibility religionDisplay;
  final List<SelfPromptAnswer> promptAnswers;

  /// Send back as `expectedRevision` when editing the profile.
  final int revision;
  final bool profileReady;

  Map<String, dynamic> toJson() => {
    'userId': userId,
    'displayName': displayName,
    'genderIdentity': genderIdentity,
    'genderDisplay': genderDisplay.wire,
    'cityId': cityId,
    'cityName': cityName,
    'stateCode': stateCode,
    'intention': intention,
    'bio': bio,
    'hometown': hometown,
    'hometownDisplay': hometownDisplay.wire,
    'occupation': occupation,
    'occupationDisplay': occupationDisplay.wire,
    'education': education,
    'educationDisplay': educationDisplay.wire,
    'height': height,
    'heightDisplay': heightDisplay.wire,
    'languages': languages,
    'languagesDisplay': languagesDisplay.wire,
    'religion': religion,
    'religionDisplay': religionDisplay.wire,
    'promptAnswers': promptAnswers.map((a) => a.toJson()).toList(),
    'revision': revision,
    'profileReady': profileReady,
  };
}

FieldVisibility _visibility(Object? value) =>
    parseWire(FieldVisibility.values, value);

/// Public projection from `GET /v1/profiles/:id` and the owner's preview.
/// Private fields arrive as null (or an empty language list).
class PublicProfile {
  const PublicProfile({
    required this.userId,
    required this.displayName,
    required this.age,
    required this.cityName,
    required this.stateCode,
    required this.intention,
    required this.intentionLabel,
    required this.genderIdentity,
    required this.genderLabel,
    required this.bio,
    required this.hometown,
    required this.occupation,
    required this.education,
    required this.height,
    required this.languages,
    required this.religion,
    required this.promptAnswers,
  });

  factory PublicProfile.fromJson(Map<String, dynamic> json) => PublicProfile(
    userId: json['userId'] as String,
    displayName: json['displayName'] as String?,
    age: json['age'] as int?,
    cityName: json['cityName'] as String?,
    stateCode: json['stateCode'] as String?,
    intention: json['intention'] as String?,
    intentionLabel: json['intentionLabel'] as String?,
    genderIdentity: json['genderIdentity'] as String?,
    genderLabel: json['genderLabel'] as String?,
    bio: json['bio'] as String?,
    hometown: json['hometown'] as String?,
    occupation: json['occupation'] as String?,
    education: json['education'] as String?,
    height: json['height'] as int?,
    languages: (json['languages'] as List<dynamic>).cast<String>(),
    religion: json['religion'] as String?,
    promptAnswers: (json['promptAnswers'] as List<dynamic>)
        .map((e) => PromptAnswer.fromJson(e as Map<String, dynamic>))
        .toList(),
  );

  final String userId;

  /// Null only in the owner's preview of an incomplete draft.
  final String? displayName;
  final int? age;
  final String? cityName;
  final String? stateCode;
  final String? intention;
  final String? intentionLabel;
  final String? genderIdentity;
  final String? genderLabel;
  final String? bio;
  final String? hometown;
  final String? occupation;
  final String? education;
  final int? height;
  final List<String> languages;
  final String? religion;
  final List<PromptAnswer> promptAnswers;

  Map<String, dynamic> toJson() => {
    'userId': userId,
    'displayName': displayName,
    'age': age,
    'cityName': cityName,
    'stateCode': stateCode,
    'intention': intention,
    'intentionLabel': intentionLabel,
    'genderIdentity': genderIdentity,
    'genderLabel': genderLabel,
    'bio': bio,
    'hometown': hometown,
    'occupation': occupation,
    'education': education,
    'height': height,
    'languages': languages,
    'religion': religion,
    'promptAnswers': promptAnswers.map((a) => a.toJson()).toList(),
  };
}
