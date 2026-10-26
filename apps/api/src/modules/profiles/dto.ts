/**
 * Explicit allowlisted profile DTOs.
 *
 * CRITICAL: Public DTOs must NEVER include:
 * - birthDate, email, firebaseUid
 * - report history, moderation fields
 * - raw coordinates, device tokens
 * - private preferences, hidden optional fields
 */

import type { ProfileDocument, PromptAnswerDocument } from './schema.js';
import type { UserDocument } from '../auth/account.js';
import { calculateAge } from '../auth/adult-gate.js';
import { findCity, findGender, findIntention, findPrompt } from '../catalogs/data.js';

/** What the owner sees about their own profile */
export interface SelfProfileDTO {
  userId: string;
  displayName: string | null;
  genderIdentity: string | null;
  genderDisplay: string;
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
  // photos will be added when media module is built
}

/** A published prompt answer as other users see it */
export interface PromptAnswerDTO {
  id: string;
  promptId: string;
  promptText: string;
  text: string;
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

export function toPublicProfileDTO(
  profile: ProfileDocument,
  user: UserDocument,
  answers: PromptAnswerDocument[],
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
    promptAnswers: answers.flatMap(a => (a.approvedText === null ? [] : [toPromptAnswerDTO(a, a.approvedText)])),
  };
}

function toPromptAnswerDTO(answer: PromptAnswerDocument, text: string): PromptAnswerDTO {
  return {
    id: answer._id,
    promptId: answer.promptId,
    promptText: findPrompt(answer.promptId)?.text ?? '',
    text,
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
  };
}
