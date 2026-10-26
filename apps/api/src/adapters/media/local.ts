import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { v4 as uuidv4 } from 'uuid';
import { assertValidKey, type MediaStorage } from './storage.js';

/**
 * Development storage on the local filesystem (MEDIA_LOCAL_DIR, gitignored).
 * Writes go to a temp file first and are renamed into place so a crash never
 * leaves a half-written object at a real key.
 */
export class LocalMediaStorage implements MediaStorage {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = path.resolve(rootDir);
  }

  /** Absolute path of an object, for the dev review script. */
  pathFor(key: string): string {
    assertValidKey(key);
    return path.join(this.root, ...key.split('/'));
  }

  // Content type is implied by the key's variant; the filesystem has nowhere to keep it
  async putObject(key: string, body: Buffer, _options?: { contentType: string }): Promise<void> {
    const target = this.pathFor(key);
    await mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${uuidv4()}.tmp`;
    try {
      await writeFile(temp, body, { flag: 'wx' });
      await rename(temp, target);
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
  }

  async getObjectStream(key: string): Promise<Readable | null> {
    const target = this.pathFor(key);
    try {
      await stat(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    return createReadStream(target);
  }

  async deleteObject(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}
