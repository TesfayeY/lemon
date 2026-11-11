/**
 * Content-level likes (Phase 08).
 *
 * Shared data contract — discovery reads this collection, so keep the shape
 * and indexes stable:
 * - one like per direction ever in v1 (unique fromUserId+toUserId; decline is terminal)
 * - idempotency keys are scoped to the sender (unique fromUserId+idempotencyKey)
 * - the incoming list reads toUserId+state+createdAt
 * User IDs are the opaque app user IDs used as profiles/preferences `_id`.
 * The indexes are created in src/indexes.ts.
 */

export const LIKES_COLLECTION = 'likes';

export type LikeTargetKind = 'photo' | 'prompt';
export type LikeState = 'pending' | 'declined' | 'accepted';

export interface LikeTarget {
  kind: LikeTargetKind;
  /** Stable photo ID or prompt answer ID */
  id: string;
  /** Photo contentVersion, or the prompt answer's publishedRevision */
  contentVersion: number;
}

/**
 * Minimal context captured at send time so the recipient understands the like
 * after later edits. It holds only the recipient's own published content —
 * never storage keys, media URLs or moderation data.
 */
export type LikeContextSnapshot =
  | { kind: 'photo'; width: number; height: number }
  | { kind: 'prompt'; promptId: string; promptText: string; answerText: string };

export interface LikeDocument {
  _id: string;
  fromUserId: string;
  toUserId: string;
  target: LikeTarget;
  /** Whitespace-normalized, NFC, at most 200 grapheme clusters; absent when none */
  comment?: string;
  contextSnapshot: LikeContextSnapshot;
  state: LikeState;
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
  decidedAt?: Date;
}

/** Optional comment limit, in grapheme clusters */
export const COMMENT_MAX_GRAPHEMES = 200;
