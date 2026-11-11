/**
 * Staff review and account actions.
 *
 * Every decision runs in one Mongo transaction that (1) compare-and-sets the
 * target on the state/version the reviewer acted on and (2) appends the audit
 * entry. Two staff members deciding the same item: one commits, the other's
 * transaction re-reads the decided state and fails with a conflict, writing
 * nothing. Readiness and photo-set follow-ups run after commit through the
 * owning modules' functions (recomputeReadiness is idempotent).
 *
 * Staff DTOs carry only what a reviewer needs: the item, the owner's app user
 * ID, display name and account status. Never DOB, email or Firebase UID.
 */

import { createHash } from 'node:crypto';
import type { ClientSession, Db, Filter, MongoClient } from 'mongodb';
import { AccountStatus, type AccountStatusType, type UserDocument } from '../auth/account.js';
import { findPrompt } from '../catalogs/data.js';
import { applyPhotoDecision, describeRejection, finishPhotoDecision, ReviewError, type ReviewDecision } from '../media/review-service.js';
import { PhotoState, type PhotoDocument, type PhotoStateType, type PhotoVariant } from '../media/schema.js';
import {
  applyPromptDecision, describePromptRejection, finishPromptDecision, PromptReviewError, type PromptRejectionDTO,
} from '../profiles/prompt-review.js';
import { recomputeReadiness } from '../profiles/readiness-service.js';
import type { ProfileDocument, PromptAnswerDocument } from '../profiles/schema.js';
import { appendAuditEntry, type AdminAuditEntry, type AuditInput } from './audit.js';
import { encodeQueueCursor, type QueueCursor } from './cursor.js';
import type { StaffActor } from './middleware.js';
import type { RestoreReason, SuspensionReason } from './reasons.js';

export class AdminError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
    readonly retryable = false,
  ) {
    super(message);
  }
}

/** Statuses a suspension can start from, and that a restore can return to. */
const SUSPENDABLE: readonly AccountStatusType[] = [AccountStatus.ONBOARDING, AccountStatus.ACTIVE];

export interface SuspensionRecord {
  previousStatus: AccountStatusType;
  reason: SuspensionReason;
  suspendedAt: Date;
}

/** users documents as the admin module writes them; `suspension` exists only while suspended */
type StaffViewUser = UserDocument & { suspension?: SuspensionRecord };

export interface OwnerContext {
  userId: string;
  displayName: string | null;
  accountStatus: AccountStatusType | null;
}

type MediaPaths = Record<PhotoVariant, string>;

export function adminMediaPaths(photoId: string): MediaPaths {
  return {
    thumb: `/v1/admin/content/photos/${photoId}/media/thumb`,
    display: `/v1/admin/content/photos/${photoId}/media/display`,
  };
}

export interface PhotoQueueItem {
  id: string;
  ownerId: string;
  width: number;
  height: number;
  submittedAt: Date;
  media: MediaPaths;
}

export interface PhotoDetail {
  id: string;
  state: PhotoStateType;
  ownerId: string;
  width: number;
  height: number;
  contentVersion: number;
  rejectionReason: { code: string; message: string } | null;
  submittedAt: Date;
  reviewedAt: Date | null;
  media: MediaPaths;
  owner: OwnerContext;
  /** The owner's other current photos, so a reviewer can tell which person is them. */
  ownerPhotos: { id: string; state: PhotoStateType; media: MediaPaths }[];
}

export interface PromptQueueItem {
  id: string;
  ownerId: string;
  promptId: string;
  promptText: string;
  pendingText: string;
  hasPublishedText: boolean;
  revision: number;
  submittedAt: Date;
}

export interface PromptDetail {
  id: string;
  state: PromptAnswerDocument['state'];
  ownerId: string;
  promptId: string;
  promptText: string;
  pendingText: string | null;
  approvedText: string | null;
  revision: number;
  publishedRevision: number;
  rejectionReason: PromptRejectionDTO | null;
  submittedAt: Date;
  owner: OwnerContext;
}

export interface AccountDetail {
  userId: string;
  displayName: string | null;
  accountStatus: AccountStatusType;
  profileReady: boolean;
  guardVersion: number;
  suspension: { reason: SuspensionReason; suspendedAt: Date } | null;
  createdAt: Date;
}

export interface QueuePage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface DecisionInput {
  decision: ReviewDecision;
  reason: string | null;
  note: string | null;
}

export interface AccountActionInput<R extends string> {
  reason: R;
  note: string | null;
}

/** Statuses a staff member can open; failed/processing/deleted photos have no reviewable content */
const VIEWABLE_PHOTO_STATES: PhotoStateType[] = [PhotoState.PENDING, PhotoState.APPROVED, PhotoState.REJECTED];

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

function afterCursor(field: 'createdAt' | 'updatedAt', cursor: QueueCursor | null): Record<string, unknown> {
  if (!cursor) return {};
  return { $or: [{ [field]: { $gt: cursor.at } }, { [field]: cursor.at, _id: { $gt: cursor.id } }] };
}

export interface AdminServiceDeps {
  now?: () => Date;
  /**
   * Test seam: runs inside the decision transaction right after the audit
   * entry is written. Throwing here must roll back both the decision and the entry.
   */
  afterAuditWrite?: (entry: AdminAuditEntry) => Promise<void>;
}

export function createAdminService(db: Db, client: MongoClient, deps: AdminServiceDeps = {}) {
  const now = deps.now ?? (() => new Date());

  async function recordAudit(input: AuditInput, session: ClientSession): Promise<AdminAuditEntry> {
    const entry = await appendAuditEntry(db, input, session);
    await deps.afterAuditWrite?.(entry);
    return entry;
  }
  const users = db.collection<StaffViewUser>('users');
  const profiles = db.collection<ProfileDocument>('profiles');
  const photos = db.collection<PhotoDocument>('photos');
  const answers = db.collection<PromptAnswerDocument>('promptAnswers');

  async function inTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = client.startSession();
    try {
      return await session.withTransaction(work, {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
      });
    } finally {
      await session.endSession();
    }
  }

  async function ownerContext(userId: string): Promise<OwnerContext> {
    const [user, profile] = await Promise.all([
      users.findOne({ _id: userId }, { projection: { accountStatus: 1 } }),
      profiles.findOne({ userId }, { projection: { displayName: 1 } }),
    ]);
    return { userId, displayName: profile?.displayName ?? null, accountStatus: user?.accountStatus ?? null };
  }

  /** Staff who are also members never decide on their own content or account. */
  async function assertNotSelf(actor: StaffActor, ownerId: string): Promise<void> {
    const owner = await users.findOne({ _id: ownerId }, { projection: { firebaseUid: 1 } });
    if (owner && owner.firebaseUid === actor.uid) {
      throw new AdminError(403, 'SELF_ACTION_FORBIDDEN', 'Staff cannot act on their own account or content');
    }
  }

  // --- Photos ---

  async function listPendingPhotos(cursor: QueueCursor | null, limit: number): Promise<QueuePage<PhotoQueueItem>> {
    const filter = { state: PhotoState.PENDING, ...afterCursor('createdAt', cursor) } as Filter<PhotoDocument>;
    const docs = await photos.find(filter).sort({ createdAt: 1, _id: 1 }).limit(limit + 1).toArray();
    const page = docs.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((p) => ({
        id: p._id, ownerId: p.ownerId, width: p.width, height: p.height, submittedAt: p.createdAt, media: adminMediaPaths(p._id),
      })),
      nextCursor: docs.length > limit && last ? encodeQueueCursor({ at: last.createdAt, id: last._id }) : null,
    };
  }

  async function findViewablePhoto(photoId: string): Promise<PhotoDocument | null> {
    return photos.findOne({ _id: photoId, state: { $in: VIEWABLE_PHOTO_STATES } });
  }

  async function getPhoto(photoId: string): Promise<PhotoDetail | null> {
    const photo = await findViewablePhoto(photoId);
    if (!photo) return null;
    const others = await photos
      .find({ ownerId: photo.ownerId, _id: { $ne: photo._id }, state: { $in: VIEWABLE_PHOTO_STATES } })
      .sort({ order: 1 })
      .toArray();
    return {
      id: photo._id,
      state: photo.state,
      ownerId: photo.ownerId,
      width: photo.width,
      height: photo.height,
      contentVersion: photo.contentVersion,
      rejectionReason: photo.state === PhotoState.REJECTED ? describeRejection(photo.moderationReason) : null,
      submittedAt: photo.createdAt,
      reviewedAt: photo.reviewedAt ?? null,
      media: adminMediaPaths(photo._id),
      owner: await ownerContext(photo.ownerId),
      ownerPhotos: others.map((p) => ({ id: p._id, state: p.state, media: adminMediaPaths(p._id) })),
    };
  }

  async function decidePhoto(actor: StaffActor, photoId: string, input: DecisionInput, requestId: string) {
    const existing = await photos.findOne({ _id: photoId }, { projection: { ownerId: 1 } });
    if (!existing) throw new AdminError(404, 'NOT_FOUND', 'Photo not found');
    await assertNotSelf(actor, existing.ownerId);

    let outcome: { photo: PhotoDocument; after: { state: PhotoStateType; moderationReason: string | null }; audit: AdminAuditEntry };
    try {
      outcome = await inTransaction(async (session) => {
        const decided = await applyPhotoDecision(db, photoId, input.decision, input.reason, { session, now: now() });
        const audit = await recordAudit({
          actor,
          action: `photo.${input.decision}`,
          targetType: 'photo',
          targetId: photoId,
          targetOwnerId: decided.photo.ownerId,
          reason: input.reason,
          note: input.note,
          before: decided.before,
          after: decided.after,
          requestId,
          createdAt: decided.decidedAt,
        }, session);
        return { photo: decided.photo, after: decided.after, audit };
      });
    } catch (err) {
      if (err instanceof ReviewError) {
        if (err.code === 'PHOTO_NOT_FOUND') throw new AdminError(404, 'NOT_FOUND', 'Photo not found');
        if (err.code === 'PHOTO_NOT_PENDING') {
          throw new AdminError(409, 'REVIEW_CONFLICT', 'This photo was already decided or removed. Refresh the queue.');
        }
        throw new AdminError(422, 'VALIDATION_ERROR', err.message);
      }
      throw err;
    }

    await finishPhotoDecision(db, outcome.photo.ownerId, input.decision);
    return {
      id: photoId,
      state: outcome.after.state,
      rejectionReason: outcome.after.state === PhotoState.REJECTED ? describeRejection(outcome.after.moderationReason) : null,
      auditId: outcome.audit._id,
    };
  }

  // --- Prompt answers ---

  async function listPendingPromptAnswers(cursor: QueueCursor | null, limit: number): Promise<QueuePage<PromptQueueItem>> {
    // An edit moves an answer's submission time, so it rejoins the queue at the back
    const filter = { state: 'pending', pendingText: { $ne: null }, ...afterCursor('updatedAt', cursor) } as Filter<PromptAnswerDocument>;
    const docs = await answers.find(filter).sort({ updatedAt: 1, _id: 1 }).limit(limit + 1).toArray();
    const page = docs.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((a) => ({
        id: a._id,
        ownerId: a.ownerId,
        promptId: a.promptId,
        promptText: findPrompt(a.promptId)?.text ?? '',
        pendingText: a.pendingText ?? '',
        hasPublishedText: a.approvedText !== null,
        revision: a.revision,
        submittedAt: a.updatedAt,
      })),
      nextCursor: docs.length > limit && last ? encodeQueueCursor({ at: last.updatedAt, id: last._id }) : null,
    };
  }

  async function getPromptAnswer(answerId: string): Promise<PromptDetail | null> {
    const answer = await answers.findOne({ _id: answerId });
    if (!answer) return null;
    return {
      id: answer._id,
      state: answer.state,
      ownerId: answer.ownerId,
      promptId: answer.promptId,
      promptText: findPrompt(answer.promptId)?.text ?? '',
      pendingText: answer.pendingText,
      approvedText: answer.approvedText,
      revision: answer.revision,
      publishedRevision: answer.publishedRevision,
      rejectionReason: answer.state === 'rejected' ? describePromptRejection(answer.rejectionReason) : null,
      submittedAt: answer.updatedAt,
      owner: await ownerContext(answer.ownerId),
    };
  }

  async function decidePromptAnswer(
    actor: StaffActor,
    answerId: string,
    input: DecisionInput & { expectedRevision: number },
    requestId: string,
  ) {
    const existing = await answers.findOne({ _id: answerId }, { projection: { ownerId: 1 } });
    if (!existing) throw new AdminError(404, 'NOT_FOUND', 'Prompt answer not found');
    await assertNotSelf(actor, existing.ownerId);

    let outcome: { ownerId: string; after: { state: string; publishedRevision: number; rejectionReason: string | null }; audit: AdminAuditEntry };
    try {
      outcome = await inTransaction(async (session) => {
        const decided = await applyPromptDecision(db, answerId, input.decision, input.reason, {
          expectedRevision: input.expectedRevision,
          session,
          now: now(),
        });
        const audit = await recordAudit({
          actor,
          action: `prompt_answer.${input.decision}`,
          targetType: 'promptAnswer',
          targetId: answerId,
          targetOwnerId: decided.answer.ownerId,
          reason: input.reason,
          note: input.note,
          before: { ...decided.before, pendingTextSha256: sha256(decided.answer.pendingText ?? '') },
          after: { ...decided.after },
          requestId,
          createdAt: decided.decidedAt,
        }, session);
        return { ownerId: decided.answer.ownerId, after: decided.after, audit };
      });
    } catch (err) {
      if (err instanceof PromptReviewError) {
        if (err.code === 'ANSWER_NOT_FOUND') throw new AdminError(404, 'NOT_FOUND', 'Prompt answer not found');
        if (err.code === 'INVALID_INPUT') throw new AdminError(422, 'VALIDATION_ERROR', err.message);
        const extra = err.currentRevision === undefined ? {} : { currentRevision: err.currentRevision };
        throw new AdminError(409, 'REVIEW_CONFLICT', 'This answer was already decided or edited. Refresh and review it again.', extra);
      }
      throw err;
    }

    await finishPromptDecision(db, outcome.ownerId);
    return {
      id: answerId,
      state: outcome.after.state,
      publishedRevision: outcome.after.publishedRevision,
      rejectionReason: outcome.after.state === 'rejected' ? describePromptRejection(outcome.after.rejectionReason) : null,
      auditId: outcome.audit._id,
    };
  }

  // --- Accounts ---

  function toAccountDetail(user: StaffViewUser, displayName: string | null): AccountDetail {
    return {
      userId: user._id,
      displayName,
      accountStatus: user.accountStatus,
      profileReady: user.profileReady,
      guardVersion: user.guardVersion,
      suspension: user.suspension ? { reason: user.suspension.reason, suspendedAt: user.suspension.suspendedAt } : null,
      createdAt: user.createdAt,
    };
  }

  async function getAccount(userId: string): Promise<AccountDetail | null> {
    const user = await users.findOne({ _id: userId });
    if (!user) return null;
    const profile = await profiles.findOne({ userId }, { projection: { displayName: 1 } });
    return toAccountDetail(user, profile?.displayName ?? null);
  }

  /**
   * Suspend or restore inside one transaction: compare-and-set on the account
   * status and guardVersion read in the transaction, bump guardVersion so any
   * concurrent guarded pair action fails, and append the audit entry.
   */
  async function changeAccountStatus(
    actor: StaffActor,
    userId: string,
    kind: 'suspend' | 'restore',
    input: AccountActionInput<SuspensionReason | RestoreReason>,
    requestId: string,
  ) {
    await assertNotSelf(actor, userId);

    const audit = await inTransaction(async (session) => {
      const user = await users.findOne({ _id: userId }, { session });
      if (!user) throw new AdminError(404, 'NOT_FOUND', 'Account not found');

      const decidedAt = now();
      let update;
      let nextStatus: AccountStatusType;
      if (kind === 'suspend') {
        if (!SUSPENDABLE.includes(user.accountStatus)) {
          throw new AdminError(409, 'ACCOUNT_STATE_CONFLICT', `An account that is ${user.accountStatus} cannot be suspended`);
        }
        nextStatus = AccountStatus.SUSPENDED;
        const suspension: SuspensionRecord = {
          previousStatus: user.accountStatus,
          reason: input.reason as SuspensionReason,
          suspendedAt: decidedAt,
        };
        update = { $set: { accountStatus: nextStatus, suspension, updatedAt: decidedAt }, $inc: { guardVersion: 1 } };
      } else {
        if (user.accountStatus !== AccountStatus.SUSPENDED) {
          throw new AdminError(409, 'ACCOUNT_STATE_CONFLICT', `An account that is ${user.accountStatus} cannot be restored`);
        }
        const previous = user.suspension?.previousStatus;
        // Readiness recompute below re-activates a ready onboarding account
        nextStatus = previous && SUSPENDABLE.includes(previous) ? previous : AccountStatus.ONBOARDING;
        update = {
          $set: { accountStatus: nextStatus, updatedAt: decidedAt },
          $unset: { suspension: '' as const },
          $inc: { guardVersion: 1 },
        };
      }

      const result = await users.updateOne(
        { _id: userId, accountStatus: user.accountStatus, guardVersion: user.guardVersion },
        update,
        { session },
      );
      if (result.matchedCount === 0) {
        throw new AdminError(409, 'ACCOUNT_STATE_CONFLICT', 'The account changed during this action. Refresh and try again.', {}, true);
      }

      return recordAudit({
        actor,
        action: `account.${kind}`,
        targetType: 'user',
        targetId: userId,
        targetOwnerId: userId,
        reason: input.reason,
        note: input.note,
        before: { accountStatus: user.accountStatus, guardVersion: user.guardVersion },
        after: { accountStatus: nextStatus, guardVersion: user.guardVersion + 1 },
        requestId,
        createdAt: decidedAt,
      }, session);
    });

    // Suspension clears readiness (and so discovery/media visibility); restore re-evaluates it
    await recomputeReadiness(db, userId);
    const account = await getAccount(userId);
    return { account: account!, auditId: audit._id };
  }

  return {
    listPendingPhotos,
    findViewablePhoto,
    getPhoto,
    decidePhoto,
    listPendingPromptAnswers,
    getPromptAnswer,
    decidePromptAnswer,
    getAccount,
    suspendAccount: (actor: StaffActor, userId: string, input: AccountActionInput<SuspensionReason>, requestId: string) =>
      changeAccountStatus(actor, userId, 'suspend', input, requestId),
    restoreAccount: (actor: StaffActor, userId: string, input: AccountActionInput<RestoreReason>, requestId: string) =>
      changeAccountStatus(actor, userId, 'restore', input, requestId),
  };
}

export type AdminService = ReturnType<typeof createAdminService>;
