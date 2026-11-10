/**
 * Mutual discovery eligibility (spec §4.4, items 1-5): pure and clock-injected.
 *
 * Pair-state exclusions (likes, passes, blocks, terminal pairs, report hides,
 * matches; items 6-8) need database reads and live in the service.
 * Nothing here ranks or scores anyone: the result is only eligible or not.
 */

import { canInteract, type AccountStatusType } from '../auth/account.js';
import { calculateAge } from '../auth/adult-gate.js';
import type { LocationScope } from '../preferences/schema.js';
import { locationsCompatible, resolveResidence, type LocationCatalog, type Residence } from './location.js';

export interface ParticipantPreferences {
  acceptedGenderCategories: string[];
  minAge: number;
  maxAge: number;
  locationScope: LocationScope;
  longDistance: boolean;
}

/** The fields eligibility reads, gathered from users, profiles and preferences. */
export interface DiscoveryParticipant {
  userId: string;
  accountStatus: AccountStatusType;
  profileReady: boolean;
  discoverPaused: boolean;
  birthDate: string | null;
  genderIdentity: string | null;
  cityId: string | null;
  stateCode: string | null;
  countryCode: string | null;
  preferences: ParticipantPreferences | null;
}

export type IneligibleReason =
  | 'self'
  | 'account_inactive'
  | 'profile_not_ready'
  | 'paused'
  | 'missing_preferences'
  | 'missing_birth_date'
  | 'invalid_residence'
  | 'gender_mismatch'
  | 'age_mismatch'
  | 'location_mismatch';

export interface EligibilityContext {
  now: Date;
  catalog: LocationCatalog;
}

interface Resolved {
  age: number;
  residence: Residence;
  preferences: ParticipantPreferences;
  genderIdentity: string;
}

/** Shared by both sides: active, ready, not paused, with valid preferences, age and US residence. */
function resolveParticipant(p: DiscoveryParticipant, ctx: EligibilityContext): Resolved | IneligibleReason {
  if (!canInteract(p.accountStatus)) return 'account_inactive';
  if (!p.profileReady) return 'profile_not_ready';
  if (p.discoverPaused) return 'paused';
  if (!p.preferences || p.preferences.acceptedGenderCategories.length === 0 || !p.genderIdentity) {
    return 'missing_preferences';
  }
  if (!p.birthDate) return 'missing_birth_date';
  const birth = new Date(`${p.birthDate}T00:00:00Z`);
  if (Number.isNaN(birth.getTime())) return 'missing_birth_date';
  const residence = resolveResidence(p, ctx.catalog);
  if (!residence) return 'invalid_residence';
  return {
    age: calculateAge(birth, ctx.now),
    residence,
    preferences: p.preferences,
    genderIdentity: p.genderIdentity,
  };
}

/** Item 1: can this person browse discovery at all? Null means yes. */
export function browseBlocker(viewer: DiscoveryParticipant, ctx: EligibilityContext): IneligibleReason | null {
  const resolved = resolveParticipant(viewer, ctx);
  return typeof resolved === 'string' ? resolved : null;
}

/** Items 1-5, in both directions. Null means the pair is mutually eligible. */
export function pairBlocker(
  viewer: DiscoveryParticipant,
  candidate: DiscoveryParticipant,
  ctx: EligibilityContext,
): IneligibleReason | null {
  if (viewer.userId === candidate.userId) return 'self';
  const v = resolveParticipant(viewer, ctx);
  if (typeof v === 'string') return v;
  const c = resolveParticipant(candidate, ctx);
  if (typeof c === 'string') return c;

  if (
    !v.preferences.acceptedGenderCategories.includes(c.genderIdentity) ||
    !c.preferences.acceptedGenderCategories.includes(v.genderIdentity)
  ) {
    return 'gender_mismatch';
  }

  if (!withinAgeRange(c.age, v.preferences) || !withinAgeRange(v.age, c.preferences)) return 'age_mismatch';

  // longDistance is deliberately not consulted: it never overrides a hard scope
  if (
    !locationsCompatible(
      { residence: v.residence, scope: v.preferences.locationScope },
      { residence: c.residence, scope: c.preferences.locationScope },
    )
  ) {
    return 'location_mismatch';
  }

  return null;
}

function withinAgeRange(age: number, prefs: ParticipantPreferences): boolean {
  return age >= prefs.minAge && age <= prefs.maxAge;
}
