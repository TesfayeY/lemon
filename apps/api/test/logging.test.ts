import { describe, it, expect, vi, afterEach } from 'vitest';
import { MongoServerError, type Db } from 'mongodb';
import { describeError } from '../src/logging.js';
import type { MediaStorage } from '../src/adapters/media/storage.js';
import { purgePhotoObjects } from '../src/modules/media/photo-set.js';
import type { PhotoDocument } from '../src/modules/media/schema.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('describeError', () => {
  it('keeps a MongoDB duplicate-key error to its name and codes, without the key value', () => {
    const err = new MongoServerError({
      errmsg: 'E11000 duplicate key error collection: lemon.users index: firebaseUid_1 dup key: { firebaseUid: "uid-PRIVATE" }',
      code: 11000,
      codeName: 'DuplicateKey',
      keyValue: { firebaseUid: 'uid-PRIVATE' },
    });
    expect(describeError(err)).toBe('MongoServerError code=11000 codeName=DuplicateKey');
  });

  it('drops filesystem paths from storage errors', () => {
    const err = Object.assign(new Error("ENOENT: no such file or directory, open '.local-media/quarantine/user-1/asset-1'"), {
      code: 'ENOENT',
    });
    expect(describeError(err)).toBe('Error code=ENOENT');
  });

  it('names plain errors by class', () => {
    expect(describeError(new TypeError("Cannot read properties of undefined (reading 'birthDate')"))).toBe('TypeError');
  });

  it('ignores codes that are not plain identifiers', () => {
    const err = Object.assign(new Error('x'), { code: 'user@example.com has no account' });
    expect(describeError(err)).toBe('Error');
  });

  it('describes thrown non-errors by type only', () => {
    expect(describeError('uid-PRIVATE')).toBe('non-error thrown (string)');
    expect(describeError(undefined)).toBe('non-error thrown (undefined)');
  });
});

describe('Media cleanup logging', () => {
  it('logs a storage failure without the object path', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const storage: MediaStorage = {
      putObject: vi.fn(),
      getObjectStream: vi.fn(),
      deleteObject: vi.fn(async (key: string) => {
        throw Object.assign(new Error(`EACCES: permission denied, unlink '/srv/media/${key}'`), { code: 'EACCES' });
      }),
    };
    const db = { collection: vi.fn() } as unknown as Db;
    const photo = {
      _id: 'asset-1',
      originalPrivateKey: 'quarantine/owner-PRIVATE/asset-1',
      variantKeys: { thumb: 'public-variants/asset-1/thumb', display: 'public-variants/asset-1/display' },
    } as PhotoDocument;

    expect(await purgePhotoObjects(db, storage, photo)).toBe(false);

    const line = log.mock.calls[0]!.join(' ');
    expect(line).toContain('asset-1');
    expect(line).toContain('Error code=EACCES');
    expect(line).not.toContain('owner-PRIVATE');
  });
});
