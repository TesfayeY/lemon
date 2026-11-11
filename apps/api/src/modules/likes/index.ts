export { createLikesRoutes, type LikesRoutesConfig, type LikesRoutesOptions } from './routes.js';
export { noopPairGuard, type PairGuard, type PairCheck, type PairContext, type PairTouch } from './pair-guard.js';
export { LIKES_COLLECTION, COMMENT_MAX_GRAPHEMES, type LikeDocument, type LikeTarget, type LikeState, type LikeContextSnapshot } from './schema.js';
export { sendLike, declineLike, listIncoming, LikeError, isAvailableToOthers } from './service.js';
export {
  consumeLikeQuota, getQuotaStatus, ensureQuotaIndexes, utcDayKey, nextResetAt,
  DEFAULT_QUOTA_POLICY, QUOTAS_COLLECTION, type QuotaPolicy, type QuotaStatus, type QuotaDocument,
} from './quota.js';
