/**
 * Profile document schema and validation.
 *
 * Rules:
 * - displayName: 1-40 grapheme clusters, allow Ethiopic/Unicode
 * - Photos: 3-6 approved items (handled by media module)
 * - Prompt answers: exactly 3 distinct active prompts, 1-300 grapheme clusters each
 * - Server computes readiness — clients cannot set it
 */

export interface ProfileDocument {
  _id: string; // same as userId
  userId: string;
  displayName: string | null;
  genderIdentity: string | null; // catalog ID
  genderDisplay: 'public' | 'private'; // visibility
  cityId: string | null;
  stateCode: string | null;
  countryCode: 'US';
  intention: string | null; // catalog ID
  bio: string | null; // optional, max 500 grapheme clusters
  hometown: string | null; // optional free text
  hometownDisplay: 'public' | 'private';
  occupation: string | null;
  occupationDisplay: 'public' | 'private';
  education: string | null;
  educationDisplay: 'public' | 'private';
  height: number | null; // cm
  heightDisplay: 'public' | 'private';
  languages: string[]; // catalog IDs
  languagesDisplay: 'public' | 'private';
  religion: string | null;
  religionDisplay: 'public' | 'private';
  revision: number;
  publishedRevision: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A prompt answer keeps its published text separate from the latest
 * submission, so an edit never replaces approved content before review.
 * Only review (Phase 05/13) moves pendingText into approvedText.
 */
export interface PromptAnswerDocument {
  _id: string;
  ownerId: string;
  promptId: string;
  slot: number; // 0..MAX_PROMPT_ANSWERS-1; unique per owner, so the database caps the count
  approvedText: string | null; // published; the only text other users see
  pendingText: string | null; // awaiting review; never published automatically
  state: 'approved' | 'pending' | 'rejected'; // review state of the latest submission
  revision: number; // owner edit revision (two-device safety)
  publishedRevision: number; // content version of approvedText; 0 = never published
  createdAt: Date;
  updatedAt: Date;
}

/** Answers per profile; enforced by the unique (ownerId, slot) index */
export const MAX_PROMPT_ANSWERS = 3;

/** Grapheme limit for optional free-text fields (hometown, occupation, education, religion) */
export const OPTIONAL_TEXT_MAX = 100;

export function createEmptyProfile(userId: string): ProfileDocument {
  const now = new Date();
  return {
    _id: userId,
    userId,
    displayName: null,
    genderIdentity: null,
    genderDisplay: 'public',
    cityId: null,
    stateCode: null,
    countryCode: 'US',
    intention: null,
    bio: null,
    hometown: null,
    hometownDisplay: 'private',
    occupation: null,
    occupationDisplay: 'private',
    education: null,
    educationDisplay: 'private',
    height: null,
    heightDisplay: 'private',
    languages: [],
    languagesDisplay: 'public',
    religion: null,
    religionDisplay: 'private',
    revision: 1,
    publishedRevision: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Count grapheme clusters in a string.
 * Uses Intl.Segmenter for correct Unicode handling (Ethiopic, emoji, etc.)
 */
export function graphemeLength(str: string): number {
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  let count = 0;
  for (const _ of segmenter.segment(str)) {
    count++;
  }
  return count;
}

/** Normalize whitespace without stripping Unicode content */
export function normalizeWhitespace(str: string): string {
  return str.replace(/\s+/g, ' ').trim();
}
