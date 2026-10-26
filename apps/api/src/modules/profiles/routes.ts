import { Router, type Request, type Response } from 'express';
import type { Db } from 'mongodb';
import type { Auth } from 'firebase-admin/auth';
import { v4 as uuidv4 } from 'uuid';
import { createAuthMiddleware, type AuthenticatedRequest } from '../auth/middleware.js';
import type { UserDocument } from '../auth/account.js';
import { createEmptyProfile, normalizeWhitespace, type ProfileDocument, type PromptAnswerDocument } from './schema.js';
import {
  validateDisplayName, validateGenderIdentity, validateIntention,
  validateCity, validateVisibility, validateBio, validatePromptAnswer,
  validatePromptId, validateHeight, type FieldError,
} from './validation.js';
import { toSelfProfileDTO, toPublicProfileDTO } from './dto.js';
import { checkReadiness } from './readiness.js';
import { findCity } from '../catalogs/data.js';
import { isDuplicateKeyError } from '../../indexes.js';

export function createProfileRoutes(db: Db, auth: Auth) {
  const router = Router();
  const requireAuth = createAuthMiddleware(auth);
  const users = db.collection<UserDocument>('users');
  const profiles = db.collection<ProfileDocument>('profiles');
  const promptAnswers = db.collection<PromptAnswerDocument>('promptAnswers');

  /** Helper to recompute and persist readiness */
  async function updateReadiness(userId: string): Promise<boolean> {
    const user = await users.findOne({ _id: userId });
    const profile = await profiles.findOne({ userId });
    if (!user || !profile) return false;

    const photoCount = 0; // Photos not yet implemented — Phase 05
    const answerCount = await promptAnswers.countDocuments({
      ownerId: userId,
      state: 'approved',
    });

    const { ready } = checkReadiness(user, profile, photoCount, answerCount);

    if (user.profileReady !== ready) {
      await users.updateOne(
        { _id: userId },
        { $set: { profileReady: ready, updatedAt: new Date() } },
      );
    }
    return ready;
  }

  /**
   * PATCH /v1/me/profile
   * Update own profile fields. Uses expected revision for conflict detection.
   */
  router.patch('/v1/me/profile', requireAuth, async (req: Request, res: Response) => {
    const { uid } = req as AuthenticatedRequest;
    const user = await users.findOne({ firebaseUid: uid });
    if (!user) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Account not found', retryable: false },
        requestId: req.requestId,
      });
      return;
    }

    let profile = await profiles.findOne({ userId: user._id });
    if (!profile) {
      // Auto-create empty profile on first edit
      profile = createEmptyProfile(user._id);
      try {
        await profiles.insertOne(profile);
      } catch (err: unknown) {
        // Concurrent first edit created it — use the stored profile
        if (!isDuplicateKeyError(err)) throw err;
        profile = (await profiles.findOne({ userId: user._id }))!;
      }
    }

    const body = req.body as Record<string, unknown>;

    // Check revision for conflict detection
    if (body['expectedRevision'] !== undefined) {
      if (body['expectedRevision'] !== profile.revision) {
        res.status(409).json({
          error: {
            code: 'REVISION_CONFLICT',
            message: 'Profile has been modified. Please refresh and try again.',
            retryable: true,
          },
          requestId: req.requestId,
        });
        return;
      }
    }

    const updates: Record<string, unknown> = {};
    const errors: FieldError[] = [];

    // Validate and collect field updates
    if (body['displayName'] !== undefined) {
      const err = validateDisplayName(body['displayName']);
      if (err) errors.push(err);
      else updates['displayName'] = normalizeWhitespace(body['displayName'] as string);
    }

    if (body['genderIdentity'] !== undefined) {
      const err = validateGenderIdentity(body['genderIdentity']);
      if (err) errors.push(err);
      else updates['genderIdentity'] = body['genderIdentity'];
    }

    if (body['genderDisplay'] !== undefined) {
      const err = validateVisibility(body['genderDisplay'], 'genderDisplay');
      if (err) errors.push(err);
      else updates['genderDisplay'] = body['genderDisplay'];
    }

    if (body['cityId'] !== undefined) {
      const err = validateCity(body['cityId']);
      if (err) errors.push(err);
      else {
        const city = findCity(body['cityId'] as string)!;
        updates['cityId'] = city.id;
        updates['stateCode'] = city.stateCode;
      }
    }

    if (body['intention'] !== undefined) {
      const err = validateIntention(body['intention']);
      if (err) errors.push(err);
      else updates['intention'] = body['intention'];
    }

    if (body['bio'] !== undefined) {
      const err = validateBio(body['bio']);
      if (err) errors.push(err);
      else updates['bio'] = body['bio'] === null ? null : normalizeWhitespace(body['bio'] as string);
    }

    if (body['height'] !== undefined) {
      const err = validateHeight(body['height']);
      if (err) errors.push(err);
      else updates['height'] = body['height'];
    }

    // Visibility toggles for optional fields
    for (const field of ['hometownDisplay', 'occupationDisplay', 'educationDisplay', 'heightDisplay', 'languagesDisplay', 'religionDisplay']) {
      if (body[field] !== undefined) {
        const err = validateVisibility(body[field], field);
        if (err) errors.push(err);
        else updates[field] = body[field];
      }
    }

    // Simple string optional fields
    for (const field of ['hometown', 'occupation', 'education', 'religion']) {
      if (body[field] !== undefined) {
        if (body[field] !== null && typeof body[field] !== 'string') {
          errors.push({ field, message: 'Must be a string or null' });
        } else {
          updates[field] = body[field] === null ? null : normalizeWhitespace(body[field] as string);
        }
      }
    }

    if (errors.length > 0) {
      res.status(422).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid fields',
          fieldErrors: errors,
          retryable: false,
        },
        requestId: req.requestId,
      });
      return;
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({
        error: { code: 'NO_UPDATES', message: 'No valid fields provided', retryable: false },
        requestId: req.requestId,
      });
      return;
    }

    updates['updatedAt'] = new Date();
    updates['revision'] = profile.revision + 1;

    await profiles.updateOne({ _id: profile._id }, { $set: updates });
    await updateReadiness(user._id);

    res.json({
      data: { updated: Object.keys(updates).filter(k => k !== 'updatedAt' && k !== 'revision'), revision: updates['revision'] },
      meta: { requestId: req.requestId },
    });
  });

  /**
   * GET /v1/me/profile/preview
   * Self preview with public projection semantics.
   */
  router.get('/v1/me/profile/preview', requireAuth, async (req: Request, res: Response) => {
    const { uid } = req as AuthenticatedRequest;
    const user = await users.findOne({ firebaseUid: uid });
    if (!user) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Account not found', retryable: false },
        requestId: req.requestId,
      });
      return;
    }

    const profile = await profiles.findOne({ userId: user._id });
    if (!profile) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Profile not found', retryable: false },
        requestId: req.requestId,
      });
      return;
    }

    const answers = await promptAnswers.find({ ownerId: user._id }).toArray();
    const selfDTO = toSelfProfileDTO(profile, user, answers);

    res.json({
      data: selfDTO,
      meta: { requestId: req.requestId },
    });
  });

  /**
   * POST /v1/me/prompts
   * Add a prompt answer. Max 3 distinct prompts.
   */
  router.post('/v1/me/prompts', requireAuth, async (req: Request, res: Response) => {
    const { uid } = req as AuthenticatedRequest;
    const user = await users.findOne({ firebaseUid: uid });
    if (!user) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Account not found', retryable: false },
        requestId: req.requestId,
      });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const errors: FieldError[] = [];

    const promptErr = validatePromptId(body['promptId']);
    if (promptErr) errors.push(promptErr);

    const textErr = validatePromptAnswer(body['text']);
    if (textErr) errors.push(textErr);

    if (errors.length > 0) {
      res.status(422).json({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid fields', fieldErrors: errors, retryable: false },
        requestId: req.requestId,
      });
      return;
    }

    // Check for duplicate prompt
    const existing = await promptAnswers.findOne({
      ownerId: user._id,
      promptId: body['promptId'] as string,
    });
    if (existing) {
      res.status(409).json({
        error: { code: 'DUPLICATE_PROMPT', message: 'You already answered this prompt', retryable: false },
        requestId: req.requestId,
      });
      return;
    }

    // Max 3 prompts
    const count = await promptAnswers.countDocuments({ ownerId: user._id });
    if (count >= 3) {
      res.status(422).json({
        error: { code: 'PROMPT_LIMIT', message: 'You can have at most 3 prompt answers', retryable: false },
        requestId: req.requestId,
      });
      return;
    }

    const answer: PromptAnswerDocument = {
      _id: uuidv4(),
      ownerId: user._id,
      promptId: body['promptId'] as string,
      text: normalizeWhitespace(body['text'] as string),
      state: 'approved', // Auto-approve for dev; manual review in Phase 13
      publishedRevision: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await promptAnswers.insertOne(answer);
    await updateReadiness(user._id);

    res.status(201).json({
      data: { id: answer._id, promptId: answer.promptId, state: answer.state },
      meta: { requestId: req.requestId },
    });
  });

  /**
   * DELETE /v1/me/prompts/:id
   * Remove a prompt answer. Recomputes readiness.
   */
  router.delete('/v1/me/prompts/:id', requireAuth, async (req: Request, res: Response) => {
    const { uid } = req as AuthenticatedRequest;
    const user = await users.findOne({ firebaseUid: uid });
    if (!user) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Account not found', retryable: false },
        requestId: req.requestId,
      });
      return;
    }

    const result = await promptAnswers.deleteOne({
      _id: req.params['id'],
      ownerId: user._id,
    });

    if (result.deletedCount === 0) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Prompt answer not found', retryable: false },
        requestId: req.requestId,
      });
      return;
    }

    await updateReadiness(user._id);

    res.json({
      data: { deleted: true },
      meta: { requestId: req.requestId },
    });
  });

  /**
   * GET /v1/profiles/:id
   * Public profile view — eligible contextual access only.
   * No global searchable directory.
   */
  router.get('/v1/profiles/:id', requireAuth, async (req: Request, res: Response) => {
    const targetUserId = req.params['id'];

    const targetUser = await users.findOne({ _id: targetUserId });
    if (!targetUser || targetUser.accountStatus !== 'active' || !targetUser.profileReady) {
      res.status(404).json({
        error: { code: 'PROFILE_UNAVAILABLE', message: 'This profile is not available', retryable: false },
        requestId: req.requestId,
      });
      return;
    }

    const profile = await profiles.findOne({ userId: targetUserId });
    if (!profile) {
      res.status(404).json({
        error: { code: 'PROFILE_UNAVAILABLE', message: 'This profile is not available', retryable: false },
        requestId: req.requestId,
      });
      return;
    }

    const answers = await promptAnswers.find({
      ownerId: targetUserId,
      state: 'approved',
    }).toArray();

    const publicDTO = toPublicProfileDTO(profile, targetUser, answers);

    res.json({
      data: publicDTO,
      meta: { requestId: req.requestId },
    });
  });

  return router;
}
