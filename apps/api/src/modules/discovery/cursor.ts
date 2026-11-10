/**
 * Opaque signed discovery cursor: `v1.<base64url payload>.<base64url HMAC-SHA256>`.
 *
 * The payload names the session and the next unscanned offset. The signature
 * stops clients from forging offsets or session IDs; ownership and expiry are
 * still checked against the stored session on every request, because a valid
 * signature only proves the server issued the cursor, not to whom.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const VERSION = 'v1';
export const MIN_CURSOR_SECRET_LENGTH = 32;
/** Generous bound on any cursor we issue; longer input is rejected before decoding. */
const MAX_CURSOR_LENGTH = 512;

export interface CursorPayload {
  sessionId: string;
  nextOffset: number;
  /** Session expiry (epoch ms), so expired cursors fail without a database read. */
  expiresAt: number;
}

export type CursorResult = { ok: true; payload: CursorPayload } | { ok: false };

function sign(secret: string, body: string): Buffer {
  return createHmac('sha256', secret).update(`${VERSION}.${body}`).digest();
}

export function encodeCursor(payload: CursorPayload, secret: string): string {
  const body = Buffer.from(
    JSON.stringify({ s: payload.sessionId, o: payload.nextOffset, e: payload.expiresAt }),
  ).toString('base64url');
  return `${VERSION}.${body}.${sign(secret, body).toString('base64url')}`;
}

/** Verifies format and signature only. Malformed and tampered cursors look the same. */
export function decodeCursor(cursor: string, secret: string): CursorResult {
  if (cursor.length > MAX_CURSOR_LENGTH) return { ok: false };
  const parts = cursor.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return { ok: false };
  const [, body, signature] = parts as [string, string, string];

  const expected = sign(secret, body);
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false };

  try {
    const raw = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
    const { s, o, e } = raw;
    if (typeof s !== 'string' || s.length === 0) return { ok: false };
    if (typeof o !== 'number' || !Number.isInteger(o) || o < 0) return { ok: false };
    if (typeof e !== 'number' || !Number.isFinite(e)) return { ok: false };
    return { ok: true, payload: { sessionId: s, nextOffset: o, expiresAt: e } };
  } catch {
    return { ok: false };
  }
}

/**
 * The HMAC secret comes from DISCOVERY_CURSOR_SECRET. Production refuses to
 * start without one; development and tests fall back to a random per-process
 * secret, so cursors simply stop working after a restart.
 */
export function resolveCursorSecret(configured: string | undefined, nodeEnv: string): string {
  if (configured) {
    if (configured.length < MIN_CURSOR_SECRET_LENGTH) {
      throw new Error(`DISCOVERY_CURSOR_SECRET must be at least ${MIN_CURSOR_SECRET_LENGTH} characters`);
    }
    return configured;
  }
  if (nodeEnv === 'production') {
    throw new Error('DISCOVERY_CURSOR_SECRET is required in production');
  }
  if (nodeEnv !== 'test') {
    console.warn('WARNING: DISCOVERY_CURSOR_SECRET is not set; using a random secret for this process.');
  }
  return randomBytes(32).toString('base64url');
}
