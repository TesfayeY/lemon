/**
 * Fixed reason catalogs for staff decisions. Every rejection, suspension and
 * restoration names one of these keys; free text goes only in the optional
 * internal note. Photo reasons are owned by the media module because owners
 * see them; account reasons are staff-only. Prompt answers have no review
 * (D-13), so there is no prompt rejection catalog.
 */

import { REJECTION_REASONS as PHOTO_REJECTION_REASONS } from '../media/review-service.js';

export const SUSPENSION_REASONS = {
  harassment: 'Harassment or threats toward other members',
  scam_or_spam: 'Scam, spam or commercial solicitation',
  impersonation: 'Impersonating another person',
  underage_concern: 'Credible concern that the member is under 18',
  hateful_conduct: 'Hateful conduct',
  community_guidelines: 'Other serious or repeated community guideline violation',
} as const;

export const RESTORE_REASONS = {
  appeal_upheld: 'Appeal reviewed and upheld',
  decision_error: 'The suspension was applied in error',
  concern_resolved: 'The concern was investigated and resolved',
} as const;

export type SuspensionReason = keyof typeof SUSPENSION_REASONS;
export type RestoreReason = keyof typeof RESTORE_REASONS;

export const NOTE_MAX_LENGTH = 500;

export interface ReasonOption {
  code: string;
  description: string;
}

function options(catalog: Record<string, string>): ReasonOption[] {
  return Object.entries(catalog).map(([code, description]) => ({ code, description }));
}

export function reasonCatalog() {
  return {
    photoRejection: options(PHOTO_REJECTION_REASONS),
    accountSuspension: options(SUSPENSION_REASONS),
    accountRestore: options(RESTORE_REASONS),
  };
}

export const SUSPENSION_REASON_CODES = Object.keys(SUSPENSION_REASONS) as [SuspensionReason, ...SuspensionReason[]];
export const RESTORE_REASON_CODES = Object.keys(RESTORE_REASONS) as [RestoreReason, ...RestoreReason[]];
