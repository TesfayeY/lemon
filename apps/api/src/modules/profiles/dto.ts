/**
 * Explicit allowlisted profile DTOs.
 *
 * CRITICAL: Public DTOs must NEVER include:
 * - birthDate, email, firebaseUid
 * - report history, moderation fields
 * - raw coordinates, device tokens
 * - private preferences, hidden optional fields
 * - storage keys, or photos that are not approved
 * - prompt text that is not published (pending or rejected submissions)
 * - unreviewed free text (the gender self-description stays owner-only)
 *
 * The public projection is the single source of truth for what other people
 * see: `GET /v1/profiles/:id`, the owner's preview and every Discover card use it.
 */

import type { Db } from 'mongodb';
import type { ProfileDocument, PromptAnswerDocument } from './schema.js';
import type { UserDocument } from '../auth/account.js';
import { calculateAge } from '../auth/adult-gate.js';
import { findCity, findGender, findIntention, findPrompt } from '../catalogs/data.js';
import { toPublicPhotoDTO, type PublicPhotoDTO } from '../media/dto.js';
import { MAX_PHOTOS, PhotoState, type PhotoDocument } from '../media/schema.js';
import { describePromptRejection, type PromptRejectionDTO } from './prompt-review.js';

/** What the owner sees about their own profile */
export interface SelfProfileDTO {
  userId: string;
  displayName: string | null;
  genderIdentity: string | null;
  genderDisplay: string;
  /** Optional free text next to the catalog choice; owner-only until text review exists */
  genderSelfDescription: string | null;
  cityId: string | null;
  cityName: string | null;
  stateCode: string | null;
  intention: string | null;
  bio: string | null;
  hometown: string | null;
  hometownDisplay: string;
  occupation: string | null;
  occupationDisplay: string;
  education: string | null;
  educationDisplay: string;
  height: number | null;
  heightDisplay: string;
  languages: string[];
  languagesDisplay: string;
  religion: string | null;
  religionDisplay: string;
  promptAnswers: SelfPromptAnswerDTO[];
  revision: number;
  profileReady: boolean;
}

/**
 * What other users see — public projection only.
 * Name, age and location are null only in the owner's preview of an
 * incomplete draft; profiles served to others are always ready.
 */
export interface PublicProfileDTO {
  userId: string;
  displayName: string | null;
  age: number | null;
  cityName: string | null;
  stateCode: string | null;
  intention: string | null;
  intentionLabel: string | null;
  genderIdentity: string | null; // only if genderDisplay === 'public'
  genderLabel: string | null;
  bio: string | null;
  hometown: string | null; // only if hometownDisplay === 'public'
  occupation: string | null; // only if occupationDisplay === 'public'
  education: string | null; // only if educationDisplay === 'public'
  height: number | null; // only if heightDisplay === 'public'
  languages: string[]; // only if languagesDisplay === 'public'
  religion: string | null; // only if religionDisplay === 'public'
  promptAnswers: PromptAnswerDTO[];
  /** Approved photos only, in the owner's order; bytes only via the authenticated media route */
  photos: PublicPhotoDTO[];
}

/** A published prompt answer as other users see it */
export interface PromptAnswerDTO {
  id: string;
  promptId: string;
  promptText: string;
  text: string;
  /** Version of the published text (`publishedRevision`); a like on this answer quotes it */
  contentVersion: number;
}

/** The owner's view of an answer, including any submission awaiting review */
export interface SelfPromptAnswerDTO {
  id: string;
  promptId: string;
  promptText: string;
  approvedText: string | null;
  pendingText: string | null;
  state: PromptAnswerDocument['state'];
  revision: number;
  /** Owner-only: why the latest submission was rejected, with a replace action; null unless rejected */
  rejectionReason: PromptRejectionDTO | null;
}

export function toSelfProfileDTO(
  profile: ProfileDocument,
  user: UserDocument,
  answers: PromptAnswerDocument[],
): SelfProfileDTO {
  const city = profile.cityId ? findCity(profile.cityId) : null;
  return {
    userId: profile.userId,
    displayName: profile.displayName,
    genderIdentity: profile.genderIdentity,
    genderDisplay: profile.genderDisplay,
    genderSelfDescription: profile.genderSelfDescription ?? null,
    cityId: profile.cityId,
    cityName: city?.name ?? null,
    stateCode: profile.stateCode,
    intention: profile.intention,
    bio: profile.bio,
    hometown: profile.hometown,
    hometownDisplay: profile.hometownDisplay,
    occupation: profile.occupation,
    occupationDisplay: profile.occupationDisplay,
    education: profile.education,
    educationDisplay: profile.educationDisplay,
    height: profile.height,
    heightDisplay: profile.heightDisplay,
    languages: profile.languages,
    languagesDisplay: profile.languagesDisplay,
    religion: profile.religion,
    religionDisplay: profile.religionDisplay,
    promptAnswers: answers.map(toSelfPromptAnswerDTO),
    revision: profile.revision,
    profileReady: user.profileReady,
  };
}

/**
 * Build the public projection. It filters its own inputs (published answers,
 * approved photos of this owner), so a caller that passes too much cannot leak it.
 */
export function toPublicProfileDTO(
  profile: ProfileDocument,
  user: UserDocument,
  answers: readonly PromptAnswerDocument[],
  photos: readonly PhotoDocument[],
): PublicProfileDTO {
  const city = profile.cityId ? findCity(profile.cityId) : null;
  const intention = profile.intention ? findIntention(profile.intention) : null;
  const gender = profile.genderIdentity ? findGender(profile.genderIdentity) : null;

  return {
    userId: profile.userId,
    displayName: profile.displayName,
    age: user.birthDate ? calculateAge(new Date(user.birthDate)) : null,
    cityName: city?.name ?? null,
    stateCode: profile.stateCode,
    intention: profile.intention,
    intentionLabel: intention?.label ?? null,
    genderIdentity: profile.genderDisplay === 'public' ? profile.genderIdentity : null,
    genderLabel: profile.genderDisplay === 'public' ? (gender?.label ?? null) : null,
    bio: profile.bio,
    hometown: profile.hometownDisplay === 'public' ? profile.hometown : null,
    occupation: profile.occupationDisplay === 'public' ? profile.occupation : null,
    education: profile.educationDisplay === 'public' ? profile.education : null,
    height: profile.heightDisplay === 'public' ? profile.height : null,
    languages: profile.languagesDisplay === 'public' ? profile.languages : [],
    religion: profile.religionDisplay === 'public' ? profile.religion : null,
    promptAnswers: answers
      .filter(a => a.ownerId === profile.userId && a.approvedText !== null)
      .sort(bySlot)
      .map(a => toPromptAnswerDTO(a, a.approvedText!)),
    photos: photos
      .filter(p => p.ownerId === profile.userId && p.state === PhotoState.APPROVED)
      .sort((a, b) => a.order - b.order)
      .slice(0, MAX_PHOTOS)
      .map(toPublicPhotoDTO),
  };
}

/** Slot order; answers saved before slots existed (until migrated) go last, oldest first */
function bySlot(a: PromptAnswerDocument, b: PromptAnswerDocument): number {
  return (a.slot ?? Number.MAX_SAFE_INTEGER) - (b.slot ?? Number.MAX_SAFE_INTEGER)
    || a.createdAt.getTime() - b.createdAt.getTime();
}

function toPromptAnswerDTO(answer: PromptAnswerDocument, text: string): PromptAnswerDTO {
  return {
    id: answer._id,
    promptId: answer.promptId,
    promptText: findPrompt(answer.promptId)?.text ?? '',
    text,
    // The likes service compares a prompt like's contentVersion with this value
    contentVersion: answer.publishedRevision,
  };
}

function toSelfPromptAnswerDTO(answer: PromptAnswerDocument): SelfPromptAnswerDTO {
  return {
    id: answer._id,
    promptId: answer.promptId,
    promptText: findPrompt(answer.promptId)?.text ?? '',
    approvedText: answer.approvedText,
    pendingText: answer.pendingText,
    state: answer.state,
    revision: answer.revision,
    rejectionReason: answer.state === 'rejected' ? describePromptRejection(answer.rejectionReason) : null,
  };
}

/**
 * Public projections for several owners in four batched reads. Owners without
 * a user or profile document are absent from the map. This decides only what
 * is visible; callers decide who may see whom.
 */
export async function loadPublicProfiles(db: Db, userIds: readonly string[]): Promise<Map<string, PublicProfileDTO>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();
  const [userDocs, profileDocs, answerDocs, photoDocs] = await Promise.all([
    db.collection<UserDocument>('users').find({ _id: { $in: ids } }).toArray(),
    db.collection<ProfileDocument>('profiles').find({ userId: { $in: ids } }).toArray(),
    db.collection<PromptAnswerDocument>('promptAnswers').find({ ownerId: { $in: ids }, approvedText: { $ne: null } }).toArray(),
    db.collection<PhotoDocument>('photos').find({ ownerId: { $in: ids }, state: PhotoState.APPROVED }).toArray(),
  ]);
  const userById = new Map(userDocs.map(u => [u._id, u]));
  const projected = new Map<string, PublicProfileDTO>();
  for (const profile of profileDocs) {
    const user = userById.get(profile.userId);
    if (!user) continue;
    projected.set(profile.userId, toPublicProfileDTO(
      profile,
      user,
      answerDocs.filter(a => a.ownerId === profile.userId),
      photoDocs.filter(p => p.ownerId === profile.userId),
    ));
  }
  return projected;
}
