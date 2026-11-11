import { z } from 'zod';
import { graphemeLength, normalizeWhitespace } from '../profiles/schema.js';
import type { FieldError } from '../profiles/validation.js';
import { COMMENT_MAX_GRAPHEMES, type LikeTarget } from './schema.js';

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * Cheap bound on raw comment size before grapheme segmentation. Generous enough
 * for 200 multi-code-point emoji, small enough that combining-mark floods are
 * rejected without segmenting megabytes.
 */
const COMMENT_MAX_CODE_UNITS = 4000;

// Unknown fields (fromUserId, uid, state, ...) are stripped: identity comes from the token only
const sendLikeSchema = z.object({
  toUserId: z.string().min(1).max(128),
  target: z.object({
    kind: z.enum(['photo', 'prompt']),
    id: z.string().min(1).max(128),
    contentVersion: z.number().int().min(1),
  }),
  comment: z.string().max(COMMENT_MAX_CODE_UNITS).nullable().optional(),
});

export interface SendLikeInput {
  toUserId: string;
  target: LikeTarget;
  /** Normalized; null when absent or blank */
  comment: string | null;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; fieldErrors: FieldError[] };

/** NFC + collapsed whitespace; blank becomes null */
export function normalizeComment(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const normalized = normalizeWhitespace(raw.normalize('NFC'));
  return normalized.length === 0 ? null : normalized;
}

export function parseSendLike(body: unknown): ParseResult<SendLikeInput> {
  const parsed = sendLikeSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: parsed.error.issues.map(issue => ({
        field: issue.path.join('.') || 'body',
        message: issue.message,
      })),
    };
  }

  const comment = normalizeComment(parsed.data.comment);
  if (comment !== null && graphemeLength(comment) > COMMENT_MAX_GRAPHEMES) {
    return {
      ok: false,
      fieldErrors: [{ field: 'comment', message: `Comments can be at most ${COMMENT_MAX_GRAPHEMES} characters` }],
    };
  }

  const { toUserId, target } = parsed.data;
  return { ok: true, value: { toUserId, target: { kind: target.kind, id: target.id, contentVersion: target.contentVersion }, comment } };
}

// --- Incoming list paging ---------------------------------------------------

export const INCOMING_DEFAULT_LIMIT = 20;
export const INCOMING_MAX_LIMIT = 50;

export interface IncomingCursor {
  createdAt: Date;
  id: string;
}

/**
 * Opaque keyset position. Not signed: it is only ever applied inside the
 * caller's own incoming list, so a forged value can reveal nothing.
 */
export function encodeCursor(cursor: IncomingCursor): string {
  return Buffer.from(JSON.stringify({ t: cursor.createdAt.toISOString(), id: cursor.id })).toString('base64url');
}

export function decodeCursor(raw: string): IncomingCursor | null {
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (value === null || typeof value !== 'object') return null;
    const { t, id } = value as Record<string, unknown>;
    if (typeof t !== 'string' || typeof id !== 'string' || id.length === 0 || id.length > 128) return null;
    const createdAt = new Date(t);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

export function parseLimit(raw: unknown): number | null {
  if (raw === undefined) return INCOMING_DEFAULT_LIMIT;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const limit = Number(raw);
  return limit >= 1 && limit <= INCOMING_MAX_LIMIT ? limit : null;
}
