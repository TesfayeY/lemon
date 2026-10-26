import { PhotoState, type PhotoDocument, type PhotoStateType, type PhotoVariant } from './schema.js';
import { describeRejection, type RejectionReason } from './review-service.js';

/**
 * Explicit allowlists. Storage keys, idempotency keys, request hashes and
 * review metadata are never part of any response.
 */

type MediaPaths = Record<PhotoVariant, string>;

function mediaPaths(photoId: string): MediaPaths {
  return {
    thumb: `/v1/media/${photoId}/thumb`,
    display: `/v1/media/${photoId}/display`,
  };
}

export interface OwnerPhotoDTO {
  id: string;
  state: PhotoStateType;
  order: number;
  width: number;
  height: number;
  contentVersion: number;
  rejectionReason: RejectionReason | null;
  media: MediaPaths | null;
  createdAt: Date;
}

export function toOwnerPhotoDTO(photo: PhotoDocument): OwnerPhotoDTO {
  return {
    id: photo._id,
    state: photo.state,
    order: photo.order,
    width: photo.width,
    height: photo.height,
    contentVersion: photo.contentVersion,
    rejectionReason: photo.state === PhotoState.REJECTED ? describeRejection(photo.moderationReason) : null,
    media: photo.state === PhotoState.PROCESSING ? null : mediaPaths(photo._id),
    createdAt: photo.createdAt,
  };
}

/** For other viewers. Callers must pass approved photos of an eligible owner only. */
export interface PublicPhotoDTO {
  id: string;
  order: number;
  width: number;
  height: number;
  contentVersion: number;
  media: MediaPaths;
}

export function toPublicPhotoDTO(photo: PhotoDocument): PublicPhotoDTO {
  return {
    id: photo._id,
    order: photo.order,
    width: photo.width,
    height: photo.height,
    contentVersion: photo.contentVersion,
    media: mediaPaths(photo._id),
  };
}
