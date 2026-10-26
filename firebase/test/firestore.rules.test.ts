import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where,
  type Firestore,
} from 'firebase/firestore';

// Fictional users only
const ALICE = 'uid-alice';
const BOB = 'uid-bob';
const MALLORY = 'uid-mallory';

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-lemon',
    firestore: { rules: readFileSync(resolve(__dirname, '../firestore.rules'), 'utf8') },
  });
});

afterAll(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
});

/** Seed documents with the Admin-equivalent context (rules bypassed, like Express) */
async function seed(data: Record<string, Record<string, unknown>>) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const [path, value] of Object.entries(data)) {
      await setDoc(doc(db, path), value);
    }
  });
}

function room(overrides: Record<string, unknown> = {}) {
  return {
    participantUids: [ALICE, BOB],
    status: 'active',
    pairVersion: 1,
    closedAt: null,
    lastMessageSummary: null,
    lastMessageSequence: 0,
    ...overrides,
  };
}

const message = {
  senderUid: ALICE,
  clientMessageId: 'c1',
  plainText: 'Selam!',
  sequence: 1,
  acceptedAt: new Date(0),
  deliveredAt: new Date(0),
  schemaVersion: 1,
};

async function seedActiveRoom(roomOverrides: Record<string, unknown> = {}) {
  await seed({
    [`chatAccess/${ALICE}`]: { enabled: true, accountVersion: 1 },
    [`chatAccess/${BOB}`]: { enabled: true, accountVersion: 1 },
    [`chatAccess/${MALLORY}`]: { enabled: true, accountVersion: 1 },
    'rooms/m1': room(roomOverrides),
    'rooms/m1/messages/msg1': message,
    [`rooms/m1/readStates/${ALICE}`]: { lastReadSequence: 0, updatedAt: new Date(0) },
    [`rooms/m1/readStates/${BOB}`]: { lastReadSequence: 1, updatedAt: new Date(0) },
  });
}

const as = (uid: string): Firestore => env.authenticatedContext(uid).firestore();
const anon = (): Firestore => env.unauthenticatedContext().firestore();

describe('rooms', () => {
  it('denies anonymous reads', async () => {
    await seedActiveRoom();
    await assertFails(getDoc(doc(anon(), 'rooms/m1')));
  });

  it('denies a nonmember', async () => {
    await seedActiveRoom();
    await assertFails(getDoc(doc(as(MALLORY), 'rooms/m1')));
  });

  it('allows a member to read an active room', async () => {
    await seedActiveRoom();
    await assertSucceeds(getDoc(doc(as(ALICE), 'rooms/m1')));
    await assertSucceeds(getDoc(doc(as(BOB), 'rooms/m1')));
  });

  it('denies a member whose own access is disabled', async () => {
    await seedActiveRoom();
    await seed({ [`chatAccess/${ALICE}`]: { enabled: false, accountVersion: 2 } });
    await assertFails(getDoc(doc(as(ALICE), 'rooms/m1')));
  });

  it('denies a member when the other participant is disabled', async () => {
    await seedActiveRoom();
    await seed({ [`chatAccess/${BOB}`]: { enabled: false, accountVersion: 2 } });
    await assertFails(getDoc(doc(as(ALICE), 'rooms/m1')));
  });

  it('denies a member when an access document is missing', async () => {
    await seed({ [`chatAccess/${ALICE}`]: { enabled: true, accountVersion: 1 }, 'rooms/m1': room() });
    await assertFails(getDoc(doc(as(ALICE), 'rooms/m1')));
  });

  it.each(['closed', 'provisioning'])('denies a %s room', async (status) => {
    await seedActiveRoom({ status, closedAt: status === 'closed' ? new Date(0) : null });
    await assertFails(getDoc(doc(as(ALICE), 'rooms/m1')));
  });

  it.each([
    ['one participant', [ALICE]],
    ['three participants', [ALICE, BOB, MALLORY]],
    ['duplicate participant', [ALICE, ALICE]],
    ['non-list participants', ALICE],
  ])('denies a malformed room with %s', async (_label, participantUids) => {
    await seedActiveRoom({ participantUids });
    await assertFails(getDoc(doc(as(ALICE), 'rooms/m1')));
  });

  it('denies listing rooms (clients attach to explicit room IDs from Express)', async () => {
    await seedActiveRoom();
    await assertFails(getDocs(collection(as(ALICE), 'rooms')));
    await assertFails(
      getDocs(query(collection(as(ALICE), 'rooms'), where('participantUids', 'array-contains', ALICE))),
    );
  });
});

describe('messages', () => {
  it('allows a member to run the bounded history listener query', async () => {
    await seedActiveRoom();
    const q = query(collection(as(ALICE), 'rooms/m1/messages'), orderBy('sequence', 'desc'), limit(30));
    await assertSucceeds(getDocs(q));
    await assertSucceeds(getDoc(doc(as(BOB), 'rooms/m1/messages/msg1')));
  });

  it('denies a member history query without a limit or above 30', async () => {
    await seedActiveRoom();
    const messages = collection(as(ALICE), 'rooms/m1/messages');
    await assertFails(getDocs(messages));
    await assertFails(getDocs(query(messages, orderBy('sequence', 'desc'))));
    await assertFails(getDocs(query(messages, orderBy('sequence', 'desc'), limit(31))));
  });

  it('denies anonymous users and nonmembers', async () => {
    await seedActiveRoom();
    await assertFails(getDoc(doc(anon(), 'rooms/m1/messages/msg1')));
    await assertFails(getDoc(doc(as(MALLORY), 'rooms/m1/messages/msg1')));
    await assertFails(getDocs(query(collection(as(MALLORY), 'rooms/m1/messages'), limit(30))));
  });

  it('denies reads once the room is closed', async () => {
    await seedActiveRoom({ status: 'closed', closedAt: new Date(0) });
    await assertFails(getDoc(doc(as(ALICE), 'rooms/m1/messages/msg1')));
  });

  it('denies reads when either participant is disabled', async () => {
    await seedActiveRoom();
    await seed({ [`chatAccess/${BOB}`]: { enabled: false, accountVersion: 2 } });
    await assertFails(getDoc(doc(as(ALICE), 'rooms/m1/messages/msg1')));
  });

  it('denies reading messages of a room that does not exist', async () => {
    await seed({ [`chatAccess/${ALICE}`]: { enabled: true, accountVersion: 1 } });
    await assertFails(getDoc(doc(as(ALICE), 'rooms/missing/messages/msg1')));
  });
});

describe('readStates', () => {
  it('allows a member to read only their own read state', async () => {
    await seedActiveRoom();
    await assertSucceeds(getDoc(doc(as(ALICE), `rooms/m1/readStates/${ALICE}`)));
    await assertFails(getDoc(doc(as(ALICE), `rooms/m1/readStates/${BOB}`)));
    await assertFails(getDoc(doc(anon(), `rooms/m1/readStates/${ALICE}`)));
  });

  it('denies a nonmember reading a read state under their own uid', async () => {
    await seedActiveRoom();
    await seed({ [`rooms/m1/readStates/${MALLORY}`]: { lastReadSequence: 0, updatedAt: new Date(0) } });
    await assertFails(getDoc(doc(as(MALLORY), `rooms/m1/readStates/${MALLORY}`)));
  });

  it('denies read states of a closed room', async () => {
    await seedActiveRoom({ status: 'closed', closedAt: new Date(0) });
    await assertFails(getDoc(doc(as(ALICE), `rooms/m1/readStates/${ALICE}`)));
  });
});

describe('chatAccess', () => {
  it('allows a user to read only their own access document', async () => {
    await seedActiveRoom();
    await assertSucceeds(getDoc(doc(as(ALICE), `chatAccess/${ALICE}`)));
    await assertFails(getDoc(doc(as(ALICE), `chatAccess/${BOB}`)));
    await assertFails(getDoc(doc(anon(), `chatAccess/${ALICE}`)));
  });
});

describe('client writes', () => {
  it('denies every client write, even by members', async () => {
    await seedActiveRoom();
    const db = as(ALICE);
    const writes: [string, () => Promise<unknown>][] = [
      ['create room', () => setDoc(doc(db, 'rooms/m2'), room())],
      ['update room', () => updateDoc(doc(db, 'rooms/m1'), { status: 'active', lastMessageSequence: 9 })],
      ['reopen closed room', () => setDoc(doc(db, 'rooms/m1'), room({ status: 'active' }))],
      ['delete room', () => deleteDoc(doc(db, 'rooms/m1'))],
      ['create message', () => setDoc(doc(db, 'rooms/m1/messages/msg2'), { ...message, sequence: 2 })],
      ['edit message', () => updateDoc(doc(db, 'rooms/m1/messages/msg1'), { plainText: 'edited' })],
      ['delete message', () => deleteDoc(doc(db, 'rooms/m1/messages/msg1'))],
      ['update own read state', () => updateDoc(doc(db, `rooms/m1/readStates/${ALICE}`), { lastReadSequence: 99 })],
      ['enable own access', () => setDoc(doc(db, `chatAccess/${ALICE}`), { enabled: true, accountVersion: 99 })],
      ['write arbitrary collection', () => setDoc(doc(db, 'profiles/alice'), { displayName: 'Alice' })],
    ];
    for (const [label, write] of writes) {
      try {
        await assertFails(write());
      } catch (err) {
        throw new Error(`Client write allowed: ${label}`, { cause: err });
      }
    }
    await assertFails(setDoc(doc(anon(), 'rooms/m3'), room()));
  });

  it('denies reads of any other collection', async () => {
    await seed({ 'profiles/alice': { displayName: 'Alice' }, 'users/alice': { email: 'a@example.com' } });
    await assertFails(getDoc(doc(as(ALICE), 'profiles/alice')));
    await assertFails(getDoc(doc(as(ALICE), 'users/alice')));
  });
});
