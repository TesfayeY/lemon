import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { ensureIndexes } from '../src/indexes.js';
import { ADMIN_AUDIT_COLLECTION, ensureAdminIndexes } from '../src/modules/admin/audit.js';
import { createAdminService, type SuspensionRecord } from '../src/modules/admin/service.js';
import type { AccountStatusType, UserDocument } from '../src/modules/auth/account.js';
import { createDefaultPreferences } from '../src/modules/preferences/schema.js';
import { MAX_READINESS_ATTEMPTS, recomputeReadiness } from '../src/modules/profiles/readiness-service.js';
import { createEmptyProfile } from '../src/modules/profiles/schema.js';

// --- Real local replica set, isolated database per run ---

const uri = process.env['MONGO_URI']!;
const dbName = `lemon_test_readiness_${process.pid}_${Date.now()}`;

let client: MongoClient;
let db: Db;

beforeAll(async () => {
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(`Readiness race tests need MongoDB at ${uri} (run the local replica set)`, { cause: err });
  }
  db = client.db(dbName);
  await ensureIndexes(db);
  await ensureAdminIndexes(db);
});

afterAll(async () => {
  await db?.dropDatabase();
  await client?.close();
});

beforeEach(async () => {
  for (const name of ['users', 'profiles', 'preferences', 'promptAnswers', 'photos', ADMIN_AUDIT_COLLECTION]) {
    await db.collection(name).deleteMany({});
  }
});

const USER_ID = 'user-alice';
const users = () => db.collection<UserDocument & { suspension?: SuspensionRecord }>('users');
const getUser = async () => (await users().findOne({ _id: USER_ID }))!;

/**
 * A fictional member who meets every readiness requirement but whose
 * readiness has not been persisted yet: the next recompute activates her.
 */
async function seedReadyToActivate(status: AccountStatusType = 'onboarding') {
  const now = new Date();
  await users().insertOne({
    _id: USER_ID,
    firebaseUid: 'uid-alice',
    accountStatus: status,
    emailVerified: true,
    birthDate: '1994-05-12',
    adultEligible: true,
    discoverPaused: false,
    profileReady: false,
    guardVersion: 1,
    agreements: { termsVersion: '1.0', acceptedAt: now },
    createdAt: now,
    updatedAt: now,
  });
  await db.collection('profiles').insertOne({
    ...createEmptyProfile(USER_ID),
    displayName: 'Alice',
    genderIdentity: 'woman',
    cityId: 'city-seattle-wa',
    stateCode: 'WA',
    intention: 'serious',
  });
  await db.collection('preferences').insertOne({ ...createDefaultPreferences(USER_ID), acceptedGenderCategories: ['man'] });
  for (const slot of [0, 1, 2]) {
    await db.collection('photos').insertOne({ _id: `photo-${slot}`, ownerId: USER_ID, state: 'approved', order: slot });
    await db.collection('promptAnswers').insertOne({
      _id: `answer-${slot}`, ownerId: USER_ID, promptId: `prompt-${slot}`, slot,
      approvedText: `answer ${slot}`, pendingText: null, state: 'approved', revision: 1, publishedRevision: 1,
    });
  }
}

/**
 * The same database, except that every write to `users` first runs `hook`
 * with its 1-based call number. Recompute's reads have all finished by then,
 * so whatever the hook commits lands between recompute's read and its write.
 */
function withUserWriteHook(real: Db, hook: (call: number) => Promise<void>): Db {
  let calls = 0;
  return {
    collection: (name: string) => {
      const col = real.collection(name);
      if (name !== 'users') return col;
      return {
        findOne: col.findOne.bind(col),
        updateOne: async (...args: Parameters<typeof col.updateOne>) => {
          await hook(++calls);
          return col.updateOne(...args);
        },
      };
    },
  } as unknown as Db;
}

describe('recomputeReadiness under concurrent account changes', () => {
  it('never undoes a staff suspension that commits between its read and its write', async () => {
    await seedReadyToActivate();
    const revokeRefreshTokens = vi.fn(async (_uid: string) => undefined);
    const admin = createAdminService(db, client, { revokeRefreshTokens });

    // e.g. a moderator approves the member's last photo while an admin suspends her
    let suspended = false;
    const racing = withUserWriteHook(db, async () => {
      if (suspended) return;
      suspended = true;
      await admin.suspendAccount({ uid: 'staff-admin', role: 'admin' }, USER_ID, { reason: 'harassment', note: null }, 'req-race');
    });

    expect(await recomputeReadiness(racing, USER_ID)).toBe(false);
    const user = await getUser();
    expect(user).toMatchObject({ accountStatus: 'suspended', profileReady: false, guardVersion: 2 });
    expect(user.suspension?.previousStatus).toBe('onboarding');
    expect(revokeRefreshTokens).toHaveBeenCalledWith('uid-alice');

    // Restore still works normally afterwards: back to onboarding, then activated as ready
    const restored = await admin.restoreAccount({ uid: 'staff-admin', role: 'admin' }, USER_ID, { reason: 'appeal_upheld', note: null }, 'req-restore');
    expect(restored.account).toMatchObject({ accountStatus: 'active', profileReady: true });
  });

  it.each(['suspended', 'deletion_pending', 'deleted'] as const)(
    'never activates an account that became %s between its read and its write, even without a guard bump',
    async (status) => {
      await seedReadyToActivate();
      let changed = false;
      const racing = withUserWriteHook(db, async () => {
        if (changed) return;
        changed = true;
        await users().updateOne({ _id: USER_ID }, { $set: { accountStatus: status } });
      });

      await recomputeReadiness(racing, USER_ID, { eligibilityChanged: true });
      expect((await getUser()).accountStatus).toBe(status);
    },
  );

  it.each(['suspended', 'deletion_pending', 'deleted'] as const)('never activates a %s account', async (status) => {
    await seedReadyToActivate(status);
    await recomputeReadiness(db, USER_ID, { eligibilityChanged: true });
    expect((await getUser()).accountStatus).toBe(status);
  });

  it('activates exactly once when two recomputes race', async () => {
    await seedReadyToActivate();
    // Hold both first writes until both recomputes have read the onboarding account
    const waiting: (() => void)[] = [];
    const racing = withUserWriteHook(db, async (call) => {
      if (call > 2) return;
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
        if (waiting.length === 2) waiting.forEach((release) => release());
      });
    });

    expect(await Promise.all([recomputeReadiness(racing, USER_ID), recomputeReadiness(racing, USER_ID)])).toEqual([true, true]);
    // The loser re-read the activated account and had nothing left to write
    expect(await getUser()).toMatchObject({ accountStatus: 'active', profileReady: true, guardVersion: 2 });
  });

  it('gives up after a bounded number of lost rounds and writes nothing', async () => {
    await seedReadyToActivate();
    let calls = 0;
    const racing = withUserWriteHook(db, async () => {
      calls++;
      // Another guarded write lands before every attempt
      await users().updateOne({ _id: USER_ID }, { $inc: { guardVersion: 1 } });
    });

    await expect(recomputeReadiness(racing, USER_ID)).rejects.toThrow('compare-and-set');
    expect(calls).toBe(MAX_READINESS_ATTEMPTS);
    expect(await getUser()).toMatchObject({ accountStatus: 'onboarding', profileReady: false, guardVersion: 1 + MAX_READINESS_ATTEMPTS });
  });
});
