import { Readable } from 'node:stream';
import { assertValidKey, type MediaStorage } from './storage.js';

interface StoredObject {
  body: Buffer;
  contentType: string;
}

/** Test storage. Inspect `keys()` / `get()` to assert what was written or removed. */
export class InMemoryMediaStorage implements MediaStorage {
  private readonly objects = new Map<string, StoredObject>();

  async putObject(key: string, body: Buffer, options: { contentType: string }): Promise<void> {
    assertValidKey(key);
    this.objects.set(key, { body: Buffer.from(body), contentType: options.contentType });
  }

  async getObjectStream(key: string): Promise<Readable | null> {
    assertValidKey(key);
    const object = this.objects.get(key);
    return object ? Readable.from([object.body]) : null;
  }

  async deleteObject(key: string): Promise<void> {
    assertValidKey(key);
    this.objects.delete(key);
  }

  keys(): string[] {
    return [...this.objects.keys()].sort();
  }

  get(key: string): StoredObject | undefined {
    return this.objects.get(key);
  }
}
