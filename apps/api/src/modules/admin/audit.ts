/**
 * Append-only staff audit log (R-ADMIN-04).
 *
 * Every admin decision appends exactly one entry in the same Mongo transaction
 * as the decision, so a decision never commits without its entry and a failed
 * decision leaves none. This module exposes append and read only: there is no
 * code path that updates or deletes entries.
 *
 * Entries carry review state, catalog reasons and an optional staff note.
 * They never carry tokens, emails, birth dates, answer text or message text
 * (R-ADMIN-05); prompt decisions record a SHA-256 of the decided text instead.
 */

import type { ClientSession, Db } from 'mongodb';
import { v7 as uuidv7 } from 'uuid';
import type { StaffActor } from './middleware.js';
import type { StaffRole } from './roles.js';

export const ADMIN_AUDIT_COLLECTION = 'adminAuditLog';

export type AdminAction =
  | 'photo.approve'
  | 'photo.reject'
  | 'prompt_answer.approve'
  | 'prompt_answer.reject'
  | 'account.suspend'
  | 'account.restore';

export type AuditTargetType = 'photo' | 'promptAnswer' | 'user';

export interface AdminAuditEntry {
  _id: string;
  actorUid: string;
  actorRole: StaffRole;
  action: AdminAction;
  targetType: AuditTargetType;
  targetId: string;
  /** App user the target belongs to (the user itself for account actions). */
  targetOwnerId: string;
  reason: string | null; // catalog key
  note: string | null; // optional staff note, internal only
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  requestId: string;
  createdAt: Date;
}

export interface AuditInput {
  actor: StaffActor;
  action: AdminAction;
  targetType: AuditTargetType;
  targetId: string;
  targetOwnerId: string;
  reason: string | null;
  note: string | null;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  requestId: string;
  createdAt: Date;
}

const MAX_REQUEST_ID_LENGTH = 128;

/** Append one entry. Pass the decision's session so both commit or neither does. */
export async function appendAuditEntry(db: Db, input: AuditInput, session?: ClientSession): Promise<AdminAuditEntry> {
  const entry: AdminAuditEntry = {
    // Time-ordered, so entries with the same createdAt still list in insertion order
    _id: uuidv7(),
    actorUid: input.actor.uid,
    actorRole: input.actor.role,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    targetOwnerId: input.targetOwnerId,
    reason: input.reason,
    note: input.note,
    before: input.before,
    after: input.after,
    // The request ID may come from a client header; keep it bounded
    requestId: String(input.requestId).slice(0, MAX_REQUEST_ID_LENGTH),
    createdAt: input.createdAt,
  };
  await db.collection<AdminAuditEntry>(ADMIN_AUDIT_COLLECTION).insertOne(entry, { session });
  return entry;
}

/** One target's history, oldest first. Always scoped to a target: there is no bulk export. */
export async function listAuditEntries(
  db: Db,
  targetType: AuditTargetType,
  targetId: string,
  limit: number,
): Promise<AdminAuditEntry[]> {
  return db.collection<AdminAuditEntry>(ADMIN_AUDIT_COLLECTION)
    .find({ targetType, targetId })
    .sort({ createdAt: 1, _id: 1 })
    .limit(limit)
    .toArray();
}

/** Audit and review-queue indexes (appended to ensureIndexes). */
export async function ensureAdminIndexes(db: Db): Promise<void> {
  await Promise.all([
    db.collection(ADMIN_AUDIT_COLLECTION).createIndex({ targetType: 1, targetId: 1, createdAt: 1 }),
    db.collection(ADMIN_AUDIT_COLLECTION).createIndex({ actorUid: 1, createdAt: -1 }),
    db.collection(ADMIN_AUDIT_COLLECTION).createIndex({ createdAt: -1 }),
    // Review queues: pending items oldest first with an _id tie-breaker
    db.collection('photos').createIndex({ state: 1, createdAt: 1, _id: 1 }),
    db.collection('promptAnswers').createIndex({ state: 1, updatedAt: 1, _id: 1 }),
  ]);
}
