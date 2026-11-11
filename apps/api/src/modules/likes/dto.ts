/**
 * Explicit allowlisted like DTOs.
 *
 * Never part of any response: birth date, email, Firebase UID, account status,
 * moderation data, storage keys, idempotency keys. The sender never learns
 * whether a like was declined.
 */

import type { Db } from 'mongodb';
import type { UserDocument } from '../auth/account.js';
import { calculateAge } from '../auth/adult-gate.js';
import { findCity } from '../catalogs/data.js';
import { toPublicPhotoDTO, type PublicPhotoDTO } from '../media/dto.js';
import { PhotoState, type PhotoDocument } from '../media/schema.js';
import type { ProfileDocument, PromptAnswerDocument } from '../profiles/schema.js';
import type { QuotaStatus } from './quota.js';
import type { LikeDocument, LikeTarget } from './schema.js';
import type { IncomingItem } from './service.js';

export interface QuotaDTO {
  limit: number;
  used: number;
  remaining: number;
  resetAt: Date;
}

export function toQuotaDTO(quota: QuotaStatus): QuotaDTO {
  return { limit: quota.limit, used: quota.used, remaining: quota.remaining, resetAt: quota.resetAt };
}

/** What the sender sees about a like they sent; deliberately has no state */
export interface OutgoingLikeDTO {
  id: string;
  toUserId: string;
  target: LikeTarget;
  comment: string | null;
  createdAt: Date;
}

export function toOutgoingLikeDTO(like: LikeDocument): OutgoingLikeDTO {
  return {
    id: like._id,
    toUserId: like.toUserId,
    target: { kind: like.target.kind, id: like.target.id, contentVersion: like.target.contentVersion },
    comment: like.comment ?? null,
    createdAt: like.createdAt,
  };
}

export interface LikeSenderDTO {
  userId: string;
  displayName: string | null;
  age: number | null;
  cityName: string | null;
  stateCode: string | null;
  photo: PublicPhotoDTO | null;
}

export type LikeContextDTO =
  | { kind: 'photo'; media: PublicPhotoDTO['media'] | null }
  | { kind: 'prompt'; promptId: string; promptText: string; answerText: string | null };

export interface IncomingLikeDTO {
  id: string;
  sender: LikeSenderDTO;
  target: LikeTarget;
  context: LikeContextDTO;
  /** True when the liked item is no longer available as liked: show "This profile item changed" */
  targetChanged: boolean;
  comment: string | null;
  createdAt: Date;
  /** Accepting arrives with matching (Phase 09) */
  canAccept: boolean;
}

/**
 * Render a page of incoming likes with batched reads.
 *
 * Context rules (the target is the recipient's own content):
 * - unchanged and published: full context, media paths for photos
 * - prompt answer edited and republished: the liked words from the snapshot, flagged changed
 * - removed, unpublished or rejected: no content at all, flagged changed —
 *   removed media is never kept reachable just for context
 */
export async function toIncomingLikeDTOs(db: Db, recipientId: string, items: IncomingItem[], now: Date): Promise<IncomingLikeDTO[]> {
  if (items.length === 0) return [];
  const senderIds = [...new Set(items.map(i => i.sender._id))];
  const photoTargetIds = items.filter(i => i.like.target.kind === 'photo').map(i => i.like.target.id);
  const answerTargetIds = items.filter(i => i.like.target.kind === 'prompt').map(i => i.like.target.id);

  const [profiles, senderPhotos, targetPhotos, targetAnswers] = await Promise.all([
    db.collection<ProfileDocument>('profiles').find({ _id: { $in: senderIds } }).toArray(),
    db.collection<PhotoDocument>('photos')
      .find({ ownerId: { $in: senderIds }, state: PhotoState.APPROVED })
      .sort({ order: 1 })
      .toArray(),
    photoTargetIds.length === 0 ? [] : db.collection<PhotoDocument>('photos')
      .find({ _id: { $in: photoTargetIds }, ownerId: recipientId })
      .toArray(),
    answerTargetIds.length === 0 ? [] : db.collection<PromptAnswerDocument>('promptAnswers')
      .find({ _id: { $in: answerTargetIds }, ownerId: recipientId })
      .toArray(),
  ]);

  const profileById = new Map(profiles.map(p => [p._id, p]));
  const firstPhotoByOwner = new Map<string, PhotoDocument>();
  for (const photo of senderPhotos) {
    if (!firstPhotoByOwner.has(photo.ownerId)) firstPhotoByOwner.set(photo.ownerId, photo);
  }
  const photoById = new Map(targetPhotos.map(p => [p._id, p]));
  const answerById = new Map(targetAnswers.map(a => [a._id, a]));

  return items.map(({ like, sender }) => {
    const { context, targetChanged } = renderContext(like, photoById, answerById);
    return {
      id: like._id,
      sender: toSenderDTO(sender, profileById.get(sender._id) ?? null, firstPhotoByOwner.get(sender._id) ?? null, now),
      target: { kind: like.target.kind, id: like.target.id, contentVersion: like.target.contentVersion },
      context,
      targetChanged,
      comment: like.comment ?? null,
      createdAt: like.createdAt,
      canAccept: false,
    };
  });
}

function toSenderDTO(user: UserDocument, profile: ProfileDocument | null, photo: PhotoDocument | null, now: Date): LikeSenderDTO {
  const city = profile?.cityId ? findCity(profile.cityId) : undefined;
  return {
    userId: user._id,
    displayName: profile?.displayName ?? null,
    age: user.birthDate ? calculateAge(new Date(user.birthDate), now) : null,
    cityName: city?.name ?? null,
    stateCode: profile?.stateCode ?? null,
    photo: photo ? toPublicPhotoDTO(photo) : null,
  };
}

function renderContext(
  like: LikeDocument,
  photoById: Map<string, PhotoDocument>,
  answerById: Map<string, PromptAnswerDocument>,
): { context: LikeContextDTO; targetChanged: boolean } {
  const snapshot = like.contextSnapshot;
  if (snapshot.kind === 'photo') {
    const photo = photoById.get(like.target.id);
    const available = photo !== undefined
      && photo.state === PhotoState.APPROVED
      && photo.contentVersion === like.target.contentVersion;
    return {
      context: { kind: 'photo', media: available ? toPublicPhotoDTO(photo).media : null },
      targetChanged: !available,
    };
  }

  const answer = answerById.get(like.target.id);
  const published = answer !== undefined && answer.approvedText !== null;
  const unchanged = published && answer.publishedRevision === like.target.contentVersion;
  return {
    context: {
      kind: 'prompt',
      promptId: snapshot.promptId,
      promptText: snapshot.promptText,
      answerText: published ? snapshot.answerText : null,
    },
    targetChanged: !unchanged,
  };
}
