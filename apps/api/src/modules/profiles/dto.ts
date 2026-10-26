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
import { findCity, findGender, findIntention } from '../catalogs/data.js';

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
  promptAnswers: PromptAnswerDTO[];
  revision: number;
  profileReady: boolean;
}

/** What other users see — public projection only */
export interface PublicProfileDTO {
  userId: string;
  displayName: string;
  age: number;
  cityName: string;
  stateCode: string;
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

export interface PromptAnswerDTO {
  id: string;
  promptId: string;
  promptText: string;
  text: string;
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
    promptAnswers: answers
      .filter(a => a.state === 'approved')
      .map(toPromptAnswerDTO),
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

  const birthDate = user.birthDate ? new Date(user.birthDate) : null;
  const age = birthDate ? calculateAge(birthDate) : 0;

  return {
    userId: profile.userId,
    displayName: profile.displayName!,
    age,
    cityName: city?.name ?? '',
    stateCode: profile.stateCode ?? '',
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
      .filter(a => a.state === 'approved')
      .map(toPromptAnswerDTO),
  };
}

function toPromptAnswerDTO(answer: PromptAnswerDocument): PromptAnswerDTO {
  const prompt = findPrompt(answer.promptId);
  return {
    id: answer._id,
    promptId: answer.promptId,
    promptText: prompt?.text ?? '',
    text: answer.text,
  };
}

// Need to import findPrompt
import { findPrompt } from '../catalogs/data.js';
