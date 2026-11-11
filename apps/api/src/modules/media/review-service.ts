/**
 * Manual photo review (pilot workflow, P-08).
 *
 * - Only pending photos can be reviewed; nothing is ever auto-approved.
 * - Every decision writes an auditLog entry: actor, target, reason,
 *   before/after state and timestamp.
 * - The state change is a compare-and-set on `pending`, so two reviewers
 *   cannot both apply a decision.
 *
 * The role-checked admin API (modules/admin) runs applyPhotoDecision and its
 * adminAuditLog entry in one Mongo transaction. reviewPhoto below is the
 * dev-only script path and keeps its legacy auditLog entry.
 */

import type { ClientSession, Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { recomputeReadiness } from '../profiles/readiness-service.js';
import { bumpPhotoSetRevision } from './photo-set.js';
import { PhotoState, type AuditLogDocument, type PhotoDocument } from './schema.js';

/** Respectful, actionable reasons shown to the photo owner. */
export const REJECTION_REASONS = {
  face_not_clear: 'We could not clearly see you in this photo. Please choose one where your face is easy to see.',
  multiple_people: 'It is hard to tell which person is you. Please choose a photo where you are the clear focus.',
  low_quality: 'This photo is too blurry or dark to use. Please try a clearer one.',
  contact_details: 'Photos cannot include phone numbers, usernames or other contact details. Please choose another photo.',
  community_guidelines: 'This photo does not fit our community guidelines. Please choose a different photo.',
} as const;

export type RejectionReasonCode = keyof typeof REJECTION_REASONS;

export interface RejectionReason {
  code: string;
  message: string;
}

export function isRejectionReasonCode(value: unknown): value is RejectionReasonCode {
  return typeof value === 'string' && Object.hasOwn(REJECTION_REASONS, value);
}

export function describeRejection(code: string | null): RejectionReason {
  if (isRejectionReasonCode(code)) return { code, message: REJECTION_REASONS[code] };
  return { code: 'community_guidelines', message: REJECTION_REASONS.community_guidelines };
}

export type ReviewDecision = 'approve' | 'reject';

export class ReviewError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'PHOTO_NOT_FOUND' | 'PHOTO_NOT_PENDING',
    message: string,
  ) {
    super(message);
  }
}

export interface PhotoDecisionResult {
  photo: PhotoDocument; // as it was before the decision
  before: { state: PhotoDocument['state']; moderationReason: string | null };
  after: { state: PhotoDocument['state']; moderationReason: string | null };
  decidedAt: Date;
}

function validateDecision(decision: ReviewDecision, reason: string | null): void {
  if (decision !== 'approve' && decision !== 'reject') {
    throw new ReviewError('INVALID_INPUT', 'Decision must be "approve" or "reject"');
  }
  if (decision === 'reject' && !isRejectionReasonCode(reason)) {
    throw new ReviewError(
      'INVALID_INPUT',
      `Rejection reason must be one of: ${Object.keys(REJECTION_REASONS).join(', ')}`,
    );
  }
}

/**
 * Compare-and-set a pending photo to approved/rejected. Writes only the photo,
 * so callers can run it inside their own transaction (pass `session`) next to
 * an audit entry; finishPhotoDecision runs the follow-ups after commit.
 */
export async function applyPhotoDecision(
  db: Db,
  photoId: string,
  decision: ReviewDecision,
  reason: string | null,
  options: { session?: ClientSession; now?: Date } = {},
): Promise<PhotoDecisionResult> {
  validateDecision(decision, reason);
  const { session } = options;

  const photos = db.collection<PhotoDocument>('photos');
  const photo = await photos.findOne({ _id: photoId }, { session });
  if (!photo) throw new ReviewError('PHOTO_NOT_FOUND', `Photo ${photoId} not found`);
  if (photo.state !== PhotoState.PENDING) {
    throw new ReviewError('PHOTO_NOT_PENDING', `Photo ${photoId} is ${photo.state}, not pending`);
  }

  const decidedAt = options.now ?? new Date();
  const after = {
    state: decision === 'approve' ? PhotoState.APPROVED : PhotoState.REJECTED,
    moderationReason: decision === 'reject' ? reason : null,
  };

  const result = await photos.updateOne(
    { _id: photoId, state: PhotoState.PENDING },
    { $set: { ...after, reviewedAt: decidedAt, updatedAt: decidedAt } },
    { session },
  );
  if (result.matchedCount === 0) {
    throw new ReviewError('PHOTO_NOT_PENDING', `Photo ${photoId} was changed during review`);
  }

  return {
    photo,
    before: { state: photo.state, moderationReason: photo.moderationReason },
    after,
    decidedAt,
  };
}

/** After the decision commits: a rejection leaves the orderable set; readiness may change. */
export async function finishPhotoDecision(db: Db, ownerId: string, decision: ReviewDecision): Promise<void> {
  if (decision === 'reject') await bumpPhotoSetRevision(db, ownerId);
  await recomputeReadiness(db, ownerId);
}

/**
 * Approve or reject a pending photo (dev script path; the admin API wraps
 * applyPhotoDecision in a transaction with its own audit entry instead).
 * `reason` is required for rejections (a REJECTION_REASONS code) and an
 * optional audit note for approvals.
 */
export async function reviewPhoto(
  db: Db,
  photoId: string,
  decision: ReviewDecision,
  reason: string | null,
  actorId: string,
): Promise<PhotoDocument> {
  if (typeof actorId !== 'string' || actorId.trim().length === 0) {
    throw new ReviewError('INVALID_INPUT', 'A reviewer actorId is required');
  }
  const { photo, before, after, decidedAt } = await applyPhotoDecision(db, photoId, decision, reason);

  const entry: AuditLogDocument = {
    _id: uuidv4(),
    action: `photo.${decision}`,
    actorId: actorId.trim(),
    targetType: 'photo',
    targetId: photoId,
    targetOwnerId: photo.ownerId,
    reason,
    before,
    after,
    createdAt: decidedAt,
  };
  await db.collection<AuditLogDocument>('auditLog').insertOne(entry);

  await finishPhotoDecision(db, photo.ownerId, decision);

  return { ...photo, ...after, reviewedAt: decidedAt, updatedAt: decidedAt };
}
