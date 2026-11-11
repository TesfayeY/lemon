import '../../../core/api/wire_enum.dart';

/// Review state of an uploaded photo (`contracts/openapi/media.yaml`).
enum PhotoState implements WireEnum {
  processing('processing'),
  pending('pending'),
  approved('approved'),
  rejected('rejected');

  const PhotoState(this.wire);

  @override
  final String wire;
}

/// Why a reviewer declined a photo. [code] maps to localized copy; [message]
/// is the server's English default.
class RejectionReason {
  const RejectionReason({required this.code, required this.message});

  factory RejectionReason.fromJson(Map<String, dynamic> json) =>
      RejectionReason(
        code: json['code'] as String,
        message: json['message'] as String,
      );

  final String code;
  final String message;

  Map<String, dynamic> toJson() => {'code': code, 'message': message};
}

/// Authenticated media paths, resolved against the API origin.
class MediaPaths {
  const MediaPaths({required this.thumb, required this.display});

  factory MediaPaths.fromJson(Map<String, dynamic> json) => MediaPaths(
    thumb: json['thumb'] as String,
    display: json['display'] as String,
  );

  final String thumb;
  final String display;

  Map<String, dynamic> toJson() => {'thumb': thumb, 'display': display};
}

/// The owner's view of one photo from `GET /v1/me/photos`.
class OwnerPhoto {
  const OwnerPhoto({
    required this.id,
    required this.state,
    required this.order,
    required this.width,
    required this.height,
    required this.contentVersion,
    required this.rejectionReason,
    required this.media,
    required this.createdAt,
  });

  factory OwnerPhoto.fromJson(Map<String, dynamic> json) => OwnerPhoto(
    id: json['id'] as String,
    state: parseWire(PhotoState.values, json['state']),
    order: json['order'] as int,
    width: json['width'] as int,
    height: json['height'] as int,
    contentVersion: json['contentVersion'] as int,
    rejectionReason: json['rejectionReason'] == null
        ? null
        : RejectionReason.fromJson(
            json['rejectionReason'] as Map<String, dynamic>,
          ),
    media: json['media'] == null
        ? null
        : MediaPaths.fromJson(json['media'] as Map<String, dynamic>),
    createdAt: DateTime.parse(json['createdAt'] as String),
  );

  final String id;
  final PhotoState state;
  final int order;
  final int width;
  final int height;
  final int contentVersion;
  final RejectionReason? rejectionReason;

  /// Null while the server is still processing the upload.
  final MediaPaths? media;
  final DateTime createdAt;

  bool get isRejected => state == PhotoState.rejected;

  Map<String, dynamic> toJson() => {
    'id': id,
    'state': state.wire,
    'order': order,
    'width': width,
    'height': height,
    'contentVersion': contentVersion,
    'rejectionReason': rejectionReason?.toJson(),
    'media': media?.toJson(),
    'createdAt': createdAt.toUtc().toIso8601String(),
  };
}

/// The caller's photos: non-rejected in display order, then rejected ones.
class PhotoSet {
  const PhotoSet({
    required this.photos,
    required this.revision,
    required this.minPhotos,
    required this.maxPhotos,
  });

  factory PhotoSet.fromJson(Map<String, dynamic> json) => PhotoSet(
    photos: (json['photos'] as List<dynamic>)
        .map((e) => OwnerPhoto.fromJson(e as Map<String, dynamic>))
        .toList(),
    revision: json['revision'] as int,
    minPhotos: json['minPhotos'] as int,
    maxPhotos: json['maxPhotos'] as int,
  );

  final List<OwnerPhoto> photos;

  /// Send back as `expectedRevision` when reordering.
  final int revision;
  final int minPhotos;
  final int maxPhotos;

  /// Photos that count toward the limit and the display order.
  List<OwnerPhoto> get active => photos.where((p) => !p.isRejected).toList();
  List<OwnerPhoto> get rejected => photos.where((p) => p.isRejected).toList();
  int get approvedCount =>
      photos.where((p) => p.state == PhotoState.approved).length;

  Map<String, dynamic> toJson() => {
    'photos': photos.map((p) => p.toJson()).toList(),
    'revision': revision,
    'minPhotos': minPhotos,
    'maxPhotos': maxPhotos,
  };
}

/// Result of `POST /v1/me/photos`.
class PhotoUpload {
  const PhotoUpload({
    required this.id,
    required this.state,
    required this.order,
    required this.revision,
  });

  factory PhotoUpload.fromJson(Map<String, dynamic> json) => PhotoUpload(
    id: json['id'] as String,
    state: parseWire(PhotoState.values, json['state']),
    order: json['order'] as int,
    revision: json['revision'] as int,
  );

  final String id;
  final PhotoState state;
  final int order;
  final int revision;
}
