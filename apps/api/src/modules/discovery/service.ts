/**
 * Discovery sessions, pages and passes (spec §4.4, Phase 07).
 *
 * - A session is a bounded, shuffled snapshot of mutually eligible candidate
 *   IDs, tied to the viewer's preferences revision and residence city.
 * - Every page rechecks each scanned candidate (eligibility, likes, passes and
 *   pair exclusions). The cursor's offset is the next unscanned position, so
 *   candidates that dropped out are skipped without repeating or skipping others.
 * - An empty pool is reported as `empty`; preferences are never widened.
 */

import { randomInt } from 'node:crypto';
import type { Collection, Db, Filter } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import type { UserDocument } from '../auth/account.js';
import type { ProfileDocument, PromptAnswerDocument } from '../profiles/schema.js';
import type { PreferencesDocument } from '../preferences/schema.js';
import { toPublicProfileDTO, type PublicProfileDTO } from '../profiles/dto.js';
import { toPublicPhotoDTO, type PublicPhotoDTO } from '../media/dto.js';
import { MAX_PHOTOS, PhotoState, type PhotoDocument } from '../media/schema.js';
import { isDuplicateKeyError } from '../../indexes.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import { browseBlocker, pairBlocker, type DiscoveryParticipant, type EligibilityContext } from './eligibility.js';
import { noPairExclusions, type PairExclusionProvider } from './exclusions.js';
import { defaultLocationCatalog, resolveResidence, viewerScopeFilter, type LocationCatalog } from './location.js';
import {
  DISCOVERY_SESSIONS_COLLECTION,
  LIKES_COLLECTION,
  PASSES_COLLECTION,
  type DiscoverySessionDocument,
  type LikeView,
  type PassDocument,
} from './schema.js';
import { stableShuffle } from './shuffle.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const DISCOVERY_DEFAULTS = {
  pageSize: 10,
  /** Positions one request may scan before returning a short page with a cursor. */
  maxScanPerPage: 50,
  /** Candidate IDs kept in one session. */
  maxSessionSize: 200,
  /** Profiles read from the index pre-filter when building a session. */
  poolScanLimit: 2000,
  /** Batch size for `$in` lookups while building a session. */
  poolBatchSize: 500,
  sessionTtlMs: 30 * 60 * 1000,
  passCooldownDays: 30,
} as const;

export interface DiscoveryOptions {
  cursorSecret: string;
  passCooldownDays?: number;
  now?: () => Date;
  /** Seed for each new session's shuffle; inject for deterministic tests. */
  newSeed?: () => number;
  exclusions?: PairExclusionProvider;
  catalog?: LocationCatalog;
  pageSize?: number;
  maxScanPerPage?: number;
  maxSessionSize?: number;
  poolScanLimit?: number;
  poolBatchSize?: number;
  sessionTtlMs?: number;
}

export type DiscoveryErrorCode =
  | 'ACCOUNT_NOT_ELIGIBLE'
  | 'DISCOVERY_PAUSED'
  | 'INVALID_CURSOR'
  | 'DISCOVERY_SESSION_EXPIRED'
  | 'DISCOVERY_SESSION_INVALIDATED'
  | 'PROFILE_UNAVAILABLE'
  | 'VALIDATION_ERROR';

export class DiscoveryError extends Error {
  constructor(
    readonly status: number,
    readonly code: DiscoveryErrorCode,
    message: string,
    readonly retryable = false,
    readonly fieldErrors?: { field: string; message: string }[],
  ) {
    super(message);
  }
}

export interface DiscoveryCard {
  profile: PublicProfileDTO;
  photos: PublicPhotoDTO[];
}

/**
 * - `more`: call again with `nextCursor` (a page may be short or even empty
 *   when many scanned candidates dropped out).
 * - `end`: this session is fully scanned; start a new one later.
 * - `empty`: nobody currently matches the viewer's filters. Nothing was widened.
 */
export type DiscoveryStatus = 'more' | 'end' | 'empty';

export interface DiscoveryPage {
  items: DiscoveryCard[];
  status: DiscoveryStatus;
  preferencesRevision: number;
  nextCursor: string | null;
}

export interface PassResult {
  candidateId: string;
  passedAt: Date;
  expiresAt: Date;
}

interface Viewer {
  participant: DiscoveryParticipant;
  preferences: PreferencesDocument;
}

const PARTICIPANT_USER_FIELDS = { _id: 1, accountStatus: 1, profileReady: 1, discoverPaused: 1, birthDate: 1 } as const;
const PARTICIPANT_PROFILE_FIELDS = { _id: 0, userId: 1, genderIdentity: 1, cityId: 1, stateCode: 1, countryCode: 1 } as const;
const PARTICIPANT_PREFS_FIELDS = {
  _id: 0, userId: 1, acceptedGenderCategories: 1, minAge: 1, maxAge: 1, locationScope: 1, longDistance: 1, revision: 1,
} as const;

type ParticipantUser = Pick<UserDocument, '_id' | 'accountStatus' | 'profileReady' | 'discoverPaused' | 'birthDate'>;
type ParticipantProfile = Pick<ProfileDocument, 'userId' | 'genderIdentity' | 'cityId' | 'stateCode' | 'countryCode'>;
type ParticipantPrefs = Pick<
  PreferencesDocument,
  'userId' | 'acceptedGenderCategories' | 'minAge' | 'maxAge' | 'locationScope' | 'longDistance' | 'revision'
>;

function toParticipant(
  user: ParticipantUser,
  profile: ParticipantProfile | null | undefined,
  prefs: ParticipantPrefs | null | undefined,
): DiscoveryParticipant {
  return {
    userId: user._id,
    accountStatus: user.accountStatus,
    profileReady: user.profileReady,
    discoverPaused: user.discoverPaused,
    birthDate: user.birthDate,
    genderIdentity: profile?.genderIdentity ?? null,
    cityId: profile?.cityId ?? null,
    stateCode: profile?.stateCode ?? null,
    countryCode: profile?.countryCode ?? null,
    preferences: prefs
      ? {
          acceptedGenderCategories: prefs.acceptedGenderCategories,
          minAge: prefs.minAge,
          maxAge: prefs.maxAge,
          locationScope: prefs.locationScope,
          longDistance: prefs.longDistance,
        }
      : null,
  };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function createDiscoveryService(db: Db, options: DiscoveryOptions) {
  const config = {
    pageSize: options.pageSize ?? DISCOVERY_DEFAULTS.pageSize,
    maxScanPerPage: options.maxScanPerPage ?? DISCOVERY_DEFAULTS.maxScanPerPage,
    maxSessionSize: options.maxSessionSize ?? DISCOVERY_DEFAULTS.maxSessionSize,
    poolScanLimit: options.poolScanLimit ?? DISCOVERY_DEFAULTS.poolScanLimit,
    poolBatchSize: options.poolBatchSize ?? DISCOVERY_DEFAULTS.poolBatchSize,
    sessionTtlMs: options.sessionTtlMs ?? DISCOVERY_DEFAULTS.sessionTtlMs,
    passCooldownDays: options.passCooldownDays ?? DISCOVERY_DEFAULTS.passCooldownDays,
  };
  if (config.maxScanPerPage < config.pageSize) throw new Error('maxScanPerPage must be at least pageSize');
  const now = options.now ?? (() => new Date());
  const newSeed = options.newSeed ?? (() => randomInt(0, 2 ** 32 - 1));
  const exclusions = options.exclusions ?? noPairExclusions;
  const catalog = options.catalog ?? defaultLocationCatalog;

  const users = db.collection<UserDocument>('users');
  const profiles = db.collection<ProfileDocument>('profiles');
  const preferences = db.collection<PreferencesDocument>('preferences');
  const promptAnswers = db.collection<PromptAnswerDocument>('promptAnswers');
  const photos = db.collection<PhotoDocument>('photos');
  const passes: Collection<PassDocument> = db.collection<PassDocument>(PASSES_COLLECTION);
  const sessions = db.collection<DiscoverySessionDocument>(DISCOVERY_SESSIONS_COLLECTION);
  const likes = db.collection<LikeView>(LIKES_COLLECTION);

  async function loadViewer(user: UserDocument): Promise<Viewer | null> {
    const [profile, prefs] = await Promise.all([
      profiles.findOne({ userId: user._id }, { projection: PARTICIPANT_PROFILE_FIELDS }),
      preferences.findOne({ userId: user._id }, { projection: PARTICIPANT_PREFS_FIELDS }),
    ]);
    if (!prefs) return null;
    return { participant: toParticipant(user, profile, prefs), preferences: prefs as PreferencesDocument };
  }

  /** Viewer must be able to browse; paused viewers get their own code so the app can explain. */
  async function requireBrowsingViewer(user: UserDocument, ctx: EligibilityContext): Promise<Viewer> {
    const viewer = await loadViewer(user);
    const blocker = viewer ? browseBlocker(viewer.participant, ctx) : 'missing_preferences';
    if (blocker === 'paused') {
      throw new DiscoveryError(403, 'DISCOVERY_PAUSED', 'Discover is paused for your account');
    }
    if (blocker || !viewer) {
      throw new DiscoveryError(403, 'ACCOUNT_NOT_ELIGIBLE', 'Complete your profile to use Discover');
    }
    return viewer;
  }

  async function loadParticipants(ids: readonly string[]): Promise<Map<string, DiscoveryParticipant>> {
    if (ids.length === 0) return new Map();
    const list = [...ids];
    const [userDocs, profileDocs, prefDocs] = await Promise.all([
      users.find({ _id: { $in: list } }, { projection: PARTICIPANT_USER_FIELDS }).toArray(),
      profiles.find({ userId: { $in: list } }, { projection: PARTICIPANT_PROFILE_FIELDS }).toArray(),
      preferences.find({ userId: { $in: list } }, { projection: PARTICIPANT_PREFS_FIELDS }).toArray(),
    ]);
    const profileById = new Map(profileDocs.map((p) => [p.userId, p]));
    const prefsById = new Map(prefDocs.map((p) => [p.userId, p]));
    return new Map(userDocs.map((u) => [u._id, toParticipant(u, profileById.get(u._id), prefsById.get(u._id))]));
  }

  /**
   * Pair state that hides a candidate: any like from the viewer (any state),
   * a pending like from the candidate (shown in Likes instead), a like from the
   * candidate that the viewer declined (decline is terminal), an unexpired
   * pass, and the pluggable block/pair/report-hide/match provider.
   */
  async function excludedByPairState(viewerId: string, ids: readonly string[], at: Date): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const list = [...ids];
    const [outgoing, incoming, passed, provided] = await Promise.all([
      likes.find({ fromUserId: viewerId, toUserId: { $in: list } }, { projection: { _id: 0, toUserId: 1 } }).toArray(),
      likes
        .find({ fromUserId: { $in: list }, toUserId: viewerId, state: { $in: ['pending', 'declined'] } }, { projection: { _id: 0, fromUserId: 1 } })
        .toArray(),
      passes
        .find({ viewerId, candidateId: { $in: list }, expiresAt: { $gt: at } }, { projection: { _id: 0, candidateId: 1 } })
        .toArray(),
      exclusions.excludedAmong(viewerId, list),
    ]);
    return new Set([
      ...outgoing.map((l) => l.toUserId),
      ...incoming.map((l) => l.fromUserId),
      ...passed.map((p) => p.candidateId),
      ...provided,
    ]);
  }

  /** The subset of `ids` the viewer may see right now, every rule rechecked. */
  async function eligibleAmong(viewer: Viewer, ids: readonly string[], ctx: EligibilityContext): Promise<Set<string>> {
    const [participants, excluded] = await Promise.all([
      loadParticipants(ids),
      excludedByPairState(viewer.participant.userId, ids, ctx.now),
    ]);
    const eligible = new Set<string>();
    for (const id of ids) {
      const candidate = participants.get(id);
      if (!candidate || excluded.has(id)) continue;
      if (pairBlocker(viewer.participant, candidate, ctx) === null) eligible.add(id);
    }
    return eligible;
  }

  /** Index-backed pre-filter on the viewer's side, then the full mutual check, then a seeded shuffle. */
  async function buildCandidatePool(viewer: Viewer, ctx: EligibilityContext, seed: number): Promise<string[]> {
    const residence = resolveResidence(viewer.participant, catalog)!;
    const prefs = viewer.preferences;
    const metroCityIds =
      residence.metroId && catalog.metroCityIds ? catalog.metroCityIds(residence.metroId) : [residence.cityId];
    const filter: Filter<ProfileDocument> = {
      genderIdentity: { $in: prefs.acceptedGenderCategories },
      ...viewerScopeFilter(prefs.locationScope, residence, metroCityIds),
      countryCode: 'US' as const,
      userId: { $ne: viewer.participant.userId },
    };
    const prefiltered = await profiles
      .find(filter, { projection: { _id: 0, userId: 1 } })
      .limit(config.poolScanLimit)
      .toArray();

    const eligible: string[] = [];
    for (const batch of chunk(prefiltered.map((p) => p.userId), config.poolBatchSize)) {
      const ok = await eligibleAmong(viewer, batch, ctx);
      eligible.push(...batch.filter((id) => ok.has(id)));
    }
    // Sort first so the permutation depends only on the seed, not on index order
    eligible.sort();
    return stableShuffle(eligible, seed).slice(0, config.maxSessionSize);
  }

  async function hydrate(ids: readonly string[]): Promise<DiscoveryCard[]> {
    if (ids.length === 0) return [];
    const list = [...ids];
    const [userDocs, profileDocs, answerDocs, photoDocs] = await Promise.all([
      users.find({ _id: { $in: list } }).toArray(),
      profiles.find({ userId: { $in: list } }).toArray(),
      promptAnswers.find({ ownerId: { $in: list }, approvedText: { $ne: null } }).sort({ slot: 1 }).toArray(),
      photos.find({ ownerId: { $in: list }, state: PhotoState.APPROVED }).sort({ order: 1 }).toArray(),
    ]);
    const userById = new Map(userDocs.map((u) => [u._id, u]));
    const profileById = new Map(profileDocs.map((p) => [p.userId, p]));
    const cards: DiscoveryCard[] = [];
    for (const id of ids) {
      const user = userById.get(id);
      const profile = profileById.get(id);
      if (!user || !profile) continue;
      cards.push({
        profile: toPublicProfileDTO(profile, user, answerDocs.filter((a) => a.ownerId === id)),
        photos: photoDocs.filter((p) => p.ownerId === id).slice(0, MAX_PHOTOS).map(toPublicPhotoDTO),
      });
    }
    return cards;
  }

  async function openSession(
    viewerId: string,
    viewer: Viewer,
    cursor: string,
    at: Date,
  ): Promise<{ session: DiscoverySessionDocument; offset: number }> {
    const decoded = decodeCursor(cursor, options.cursorSecret);
    if (!decoded.ok) throw new DiscoveryError(400, 'INVALID_CURSOR', 'This page link is not valid. Refresh Discover.');
    const { sessionId, nextOffset, expiresAt } = decoded.payload;
    const expired = () =>
      new DiscoveryError(409, 'DISCOVERY_SESSION_EXPIRED', 'Discover was refreshed. Start again from the top.', true);
    if (expiresAt <= at.getTime()) throw expired();

    const session = await sessions.findOne({ _id: sessionId });
    // TTL may already have removed it
    if (!session) throw expired();
    // A cursor issued to someone else is answered exactly like a forged one
    if (session.ownerId !== viewerId || nextOffset > session.candidateIds.length) {
      throw new DiscoveryError(400, 'INVALID_CURSOR', 'This page link is not valid. Refresh Discover.');
    }
    if (session.expiresAt.getTime() <= at.getTime()) throw expired();
    if (
      session.preferencesRevision !== viewer.preferences.revision ||
      session.viewerCityId !== viewer.participant.cityId
    ) {
      throw new DiscoveryError(
        409,
        'DISCOVERY_SESSION_INVALIDATED',
        'Your filters changed. Discover will restart with your new filters.',
        true,
      );
    }
    return { session, offset: nextOffset };
  }

  /** Scan from `offset`, rechecking each position, until a full page or the scan budget is used. */
  async function scan(
    viewer: Viewer,
    session: DiscoverySessionDocument,
    offset: number,
    ctx: EligibilityContext,
  ): Promise<{ ids: string[]; nextOffset: number }> {
    const all = session.candidateIds;
    const stopAt = Math.min(all.length, offset + config.maxScanPerPage);
    const picked: string[] = [];
    let position = offset;
    while (position < stopAt && picked.length < config.pageSize) {
      const batch = all.slice(position, Math.min(stopAt, position + config.pageSize));
      const eligible = await eligibleAmong(viewer, batch, ctx);
      for (const id of batch) {
        position++;
        if (eligible.has(id)) {
          picked.push(id);
          // Stop right after the last returned candidate: later positions stay unscanned
          if (picked.length === config.pageSize) break;
        }
      }
    }
    return { ids: picked, nextOffset: position };
  }

  async function getPage(user: UserDocument, cursor?: string): Promise<DiscoveryPage> {
    const at = now();
    const ctx: EligibilityContext = { now: at, catalog };
    const viewer = await requireBrowsingViewer(user, ctx);
    const preferencesRevision = viewer.preferences.revision;

    let session: DiscoverySessionDocument;
    let offset = 0;
    const isNew = cursor === undefined;
    if (cursor !== undefined) {
      ({ session, offset } = await openSession(user._id, viewer, cursor, at));
    } else {
      const seed = newSeed();
      const candidateIds = await buildCandidatePool(viewer, ctx, seed);
      if (candidateIds.length === 0) {
        return { items: [], status: 'empty', preferencesRevision, nextCursor: null };
      }
      session = {
        _id: uuidv4(),
        ownerId: user._id,
        preferencesRevision,
        viewerCityId: viewer.participant.cityId!,
        seed,
        candidateIds,
        createdAt: at,
        expiresAt: new Date(at.getTime() + config.sessionTtlMs),
      };
      await sessions.insertOne(session);
    }

    const { ids, nextOffset } = await scan(viewer, session, offset, ctx);
    const items = await hydrate(ids);
    const hasMore = nextOffset < session.candidateIds.length;
    const status: DiscoveryStatus = hasMore ? 'more' : isNew && items.length === 0 ? 'empty' : 'end';
    const nextCursor = hasMore
      ? encodeCursor(
          { sessionId: session._id, nextOffset, expiresAt: session.expiresAt.getTime() },
          options.cursorSecret,
        )
      : null;
    return { items, status, preferencesRevision, nextCursor };
  }

  /**
   * Idempotent: repeating an active pass returns it unchanged. A pass whose
   * cooldown ended (even if TTL has not deleted it yet) is renewed.
   * Any existing user may be passed, so the response never reveals whether
   * the candidate is blocked, paused or otherwise unavailable.
   */
  async function pass(user: UserDocument, candidateId: string): Promise<PassResult> {
    const at = now();
    await requireBrowsingViewer(user, { now: at, catalog });
    if (candidateId === user._id) {
      throw new DiscoveryError(422, 'VALIDATION_ERROR', 'Invalid fields', false, [
        { field: 'candidateId', message: 'You cannot pass yourself' },
      ]);
    }
    const candidate = await users.findOne({ _id: candidateId }, { projection: { _id: 1 } });
    if (!candidate) throw new DiscoveryError(404, 'PROFILE_UNAVAILABLE', 'This profile is not available');

    const expiresAt = new Date(at.getTime() + config.passCooldownDays * DAY_MS);
    try {
      await passes.insertOne({ _id: uuidv4(), viewerId: user._id, candidateId, passedAt: at, expiresAt });
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      await passes.updateOne(
        { viewerId: user._id, candidateId, expiresAt: { $lte: at } },
        { $set: { passedAt: at, expiresAt } },
      );
    }
    const stored = await passes.findOne({ viewerId: user._id, candidateId });
    return { candidateId, passedAt: stored!.passedAt, expiresAt: stored!.expiresAt };
  }

  /**
   * Whether `candidateId` would currently be shown to the viewer in Discover.
   * For rechecking discovery-context actions (e.g. profile reads opened from
   * Discover); likes and matches have their own contextual rules.
   */
  async function isDiscoverable(user: UserDocument, candidateId: string): Promise<boolean> {
    const ctx: EligibilityContext = { now: now(), catalog };
    const viewer = await loadViewer(user);
    if (!viewer || browseBlocker(viewer.participant, ctx)) return false;
    return (await eligibleAmong(viewer, [candidateId], ctx)).has(candidateId);
  }

  return { getPage, pass, isDiscoverable };
}

export type DiscoveryService = ReturnType<typeof createDiscoveryService>;
