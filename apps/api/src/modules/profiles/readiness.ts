/**
 * Server-computed profile readiness.
 *
 * A profile is ready when:
 * 1. Account is verified (emailVerified)
 * 2. Adult eligible (adultEligible)
 * 3. Terms accepted (agreements.termsVersion not null)
 * 4. Display name set
 * 5. Gender identity set
 * 6. City/state set
 * 7. Intention set
 * 8. At least 3 approved photos (checked via count)
 * 9. At least 3 approved prompt answers (checked via count)
 * 10. No active safety restriction
 */

import type { UserDocument } from '../auth/account.js';
import type { ProfileDocument } from './schema.js';

export interface ReadinessCheck {
  ready: boolean;
  missing: string[];
}

export function checkReadiness(
  user: UserDocument,
  profile: ProfileDocument,
  approvedPhotoCount: number,
  approvedAnswerCount: number,
): ReadinessCheck {
  const missing: string[] = [];

  if (!user.emailVerified) missing.push('emailVerified');
  if (!user.adultEligible) missing.push('adultEligible');
  if (!user.agreements.termsVersion) missing.push('termsAccepted');
  if (!profile.displayName) missing.push('displayName');
  if (!profile.genderIdentity) missing.push('genderIdentity');
  if (!profile.cityId) missing.push('location');
  if (!profile.intention) missing.push('intention');
  if (approvedPhotoCount < 3) missing.push('photos');
  if (approvedAnswerCount < 3) missing.push('promptAnswers');
  if (user.accountStatus === 'suspended') missing.push('accountSuspended');

  return {
    ready: missing.length === 0,
    missing,
  };
}
