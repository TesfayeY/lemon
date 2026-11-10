/**
 * Pair exclusions owned by later phases (spec §4.4 items 6-7).
 *
 * Discovery asks one question: which of these candidates must the viewer
 * never see, in either direction? Providers answer for a bounded batch of
 * IDs (one page or one session build), never by scanning a collection.
 *
 * Likes and passes are checked by the discovery service itself, because their
 * collections already exist.
 */

export interface PairExclusionProvider {
  /** Subset of `candidateIds` hidden from `viewerId`. Must treat both directions where the rule is symmetric. */
  excludedAmong(viewerId: string, candidateIds: readonly string[]): Promise<Set<string>>;
}

/**
 * Default until the owning phases land. Each is a TODO, not a policy choice:
 * - TODO(Phase 09): existing matches and terminal pairs (`pairs` state closed/unmatched), both directions.
 * - TODO(Phase 12): blocks in either direction (permanent for the pair even after unblock).
 * - TODO(Phase 12): report-triggered hides (`reportHides`, reporter → subject; hide both ways).
 */
export const noPairExclusions: PairExclusionProvider = {
  async excludedAmong() {
    return new Set();
  },
};

/** Union of several providers, e.g. blocks + pairs + report hides. */
export function combineExclusions(...providers: PairExclusionProvider[]): PairExclusionProvider {
  return {
    async excludedAmong(viewerId, candidateIds) {
      if (candidateIds.length === 0) return new Set();
      const sets = await Promise.all(providers.map((p) => p.excludedAmong(viewerId, candidateIds)));
      return new Set(sets.flatMap((s) => [...s]));
    },
  };
}
