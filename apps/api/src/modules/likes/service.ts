/**
 * Like service: send, decline and list incoming likes.
 *
 * Sending runs in one MongoDB transaction: recipient, pair and target checks,
 * then the daily charge, then the insert. A rejected or rolled-back like
 * therefore charges nothing, and the unique indexes (not application reads)
 * are the final word on duplicates.
 */

import { v4 as uuidv4 } from 'uuid';
import type { ClientSession, Collection, Db, Filter, TransactionOptions } from 'mongodb';
import { isDuplicateKeyError } from '../../indexes.js';
import { canInteract, type UserDocument } from '../auth/account.js';
import { findPrompt } from '../catalogs/data.js';
import type { PromptAnswerDocument } from '../profiles/schema.js';
import { PhotoState, type PhotoDocument } from '../media/schema.js';
import type { PairGuard } from './pair-guard.js';
import {
  consumeLikeQuota, getQuotaStatus, QUOTAS_COLLECTION,
  type QuotaDocument, type QuotaPolicy, type QuotaStatus,
} from './quota.js';
import { LIKES_COLLECTION, type LikeContextSnapshot, type LikeDocument, type LikeTarget } from './schema.js';
import type { IncomingCursor, SendLikeInput } from './validation.js';

export interface LikeServiceDeps {
  db: Db;
  policy: QuotaPolicy;
  pairGuard: PairGuard;
  now: () => Date;
}

export type LikeErrorCode =
  | 'ACCOUNT_NOT_ELIGIBLE'
  | 'ACCOUNT_PAUSED'
  | 'SELF_LIKE'
  | 'PROFILE_UNAVAILABLE'
  | 'TARGET_UNAVAILABLE'
  | 'TARGET_STALE'
  | 'ALREADY_LIKED'
  | 'INCOMING_LIKE_PENDING'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'QUOTA_EXHAUSTED'
  | 'LIKE_NOT_FOUND'
  | 'LIKE_ALREADY_DECIDED';

export class LikeError extends Error {
  constructor(
    readonly status: number,
    readonly code: LikeErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const profileUnavailable = () =>
  new LikeError(404, 'PROFILE_UNAVAILABLE', 'This profile is not available');
const targetUnavailable = () =>
  new LikeError(409, 'TARGET_UNAVAILABLE', 'This profile item changed. Refresh the profile and try again.');

const TXN_OPTIONS: TransactionOptions = {
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' },
  readPreference: 'primary',
};

/** Who may appear to others in likes: active, ready and not paused */
export function isAvailableToOthers(user: UserDocument | null): user is UserDocument {
  return user !== null && canInteract(user.accountStatus) && user.profileReady && !user.discoverPaused;
}

function collections(db: Db) {
  return {
    users: db.collection<UserDocument>('users'),
    photos: db.collection<PhotoDocument>('photos'),
    promptAnswers: db.collection<PromptAnswerDocument>('promptAnswers'),
    likes: db.collection<LikeDocument>(LIKES_COLLECTION),
    quotas: db.collection<QuotaDocument>(QUOTAS_COLLECTION),
  };
}

// --- Send ---------------------------------------------------------------------

export interface SendLikeOutcome {
  created: boolean;
  like: LikeDocument;
  quota: QuotaStatus;
}

/** Sender-side eligibility; throws LikeError */
export function assertCanSend(sender: UserDocument): void {
  if (!canInteract(sender.accountStatus) || !sender.profileReady) {
    throw new LikeError(403, 'ACCOUNT_NOT_ELIGIBLE', 'Complete your profile to send likes');
  }
  if (sender.discoverPaused) {
    throw new LikeError(403, 'ACCOUNT_PAUSED', 'Your profile is paused. Resume it to send likes.');
  }
}

function samePayload(like: LikeDocument, input: SendLikeInput): boolean {
  return like.toUserId === input.toUserId
    && like.target.kind === input.target.kind
    && like.target.id === input.target.id
    && like.target.contentVersion === input.target.contentVersion
    && (like.comment ?? null) === input.comment;
}

/**
 * Validate the target against the recipient's current published content and
 * capture the context snapshot. Unknown, foreign, unpublished and removed
 * targets look the same to the sender.
 */
async function resolveTarget(
  deps: LikeServiceDeps,
  target: LikeTarget,
  recipientId: string,
  session: ClientSession,
): Promise<LikeContextSnapshot> {
  const { photos, promptAnswers } = collections(deps.db);
  if (target.kind === 'photo') {
    const photo = await photos.findOne({ _id: target.id, ownerId: recipientId }, { session });
    if (!photo || photo.state !== PhotoState.APPROVED) throw targetUnavailable();
    if (photo.contentVersion !== target.contentVersion) {
      throw new LikeError(409, 'TARGET_STALE', 'This photo changed. Refresh the profile and try again.');
    }
    return { kind: 'photo', width: photo.width, height: photo.height };
  }

  const answer = await promptAnswers.findOne({ _id: target.id, ownerId: recipientId }, { session });
  // Only published text counts; a newer edit awaiting review is never exposed
  if (!answer || answer.approvedText === null) throw targetUnavailable();
  if (answer.publishedRevision !== target.contentVersion) {
    throw new LikeError(409, 'TARGET_STALE', 'This answer changed. Refresh the profile and try again.');
  }
  return {
    kind: 'prompt',
    promptId: answer.promptId,
    promptText: findPrompt(answer.promptId)?.text ?? '',
    answerText: answer.approvedText,
  };
}

/**
 * Send a like. The caller has authenticated `sender` and checked the
 * Idempotency-Key format. Throws LikeError for every rejection.
 */
export async function sendLike(
  deps: LikeServiceDeps,
  sender: UserDocument,
  input: SendLikeInput,
  idempotencyKey: string,
): Promise<SendLikeOutcome> {
  const { db, policy, pairGuard } = deps;
  const { users, likes, quotas } = collections(db);
  const fromUserId = sender._id;
  const toUserId = input.toUserId;
  const now = deps.now();

  // A retry returns the original outcome, whatever changed since
  const replay = async (like: LikeDocument): Promise<SendLikeOutcome> => {
    if (!samePayload(like, input)) {
      throw new LikeError(409, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different like.');
    }
    return { created: false, like, quota: await getQuotaStatus(quotas, fromUserId, now, policy) };
  };

  const previous = await likes.findOne({ fromUserId, idempotencyKey });
  if (previous) return replay(previous);

  assertCanSend(sender);
  if (toUserId === fromUserId) throw new LikeError(422, 'SELF_LIKE', 'You cannot like your own profile');

  const session = db.client.startSession();
  let result: { like: LikeDocument; quota?: QuotaStatus };
  try {
    // The callback is retried on transient errors (e.g. a concurrent charge), so it re-reads everything
    result = await session.withTransaction(async () => {
      const raced = await likes.findOne({ fromUserId, idempotencyKey }, { session });
      if (raced) return { like: raced };

      const recipient = await users.findOne({ _id: toUserId }, { session });
      if (!isAvailableToOthers(recipient)) throw profileUnavailable();
      const pair = await pairGuard.check({ fromUserId, toUserId, session });
      if (!pair.ok) throw profileUnavailable();

      const contextSnapshot = await resolveTarget(deps, input.target, toUserId, session);

      // Fast paths only; the unique indexes decide under concurrency
      if (await likes.findOne({ fromUserId, toUserId }, { session, projection: { _id: 1 } })) {
        throw new LikeError(409, 'ALREADY_LIKED', 'You already liked this person');
      }
      // TODO(Phase 09): mutual interest becomes a match through the canonical pair instead
      if (await likes.findOne({ fromUserId: toUserId, toUserId: fromUserId, state: 'pending' }, { session, projection: { _id: 1 } })) {
        throw new LikeError(409, 'INCOMING_LIKE_PENDING', 'This person already liked you. Answer their like in Likes.');
      }

      const charge = await consumeLikeQuota(quotas, fromUserId, now, policy, session);
      if (!charge.ok) {
        throw new LikeError(429, 'QUOTA_EXHAUSTED', 'You have used all of today\'s likes', {
          limit: charge.limit,
          resetAt: charge.resetAt,
        });
      }

      const like: LikeDocument = {
        _id: uuidv4(),
        fromUserId,
        toUserId,
        target: { ...input.target },
        ...(input.comment !== null ? { comment: input.comment } : {}),
        contextSnapshot,
        state: 'pending',
        idempotencyKey,
        createdAt: now,
        updatedAt: now,
      };
      await likes.insertOne(like, { session });
      await pairGuard.touch({ fromUserId, toUserId, session, action: 'like', likeId: like._id });
      const { ok: _ok, ...quota } = charge;
      return { like, quota };
    }, TXN_OPTIONS);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    // Lost to a committed like for the same key or the same direction
    const byKey = await likes.findOne({ fromUserId, idempotencyKey });
    if (byKey) return replay(byKey);
    throw new LikeError(409, 'ALREADY_LIKED', 'You already liked this person');
  } finally {
    await session.endSession();
  }

  if (!result.quota) return replay(result.like);
  return { created: true, like: result.like, quota: result.quota };
}

// --- Decline --------------------------------------------------------------------

/**
 * Decline an incoming like. Idempotent; terminal for that direction in v1.
 * Recipient-only: anyone else gets LIKE_NOT_FOUND. Charges nothing.
 */
export async function declineLike(deps: LikeServiceDeps, recipient: UserDocument, likeId: string): Promise<LikeDocument> {
  const { likes } = collections(deps.db);
  const filter: Filter<LikeDocument> = { _id: likeId, toUserId: recipient._id };

  const settled = (like: LikeDocument | null): LikeDocument => {
    if (!like) throw new LikeError(404, 'LIKE_NOT_FOUND', 'This like is no longer available');
    if (like.state === 'declined') return like;
    throw new LikeError(409, 'LIKE_ALREADY_DECIDED', 'This like was already answered');
  };

  const current = await likes.findOne(filter);
  if (!current || current.state !== 'pending') return settled(current);

  const now = deps.now();
  const session = deps.db.client.startSession();
  try {
    return await session.withTransaction(async () => {
      // Compare-and-set on pending, so concurrent declines (and Phase 09 accepts) settle once
      const updated = await likes.findOneAndUpdate(
        { ...filter, state: 'pending' },
        { $set: { state: 'declined', decidedAt: now, updatedAt: now } },
        { session, returnDocument: 'after' },
      );
      if (!updated) return settled(await likes.findOne(filter, { session }));
      await deps.pairGuard.touch({
        fromUserId: updated.fromUserId, toUserId: updated.toUserId, session, action: 'decline', likeId,
      });
      return updated;
    }, TXN_OPTIONS);
  } finally {
    await session.endSession();
  }
}

/** Recipient-only lookup (accept placeholder); throws LIKE_NOT_FOUND for anyone else */
export async function findIncomingLike(deps: LikeServiceDeps, recipient: UserDocument, likeId: string): Promise<LikeDocument> {
  const like = await collections(deps.db).likes.findOne({ _id: likeId, toUserId: recipient._id });
  if (!like) throw new LikeError(404, 'LIKE_NOT_FOUND', 'This like is no longer available');
  return like;
}

// --- Incoming list ----------------------------------------------------------------

/** Likes scanned per query, and per request at most, while skipping hidden senders */
const SCAN_BATCH = 50;
const MAX_SCANNED = 200;

export interface IncomingItem {
  like: LikeDocument;
  sender: UserDocument;
}

export interface IncomingPage {
  items: IncomingItem[];
  /** Position after the last scanned like; null at the end of the list */
  next: IncomingCursor | null;
}

/**
 * Pending likes for the recipient, newest first, from senders who are
 * currently available. Hidden likes are scanned past (and stay stored), so the
 * cursor never skips or repeats visible ones. A page can be short when many
 * senders are hidden; keep paging until `next` is null.
 */
export async function listIncoming(
  deps: LikeServiceDeps,
  recipient: UserDocument,
  cursor: IncomingCursor | null,
  limit: number,
): Promise<IncomingPage> {
  const { users, likes } = collections(deps.db);
  const items: IncomingItem[] = [];
  let position = cursor;
  let scanned = 0;

  while (items.length < limit && scanned < MAX_SCANNED) {
    const filter: Filter<LikeDocument> = { toUserId: recipient._id, state: 'pending' };
    if (position) {
      filter.$or = [
        { createdAt: { $lt: position.createdAt } },
        { createdAt: position.createdAt, _id: { $lt: position.id } },
      ];
    }
    // One extra document shows whether anything follows the batch
    const batch = await likes.find(filter).sort({ createdAt: -1, _id: -1 }).limit(SCAN_BATCH + 1).toArray();
    const window = batch.slice(0, SCAN_BATCH);
    const senders = await availableSenders(deps, users, recipient._id, window);

    let consumed = 0;
    for (const like of window) {
      consumed++;
      scanned++;
      position = { createdAt: like.createdAt, id: like._id };
      const sender = senders.get(like.fromUserId);
      if (sender) items.push({ like, sender });
      if (items.length === limit) break;
    }
    if (consumed === batch.length) return { items, next: null }; // reached the end
  }
  return { items, next: position };
}

async function availableSenders(
  deps: LikeServiceDeps,
  users: Collection<UserDocument>,
  recipientId: string,
  window: LikeDocument[],
): Promise<Map<string, UserDocument>> {
  const ids = [...new Set(window.map(l => l.fromUserId))];
  if (ids.length === 0) return new Map();
  const found = await users.find({
    _id: { $in: ids },
    accountStatus: 'active',
    profileReady: true,
    discoverPaused: { $ne: true },
  }).toArray();
  const available = new Map<string, UserDocument>();
  for (const user of found) {
    if (!isAvailableToOthers(user)) continue;
    const pair = await deps.pairGuard.check({ fromUserId: user._id, toUserId: recipientId });
    if (pair.ok) available.set(user._id, user);
  }
  return available;
}
