/**
 * Server-computed profile readiness.
 *
 * A profile is ready when:
 * 1. Account is verified (emailVerified)
 * 2. Adult eligible (adultEligible)
 * 3. Terms accepted (agreements.termsVersion not null)
 * 4. Display name set
 * 5. Gender identity set
 * 6. At least one "interested in meeting" category (preferences)
 * 7. City/state set
 * 8. Intention set
 * 9. At least 3 approved photos (checked via count)
 * 10. At least 3 approved prompt answers (checked via count)
 * 11. No active safety restriction
 */

import type { UserDocument } from '../auth/account.js';
import type { ProfileDocument } from './schema.js';

export interface ReadinessCheck {
  ready: boolean;
  missing: string[];
}

export interface ReadinessCounts {
  interests: number;
  approvedPhotos: number;
  approvedAnswers: number;
}

export function checkReadiness(
  user: UserDocument,
  profile: ProfileDocument,
  counts: ReadinessCounts,
): ReadinessCheck {
  const missing: string[] = [];

  if (!user.emailVerified) missing.push('emailVerified');
  if (!user.adultEligible) missing.push('adultEligible');
  if (!user.agreements.termsVersion) missing.push('termsAccepted');
  if (!profile.displayName) missing.push('displayName');
  if (!profile.genderIdentity) missing.push('genderIdentity');
  if (counts.interests < 1) missing.push('interests');
  if (!profile.cityId) missing.push('location');
  if (!profile.intention) missing.push('intention');
  if (counts.approvedPhotos < 3) missing.push('photos');
  if (counts.approvedAnswers < 3) missing.push('promptAnswers');
  if (user.accountStatus === 'suspended') missing.push('accountSuspended');

  return {
    ready: missing.length === 0,
    missing,
  };
}
