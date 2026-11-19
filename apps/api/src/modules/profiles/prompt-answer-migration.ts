import type { ClientSession, Db, Filter, MongoClient } from 'mongodb';
import { isDuplicateKeyError } from '../../indexes.js';
import { MAX_PROMPT_ANSWERS, type PromptAnswerDocument } from './schema.js';

/**
 * Upgrade stored prompt answers to the current shape: one published
 * `approvedText` and a slot.
 *
 * Two older shapes can be on disk:
 * - Before review-gated prompts: one `text` (published when its state was
 *   'approved') and no slot.
 * - Review-gated, until D-13: `approvedText` (published) plus `pendingText`
 *   (the latest submission) with a review `state` and maybe a `rejectionReason`.
 *
 * Answers now publish on save (D-13), so the review state is resolved:
 * - A submission awaiting review is published, as saving it would be today:
 *   it becomes the text and publishedRevision goes up by one.
 * - A rejected submission is dropped and the previously published text stays.
 *   An answer left with no published text at all is deleted. Rejected text is
 *   never published.
 *
 * Answers without a slot get a free one. An owner left with more than
 * MAX_PROMPT_ANSWERS (possible under the old check-then-insert race) keeps the
 * answers that already hold a slot, then the ones already published before
 * this upgrade, then the oldest; the rest move to promptAnswersArchive
 * instead of being deleted.
 *
 * Runs at startup after ensureIndexes and before serving. Idempotent, and safe
 * from several instances at once: each owner is upgraded in a transaction.
 */

export const PROMPT_ANSWER_ARCHIVE = 'promptAnswersArchive';

/** An over-limit answer moved out of promptAnswers; never shown to anyone */
export interface ArchivedPromptAnswerDocument extends Omit<PromptAnswerDocument, 'slot'> {
  archivedAt: Date;
  archiveReason: 'over-limit';
}

export interface PromptAnswerMigrationResult {
  slotted: number;
  archived: number;
  /** Submissions awaiting review that were published */
  published: number;
  /** Rejected submissions dropped; the answer kept its earlier published text */
  rejectedDropped: number;
  /** Answers deleted because they had no published text (a rejected first submission) */
  deleted: number;
}

type UnslottedAnswer = Omit<PromptAnswerDocument, 'slot'>;

/** Stored answer of any vintage */
interface StoredAnswer {
  _id: string;
  ownerId: string;
  promptId: string;
  slot?: number;
  text?: string;
  approvedText?: string | null;
  pendingText?: string | null;
  state?: 'approved' | 'pending' | 'rejected';
  rejectionReason?: string | null;
  revision?: number;
  publishedRevision?: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Anything not in the current shape */
const NEEDS_UPGRADE: Filter<StoredAnswer> = {
  $or: [
    { slot: { $exists: false } },
    { approvedText: { $not: { $type: 'string' } } },
    { text: { $exists: true } },
    { pendingText: { $exists: true } },
    { state: { $exists: true } },
    { rejectionReason: { $exists: true } },
  ],
};

/** The prompt review queue index, gone with prompt review (D-13) */
const REVIEW_QUEUE_INDEX = 'state_1_updatedAt_1__id_1';

const emptyResult = (): PromptAnswerMigrationResult => ({ slotted: 0, archived: 0, published: 0, rejectedDropped: 0, deleted: 0 });

export async function migratePromptAnswers(client: MongoClient, db: Db): Promise<PromptAnswerMigrationResult> {
  await dropReviewQueueIndex(db);
  const owners = await db.collection<StoredAnswer>('promptAnswers').distinct('ownerId', NEEDS_UPGRADE);
  const total = emptyResult();
  for (const ownerId of owners as string[]) {
    const result = await migrateOwner(client, db, ownerId);
    for (const key of Object.keys(total) as (keyof PromptAnswerMigrationResult)[]) total[key] += result[key];
  }
  return total;
}

async function dropReviewQueueIndex(db: Db): Promise<void> {
  try {
    await db.collection('promptAnswers').dropIndex(REVIEW_QUEUE_INDEX);
  } catch (err: unknown) {
    // 26: no collection yet; 27: index already gone (or another instance dropped it)
    const code = (err as { code?: number }).code;
    if (code !== 26 && code !== 27) throw err;
  }
}

async function migrateOwner(client: MongoClient, db: Db, ownerId: string): Promise<PromptAnswerMigrationResult> {
  // A slot taken by a concurrent insert fails the transaction with a duplicate key;
  // each such loss means one fewer free slot, so MAX + 1 attempts always settle
  for (let attempt = 0; ; attempt++) {
    const session = client.startSession();
    try {
      return await session.withTransaction(() => upgradeOwner(db, ownerId, session));
    } catch (err: unknown) {
      if (!isDuplicateKeyError(err) || attempt >= MAX_PROMPT_ANSWERS) throw err;
    } finally {
      await session.endSession();
    }
  }
}

interface Resolved {
  answer: UnslottedAnswer;
  slot: number | undefined;
  /** Had published text before this upgrade: what others already saw */
  wasPublished: boolean;
}

async function upgradeOwner(db: Db, ownerId: string, session: ClientSession): Promise<PromptAnswerMigrationResult> {
  const answers = db.collection<StoredAnswer>('promptAnswers');
  const archive = db.collection<ArchivedPromptAnswerDocument>(PROMPT_ANSWER_ARCHIVE);
  const owned = await answers.find({ ownerId }, { session }).toArray();
  const result = emptyResult();

  // Current answers keep their slots; the rest are resolved to their published text
  const used = new Set<number | undefined>();
  const upgrades: Resolved[] = [];
  for (const stored of owned) {
    if (isCurrent(stored)) {
      used.add(stored.slot);
      continue;
    }
    const outcome = resolve(stored);
    if (outcome.kind === 'delete') {
      await answers.deleteOne({ _id: stored._id }, { session });
      result.deleted++;
      continue;
    }
    if (outcome.kind === 'published') result.published++;
    if (outcome.kind === 'rejected-dropped') result.rejectedDropped++;
    if (stored.slot !== undefined) used.add(stored.slot);
    upgrades.push({ answer: outcome.answer, slot: stored.slot, wasPublished: outcome.wasPublished });
  }

  for (const { answer, slot } of upgrades.filter(u => u.slot !== undefined)) {
    await answers.replaceOne({ _id: answer._id }, { ...answer, slot }, { session });
  }

  const free = Array.from({ length: MAX_PROMPT_ANSWERS }, (_, i) => i).filter(i => !used.has(i));
  for (const { answer } of upgrades.filter(u => u.slot === undefined).sort(byKeepPriority)) {
    const slot = free.shift();
    if (slot === undefined) {
      await archive.insertOne({ ...answer, archivedAt: new Date(), archiveReason: 'over-limit' }, { session });
      await answers.deleteOne({ _id: answer._id }, { session });
      result.archived++;
    } else {
      await answers.replaceOne({ _id: answer._id }, { ...answer, slot }, { session });
      result.slotted++;
    }
  }
  return result;
}

function isCurrent(stored: StoredAnswer): boolean {
  return stored.slot !== undefined
    && typeof stored.approvedText === 'string'
    && !['text', 'pendingText', 'state', 'rejectionReason'].some(field => Object.hasOwn(stored, field));
}

type Outcome =
  | { kind: 'kept' | 'published' | 'rejected-dropped'; answer: UnslottedAnswer; wasPublished: boolean }
  | { kind: 'delete' };

/** The answer as it would be had it been saved after D-13, without its slot */
function resolve(stored: StoredAnswer): Outcome {
  const { text, approvedText, pendingText, state, rejectionReason: _reason, slot: _slot, revision, publishedRevision, ...base } = stored;

  // Legacy answers stored one text, published only once approved
  const legacy = text !== undefined;
  const published = legacy ? (state === 'approved' ? text : null) : (typeof approvedText === 'string' ? approvedText : null);
  const submission = legacy ? (state === 'approved' ? null : text) : (pendingText ?? null);
  const publishedVersion = published === null ? 0 : Math.max(publishedRevision ?? 1, 1);
  const current = { ...base, revision: legacy ? 1 : (revision ?? 1) };

  // Only a submission still awaiting review is published; anything else
  // (rejected, or a state we can't vouch for) never is
  if (state === 'pending' && submission !== null) {
    const changed = submission !== published;
    return {
      kind: 'published',
      answer: { ...current, approvedText: submission, publishedRevision: changed ? publishedVersion + 1 : publishedVersion },
      wasPublished: published !== null,
    };
  }
  if (published === null) return { kind: 'delete' };
  return {
    kind: state === 'rejected' ? 'rejected-dropped' : 'kept',
    answer: { ...current, approvedText: published, publishedRevision: publishedVersion },
    wasPublished: true,
  };
}

/** Published answers first (what others already see), then oldest */
function byKeepPriority(a: Resolved, b: Resolved): number {
  return Number(b.wasPublished) - Number(a.wasPublished)
    || a.answer.createdAt.getTime() - b.answer.createdAt.getTime()
    || a.answer._id.localeCompare(b.answer._id);
}
