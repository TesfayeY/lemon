import type { Readable } from 'node:stream';

/**
 * Private object storage for profile media.
 *
 * Keys are always server-generated (never derived from client input), e.g.
 * `quarantine/<ownerId>/<assetId>` or `public-variants/<assetId>/<variant>`.
 * Nothing behind this interface is ever reachable by a URL: every read goes
 * through the authenticated media endpoint, which rechecks access per request.
 */
export interface MediaStorage {
  putObject(key: string, body: Buffer, options: { contentType: string }): Promise<void>;
  /** Resolves to null when the object does not exist. */
  getObjectStream(key: string): Promise<Readable | null>;
  /** Idempotent: deleting a missing object succeeds. */
  deleteObject(key: string): Promise<void>;
}

const KEY_PATTERN = /^[a-z][a-z-]*(\/[A-Za-z0-9_-]+)+$/;

/** Defense in depth against path traversal if a key is ever built incorrectly. */
export function assertValidKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new Error(`Invalid media object key: ${key}`);
  }
}
