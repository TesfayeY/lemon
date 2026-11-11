/**
 * Manual prompt answer review (pilot workflow, P-08).
 *
 * The review shape lives in PromptAnswerDocument: approvedText is published,
 * pendingText waits for review and is never published automatically.
 *
 * - Approve: pendingText becomes approvedText and publishedRevision goes up by one
 *   (the content version likes will pin), so other users see the new text.
 * - Reject: the state becomes 'rejected' with a catalog reason. Any previously
 *   approved text stays published; the rejected text stays visible to its owner
 *   only, so they can replace it.
 *
 * Decisions are compare-and-set on the pending state and the owner's edit
 * revision the reviewer saw: if the owner edits the answer or another reviewer
 * decides first, the write matches nothing and the caller gets a conflict.
 * Pass a session to run the decision inside the caller's transaction (the admin
 * module writes its audit entry in the same transaction).
 */

import type { ClientSession, Db } from 'mongodb';
import { recomputeReadiness } from './readiness-service.js';
import type { PromptAnswerDocument } from './schema.js';

/** Respectful, actionable reasons shown to the answer's owner. Keys are stable API codes. */
export const PROMPT_REJECTION_REASONS = {
  contact_details: {
    messageKey: 'promptRejection.contactDetails',
    message: 'Answers cannot include phone numbers, usernames, links or other contact details. Please rewrite your answer.',
  },
  sexual_content: {
    messageKey: 'promptRejection.sexualContent',
    message: 'This answer is more explicit than our community allows. Please rewrite it.',
  },
  hateful_or_harassing: {
    messageKey: 'promptRejection.hatefulOrHarassing',
    message: 'This answer includes language that could hurt or exclude others. Please rewrite it.',
  },
  promotional: {
    messageKey: 'promptRejection.promotional',
    message: 'Answers cannot advertise products, services or other accounts. Please share something about you instead.',
  },
  community_guidelines: {
    messageKey: 'promptRejection.communityGuidelines',
    message: 'This answer does not fit our community guidelines. Please try a different answer.',
  },
} as const;

export type PromptRejectionReasonCode = keyof typeof PROMPT_REJECTION_REASONS;

/** What the owner sees about a rejection. `action` tells the client to offer a replacement. */
export interface PromptRejectionDTO {
  code: PromptRejectionReasonCode;
  messageKey: string;
  message: string;
  action: 'replace';
}

export function isPromptRejectionReason(value: unknown): value is PromptRejectionReasonCode {
  return typeof value === 'string' && Object.hasOwn(PROMPT_REJECTION_REASONS, value);
}

/** Unknown or missing codes fall back to the general guideline reason. */
export function describePromptRejection(code: string | null | undefined): PromptRejectionDTO {
  const key: PromptRejectionReasonCode = isPromptRejectionReason(code) ? code : 'community_guidelines';
  return { code: key, ...PROMPT_REJECTION_REASONS[key], action: 'replace' };
}

export type PromptReviewDecision = 'approve' | 'reject';

export class PromptReviewError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'ANSWER_NOT_FOUND' | 'ANSWER_NOT_PENDING' | 'REVISION_CONFLICT',
    message: string,
    readonly currentRevision?: number,
  ) {
    super(message);
  }
}

/** Review-relevant fields; never includes answer text so audit trails stay text-free. */
export interface PromptReviewState {
  state: PromptAnswerDocument['state'];
  revision: number;
  publishedRevision: number;
  rejectionReason: string | null;
}

export interface PromptDecisionResult {
  answer: PromptAnswerDocument; // as it was before the decision
  before: PromptReviewState;
  after: PromptReviewState;
  decidedAt: Date;
}

export function promptReviewState(answer: PromptAnswerDocument): PromptReviewState {
  return {
    state: answer.state,
    revision: answer.revision,
    publishedRevision: answer.publishedRevision,
    rejectionReason: answer.rejectionReason ?? null,
  };
}

/**
 * Apply an approve/reject decision to a pending answer at `expectedRevision`.
 * Writes only the answer; readiness is recomputed by finishPromptDecision.
 */
export async function applyPromptDecision(
  db: Db,
  answerId: string,
  decision: PromptReviewDecision,
  reason: string | null,
  options: { expectedRevision: number; session?: ClientSession; now?: Date },
): Promise<PromptDecisionResult> {
  if (decision !== 'approve' && decision !== 'reject') {
    throw new PromptReviewError('INVALID_INPUT', 'Decision must be "approve" or "reject"');
  }
  if (decision === 'reject' && !isPromptRejectionReason(reason)) {
    throw new PromptReviewError(
      'INVALID_INPUT',
      `Rejection reason must be one of: ${Object.keys(PROMPT_REJECTION_REASONS).join(', ')}`,
    );
  }
  if (!Number.isInteger(options.expectedRevision)) {
    throw new PromptReviewError('INVALID_INPUT', 'expectedRevision must be an integer');
  }

  const { session } = options;
  const answers = db.collection<PromptAnswerDocument>('promptAnswers');
  const answer = await answers.findOne({ _id: answerId }, { session });
  if (!answer) throw new PromptReviewError('ANSWER_NOT_FOUND', `Prompt answer ${answerId} not found`);
  if (answer.state !== 'pending' || answer.pendingText === null) {
    throw new PromptReviewError('ANSWER_NOT_PENDING', `Prompt answer ${answerId} is ${answer.state}, not pending`, answer.revision);
  }
  if (answer.revision !== options.expectedRevision) {
    throw new PromptReviewError('REVISION_CONFLICT', 'The answer was edited after it was loaded for review', answer.revision);
  }

  const decidedAt = options.now ?? new Date();
  const set: Partial<PromptAnswerDocument> = decision === 'approve'
    ? {
        approvedText: answer.pendingText,
        pendingText: null,
        state: 'approved',
        publishedRevision: answer.publishedRevision + 1,
        rejectionReason: null,
        updatedAt: decidedAt,
      }
    : { state: 'rejected', rejectionReason: reason, updatedAt: decidedAt };

  // Compare-and-set on exactly the submission the reviewer saw
  const result = await answers.updateOne(
    { _id: answerId, state: 'pending', revision: options.expectedRevision, pendingText: answer.pendingText },
    { $set: set },
    { session },
  );
  if (result.matchedCount === 0) {
    const current = await answers.findOne({ _id: answerId }, { session });
    throw new PromptReviewError('REVISION_CONFLICT', 'The answer changed during review', current?.revision);
  }

  const updated: PromptAnswerDocument = { ...answer, ...set };
  return { answer, before: promptReviewState(answer), after: promptReviewState(updated), decidedAt };
}

/** After the decision commits: approving a first answer can make the profile ready. */
export async function finishPromptDecision(db: Db, ownerId: string): Promise<void> {
  await recomputeReadiness(db, ownerId);
}
