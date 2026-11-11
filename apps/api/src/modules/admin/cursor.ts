/**
 * Keyset cursor for review queues: the (submittedAt, id) of the last item
 * returned. Queues sort by that pair ascending, so pages are stable while
 * items are decided (decided items leave the queue without shifting others).
 * The cursor only encodes a position in a staff-only list, so it is opaque
 * but not signed.
 */

export interface QueueCursor {
  at: Date;
  id: string;
}

export function encodeQueueCursor(cursor: QueueCursor): string {
  return Buffer.from(JSON.stringify([cursor.at.getTime(), cursor.id])).toString('base64url');
}

/** Null for anything malformed. */
export function decodeQueueCursor(raw: string): QueueCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [ms, id] = parsed as unknown[];
    if (typeof ms !== 'number' || !Number.isSafeInteger(ms) || typeof id !== 'string' || id.length === 0 || id.length > 128) {
      return null;
    }
    return { at: new Date(ms), id };
  } catch {
    return null;
  }
}
