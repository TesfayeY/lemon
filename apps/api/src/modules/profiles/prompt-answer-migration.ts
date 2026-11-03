import type { ClientSession, Db, MongoClient } from 'mongodb';
import { isDuplicateKeyError } from '../../indexes.js';
import { MAX_PROMPT_ANSWERS, type PromptAnswerDocument } from './schema.js';

/**
 * Upgrade prompt answers saved before review-gated prompts and answer slots.
 *
 * Those answers stored one auto-approved `text` and no slot. Each is converted
 * to the approvedText/pendingText shape and given a free slot. An owner left
 * with more than MAX_PROMPT_ANSWERS (possible under the old check-then-insert
 * race) keeps the answers that already hold a slot, then published, then oldest;
 * the rest move to promptAnswersArchive instead of being deleted.
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
}

type UnslottedAnswer = Omit<PromptAnswerDocument, 'slot'>;

/** Stored answer of any vintage: legacy ones have `text` and lack the newer fields */
type StoredAnswer = Omit<UnslottedAnswer, 'approvedText' | 'pendingText' | 'revision'>
  & Partial<Pick<PromptAnswerDocument, 'slot' | 'approvedText' | 'pendingText' | 'revision'>>
  & { text?: string };

export async function migratePromptAnswers(client: MongoClient, db: Db): Promise<PromptAnswerMigrationResult> {
  const owners = await db.collection<StoredAnswer>('promptAnswers').distinct('ownerId', { slot: { $exists: false } });
  const total: PromptAnswerMigrationResult = { slotted: 0, archived: 0 };
  for (const ownerId of owners as string[]) {
    const result = await migrateOwner(client, db, ownerId);
    total.slotted += result.slotted;
    total.archived += result.archived;
  }
  return total;
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

async function upgradeOwner(db: Db, ownerId: string, session: ClientSession): Promise<PromptAnswerMigrationResult> {
  const answers = db.collection<StoredAnswer>('promptAnswers');
  const archive = db.collection<ArchivedPromptAnswerDocument>(PROMPT_ANSWER_ARCHIVE);
  const owned = await answers.find({ ownerId }, { session }).toArray();

  const used = new Set(owned.map(a => a.slot));
  const free = Array.from({ length: MAX_PROMPT_ANSWERS }, (_, i) => i).filter(i => !used.has(i));
  const unslotted = owned.filter(a => a.slot === undefined).map(toCurrentShape).sort(byKeepPriority);

  const result: PromptAnswerMigrationResult = { slotted: 0, archived: 0 };
  for (const answer of unslotted) {
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

function toCurrentShape(stored: StoredAnswer): UnslottedAnswer {
  const { text, ...rest } = stored;
  if (text === undefined) return rest as UnslottedAnswer;
  // Legacy answers were auto-approved, so approved text is already published
  const published = rest.state === 'approved';
  return {
    ...rest,
    approvedText: published ? text : null,
    pendingText: published ? null : text,
    revision: 1,
    publishedRevision: published ? rest.publishedRevision : 0,
  };
}

/** Published answers first (what others already see), then oldest */
function byKeepPriority(a: UnslottedAnswer, b: UnslottedAnswer): number {
  return Number(b.approvedText !== null) - Number(a.approvedText !== null)
    || a.createdAt.getTime() - b.createdAt.getTime()
    || a._id.localeCompare(b._id);
}
