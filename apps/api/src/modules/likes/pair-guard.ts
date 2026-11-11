import type { ClientSession } from 'mongodb';

/**
 * Pair-level guard for like actions.
 *
 * Blocks (Phase 12) and matches/canonical pairs (Phase 09) don't exist yet, so
 * the default allows everything. The like service already calls both hooks in
 * the right places:
 *
 * - `check` runs inside the send transaction before any charge, and when
 *   listing incoming likes. Any refusal is reported as PROFILE_UNAVAILABLE so a
 *   block is never distinguishable from an unavailable profile.
 * - `touch` runs inside the send and decline transactions after the like write.
 *
 * TODO(Phase 09): implement `touch` as a write to the canonical pair record
 * (pairKey = sorted member IDs) so conflicting concurrent pair actions —
 * opposite likes, accept vs decline — retry against current state. Refuse in
 * `check` when the pair is already matched or closed.
 * TODO(Phase 12): refuse in `check` when either direction has a block, a
 * terminal unmatch or a report-triggered hide.
 */

export interface PairContext {
  fromUserId: string;
  toUserId: string;
  session?: ClientSession;
}

export type PairCheck =
  | { ok: true }
  | { ok: false; reason: 'blocked' | 'matched' | 'closed' };

export interface PairTouch extends PairContext {
  session: ClientSession;
  action: 'like' | 'decline';
  likeId: string;
}

export interface PairGuard {
  check(ctx: PairContext): Promise<PairCheck>;
  touch(ctx: PairTouch): Promise<void>;
}

export const noopPairGuard: PairGuard = {
  check: async () => ({ ok: true }),
  touch: async () => undefined,
};
