import type { Readable } from 'node:stream';
import type { MediaStorage } from './storage.js';

/**
 * Placeholder for the proposed Firebase Storage adapter.
 *
 * TODO(P-04): implement once the media storage decision is approved in
 * docs/product-decisions.md. Requirements when it lands:
 * - private bucket only; deny all client reads/writes in storage rules
 * - never mint permanent download tokens or public URLs
 * - same key layout as LocalMediaStorage (quarantine/…, public-variants/…)
 */
export class FirebaseMediaStorage implements MediaStorage {
  async putObject(): Promise<void> {
    throw notApproved();
  }

  async getObjectStream(): Promise<Readable | null> {
    throw notApproved();
  }

  async deleteObject(): Promise<void> {
    throw notApproved();
  }
}

function notApproved(): Error {
  return new Error('Firebase Storage adapter is not enabled: product decision P-04 is pending');
}
