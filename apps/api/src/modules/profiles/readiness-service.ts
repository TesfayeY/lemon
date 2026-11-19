import type { Db } from 'mongodb';
import type { UserDocument } from '../auth/account.js';
import { AccountStatus } from '../auth/account.js';
import type { PreferencesDocument } from '../preferences/schema.js';
import { createEmptyProfile, type ProfileDocument, type PromptAnswerDocument } from './schema.js';
import { checkReadiness, type ReadinessCheck } from './readiness.js';

/**
 * Evaluate readiness from current server state without persisting it.
 * A user who has not started their profile is checked against an empty draft,
 * so the missing list doubles as the resumable onboarding checklist.
 */
export async function evaluateReadiness(db: Db, user: UserDocument): Promise<ReadinessCheck> {
  const profile = await db.collection<ProfileDocument>('profiles').findOne({ userId: user._id });
  const prefs = await db.collection<PreferencesDocument>('preferences').findOne({ userId: user._id });
  // Only published text counts; an answer awaiting first review does not
  const approvedAnswers = await db.collection<PromptAnswerDocument>('promptAnswers').countDocuments({
    ownerId: user._id,
    approvedText: { $ne: null },
  });

  return checkReadiness(user, profile ?? createEmptyProfile(user._id), {
    interests: prefs?.acceptedGenderCategories.length ?? 0,
    approvedPhotos: await db.collection('photos').countDocuments({ ownerId: user._id, state: 'approved' }),
    approvedAnswers,
  });
}

/** Lost compare-and-set rounds before giving up; each loss means another guarded write landed */
export const MAX_READINESS_ATTEMPTS = 5;

/**
 * Recompute and persist profile readiness for a user.
 *
 * - Bumps guardVersion whenever readiness flips or an eligibility-affecting
 *   field changed, so stale discovery/like decisions can be detected later.
 * - The first time a profile becomes ready, an onboarding account becomes
 *   active. Activation is one-way; later readiness loss only clears profileReady.
 * - The write is a compare-and-set on the accountStatus and guardVersion it
 *   read. Evaluation takes several reads, and a staff suspension (or another
 *   recompute) can commit in between; a plain write would then put a suspended
 *   account back to active. On a lost race the user is re-read and
 *   re-evaluated, so only an account still in onboarding is ever activated and
 *   suspended, deleting or deleted accounts never are.
 */
export async function recomputeReadiness(
  db: Db,
  userId: string,
  options: { eligibilityChanged?: boolean } = {},
): Promise<boolean> {
  const users = db.collection<UserDocument>('users');

  for (let attempt = 0; attempt < MAX_READINESS_ATTEMPTS; attempt++) {
    const user = await users.findOne({ _id: userId });
    if (!user) return false;

    const { ready } = await evaluateReadiness(db, user);

    const set: Partial<UserDocument> = {};
    if (user.profileReady !== ready) set.profileReady = ready;
    if (ready && user.accountStatus === AccountStatus.ONBOARDING) set.accountStatus = AccountStatus.ACTIVE;

    const bumpGuard = options.eligibilityChanged || Object.keys(set).length > 0;
    if (!bumpGuard) return ready;

    const result = await users.updateOne(
      { _id: userId, accountStatus: user.accountStatus, guardVersion: user.guardVersion },
      { $set: { ...set, updatedAt: new Date() }, $inc: { guardVersion: 1 } },
    );
    if (result.matchedCount > 0) return ready;
    // The account changed after it was read: evaluate again from fresh state
  }

  throw new Error(`Readiness recompute lost ${MAX_READINESS_ATTEMPTS} compare-and-set rounds in a row`);
}
