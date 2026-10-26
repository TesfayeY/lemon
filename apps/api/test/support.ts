import { vi } from 'vitest';
import type { Auth, DecodedIdToken } from 'firebase-admin/auth';
import type { Db } from 'mongodb';
import { createApp } from '../src/app.js';
import { createProfileRoutes } from '../src/modules/profiles/routes.js';
import { createCatalogRoutes } from '../src/modules/catalogs/routes.js';
import { createPreferencesRoutes } from '../src/modules/preferences/routes.js';
import { createAuthRoutes } from '../src/modules/auth/routes.js';

/**
 * Shared test harness: an in-memory stand-in for the MongoDB collections the
 * profile, preference and auth routes use. Good for request/response and
 * authorization tests; not proof of index or transaction behavior.
 */
export function createMockAuth(): Auth {
  return {
    verifyIdToken: vi.fn().mockResolvedValue({
      uid: 'firebase-uid-1',
      email: 'test@example.com',
      email_verified: true,
    } as Partial<DecodedIdToken>),
  } as unknown as Auth;
}

// Mirrors src/indexes.ts so duplicate-key paths behave like MongoDB
const UNIQUE_KEYS: Record<string, string[][]> = {
  users: [['firebaseUid']],
  profiles: [['userId']],
  preferences: [['userId']],
  promptAnswers: [['ownerId', 'promptId'], ['ownerId', 'slot']],
};

/** Equality plus the few operators the routes use ($ne) */
function matchesFilter(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([k, v]) => {
    if (v !== null && typeof v === 'object' && '$ne' in v) return (doc[k] ?? null) !== (v as { $ne: unknown }).$ne;
    return doc[k] === v;
  });
}

export function createInMemoryDb() {
  const collections = new Map<string, Map<string, Record<string, unknown>>>();

  function getCol(name: string) {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name)!;
  }

  return {
    collection: (name: string) => {
      const store = getCol(name);
      return {
        findOne: vi.fn(async (filter: Record<string, unknown>) => {
          for (const doc of store.values()) {
            const match = matchesFilter(doc, filter);
            if (match) return doc;
          }
          return null;
        }),
        find: vi.fn((filter: Record<string, unknown>) => ({
          toArray: vi.fn(async () => {
            const results: Record<string, unknown>[] = [];
            for (const doc of store.values()) {
              const match = matchesFilter(doc, filter);
              if (match) results.push(doc);
            }
            return results;
          }),
        })),
        insertOne: vi.fn(async (doc: Record<string, unknown>) => {
          const uniqueKeys = [['_id'], ...(UNIQUE_KEYS[name] ?? [])];
          for (const existing of store.values()) {
            if (uniqueKeys.some(keys => keys.every(k => existing[k] === doc[k]))) {
              const err = new Error('duplicate key') as Error & { code: number };
              err.code = 11000;
              throw err;
            }
          }
          store.set(doc['_id'] as string, { ...doc });
          return { insertedId: doc['_id'] };
        }),
        updateOne: vi.fn(async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
          for (const [id, doc] of store.entries()) {
            const match = matchesFilter(doc, filter);
            if (match) {
              const { $set = {}, $inc = {} } = update as {
                $set?: Record<string, unknown>;
                $inc?: Record<string, number>;
              };
              Object.assign(doc, $set);
              for (const [k, by] of Object.entries($inc)) doc[k] = ((doc[k] as number) ?? 0) + by;
              store.set(id, doc);
              return { matchedCount: 1, modifiedCount: 1 };
            }
          }
          return { matchedCount: 0, modifiedCount: 0 };
        }),
        deleteOne: vi.fn(async (filter: Record<string, unknown>) => {
          for (const [id, doc] of store.entries()) {
            const match = matchesFilter(doc, filter);
            if (match) {
              store.delete(id);
              return { deletedCount: 1 };
            }
          }
          return { deletedCount: 0 };
        }),
        countDocuments: vi.fn(async (filter: Record<string, unknown>) => {
          let count = 0;
          for (const doc of store.values()) {
            const match = matchesFilter(doc, filter);
            if (match) count++;
          }
          return count;
        }),
      };
    },
  } as unknown as Db;
}

/** Token "token-<name>" authenticates as Firebase UID "uid-<name>" */
export function createMultiUserAuth(): Auth {
  return {
    verifyIdToken: vi.fn(async (token: string) => ({
      uid: `uid-${token.replace('token-', '')}`,
      email: `${token}@example.com`,
      email_verified: true,
    })),
  } as unknown as Auth;
}

export function buildApp(auth?: Auth, db?: Db) {
  const a = auth ?? createMockAuth();
  const d = db ?? createInMemoryDb();
  return createApp({
    mongoCheck: async () => true,
    firebaseCheck: async () => true,
    routes: [
      createAuthRoutes(d, a),
      createProfileRoutes(d, a),
      createCatalogRoutes(),
      createPreferencesRoutes(d, a),
    ],
  });
}


/**
 * Hold the first `arrivals` inserts into a collection until all of them have
 * arrived, then release them together. Every racing request has finished its
 * reads before any write lands, which makes check-then-insert races repeatable.
 * Later inserts (e.g. retries) pass straight through.
 */
export function withInsertBarrier(db: Db, collectionName: string, arrivals: number): Db {
  const waiting: (() => void)[] = [];
  let released = false;
  return {
    collection: (name: string) => {
      const col = db.collection(name);
      if (name !== collectionName) return col;
      return {
        ...col,
        insertOne: async (doc: Record<string, unknown>) => {
          if (!released) {
            await new Promise<void>(resolve => {
              waiting.push(resolve);
              if (waiting.length === arrivals) {
                released = true;
                waiting.forEach(release => release());
              }
            });
          }
          return col.insertOne(doc as never);
        },
      };
    },
  } as unknown as Db;
}
