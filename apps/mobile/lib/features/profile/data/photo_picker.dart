import 'dart:typed_data';

import 'package:image_picker/image_picker.dart';

/// A photo chosen on the device, ready to upload.
class PickedPhoto {
  const PickedPhoto({required this.bytes, required this.filename});

  final Uint8List bytes;
  final String filename;
}

/// Chooses a photo from the device. Swapped for a fake in tests.
abstract interface class PhotoPicker {
  /// Returns null when the person cancels.
  Future<PickedPhoto?> pick();
}

/// Gallery picker. Resizes and recompresses on device to save bandwidth; the
/// server still validates the real format, size and dimensions.
class ImagePickerPhotoPicker implements PhotoPicker {
  const ImagePickerPhotoPicker();

  @override
  Future<PickedPhoto?> pick() async {
    final file = await ImagePicker().pickImage(
      source: ImageSource.gallery,
      maxWidth: 2048,
      maxHeight: 2048,
      imageQuality: 85,
      requestFullMetadata: false,
    );
    if (file == null) return null;
    return PickedPhoto(bytes: await file.readAsBytes(), filename: file.name);
  }
}
