import type { Db } from 'mongodb';
import type { UserDocument } from '../auth/account.js';
import { AccountStatus } from '../auth/account.js';
import type { PreferencesDocument } from '../preferences/schema.js';
import type { ProfileDocument, PromptAnswerDocument } from './schema.js';
import { checkReadiness } from './readiness.js';

/**
 * Recompute and persist profile readiness for a user.
 *
 * - Bumps guardVersion whenever readiness flips or an eligibility-affecting
 *   field changed, so stale discovery/like decisions can be detected later.
 * - The first time a profile becomes ready, an onboarding account becomes
 *   active. Activation is one-way; later readiness loss only clears profileReady.
 */
export async function recomputeReadiness(
  db: Db,
  userId: string,
  options: { eligibilityChanged?: boolean } = {},
): Promise<boolean> {
  const users = db.collection<UserDocument>('users');
  const user = await users.findOne({ _id: userId });
  const profile = await db.collection<ProfileDocument>('profiles').findOne({ userId });
  if (!user || !profile) return false;

  const prefs = await db.collection<PreferencesDocument>('preferences').findOne({ userId });
  const approvedAnswers = await db.collection<PromptAnswerDocument>('promptAnswers').countDocuments({
    ownerId: userId,
    state: 'approved',
  });

  const { ready } = checkReadiness(user, profile, {
    interests: prefs?.acceptedGenderCategories.length ?? 0,
    approvedPhotos: 0, // Photos not yet implemented — Phase 05
    approvedAnswers,
  });

  const set: Partial<UserDocument> = {};
  if (user.profileReady !== ready) set.profileReady = ready;
  if (ready && user.accountStatus === AccountStatus.ONBOARDING) set.accountStatus = AccountStatus.ACTIVE;

  const bumpGuard = options.eligibilityChanged || Object.keys(set).length > 0;
  if (bumpGuard) {
    await users.updateOne(
      { _id: userId },
      { $set: { ...set, updatedAt: new Date() }, $inc: { guardVersion: 1 } },
    );
  }
  return ready;
}
