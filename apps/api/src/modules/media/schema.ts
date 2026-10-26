/**
 * Photo metadata (MongoDB). Image bytes live in MediaStorage, never in Mongo.
 *
 * Lifecycle:
 *   processing → pending → approved | rejected
 *   any non-terminal state → deleted (owner removal; tombstone kept for like context)
 *   processing → failed (storage write failed or upload abandoned; worker purges)
 *
 * Only `approved` photos count toward readiness or are visible to other users.
 * Nothing moves to `approved` except an audited review.
 */

export const PhotoState = {
  PROCESSING: 'processing',
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  DELETED: 'deleted',
  FAILED: 'failed',
} as const;

export type PhotoStateType = (typeof PhotoState)[keyof typeof PhotoState];

/** Photos that occupy one of the owner's slots and take part in ordering. */
export const ACTIVE_PHOTO_STATES: PhotoStateType[] = [
  PhotoState.PROCESSING,
  PhotoState.PENDING,
  PhotoState.APPROVED,
];

/** Photos the owner sees in their photo editor. */
export const OWNER_VISIBLE_PHOTO_STATES: PhotoStateType[] = [...ACTIVE_PHOTO_STATES, PhotoState.REJECTED];

export const MIN_PHOTOS = 3;
export const MAX_PHOTOS = 6;

export type PhotoVariant = 'thumb' | 'display';
export const PHOTO_VARIANTS: readonly PhotoVariant[] = ['thumb', 'display'];

export interface PhotoDocument {
  _id: string; // asset ID, server-generated
  ownerId: string;
  state: PhotoStateType;
  /** Normalized, metadata-free master. The raw upload is never persisted. */
  originalPrivateKey: string;
  variantKeys: Record<PhotoVariant, string>;
  width: number;
  height: number;
  order: number;
  contentVersion: number;
  /** Rejection reason code (see REJECTION_REASONS); null unless rejected. */
  moderationReason: string | null;
  /** Unset once an upload fails so the client can retry with the same key. */
  idempotencyKey?: string;
  /** SHA-256 of the uploaded bytes, binding the idempotency key to one request. */
  requestHash: string;
  reviewedAt: Date | null;
  deletedAt: Date | null;
  objectsPurgedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Per-owner photo set: its revision guards reorder and slot changes. */
export interface PhotoSetDocument {
  _id: string; // same as ownerId
  ownerId: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuditLogDocument {
  _id: string;
  action: string;
  actorId: string;
  targetType: 'photo';
  targetId: string;
  targetOwnerId: string;
  reason: string | null;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  createdAt: Date;
}

export function photoObjectKeys(ownerId: string, assetId: string) {
  return {
    originalPrivateKey: `quarantine/${ownerId}/${assetId}`,
    variantKeys: {
      thumb: `public-variants/${assetId}/thumb`,
      display: `public-variants/${assetId}/display`,
    } satisfies Record<PhotoVariant, string>,
  };
}

export function allObjectKeys(photo: Pick<PhotoDocument, 'originalPrivateKey' | 'variantKeys'>): string[] {
  return [photo.originalPrivateKey, ...PHOTO_VARIANTS.map((v) => photo.variantKeys[v])];
}
