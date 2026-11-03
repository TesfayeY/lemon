import { Router, type Request, type Response } from 'express';
import type { Db } from 'mongodb';
import type { Auth } from 'firebase-admin/auth';
import { v4 as uuidv4 } from 'uuid';
import { createAuthMiddleware, type AuthenticatedRequest } from '../auth/middleware.js';
import { canInteract, type UserDocument } from '../auth/account.js';
import { createEmptyProfile, normalizeWhitespace, MAX_PROMPT_ANSWERS, type ProfileDocument, type PromptAnswerDocument } from './schema.js';
import {
  validateDisplayName, validateGenderIdentity, validateIntention,
  validateCity, validateVisibility, validateBio, validatePromptAnswer,
  validatePromptId, validateHeight, validateOptionalText, validateLanguages, type FieldError,
} from './validation.js';
import { toSelfProfileDTO, toPublicProfileDTO } from './dto.js';
import { recomputeReadiness } from './readiness-service.js';
import { findCity } from '../catalogs/data.js';
import { isDuplicateKeyError } from '../../indexes.js';

export function createProfileRoutes(db: Db, auth: Auth) {
  const router = Router();
  const requireAuth = createAuthMiddleware(auth);
  const users = db.collection<UserDocument>('users');
  const profiles = db.collection<ProfileDocument>('profiles');
  const promptAnswers = db.collection<PromptAnswerDocument>('promptAnswers');

  /** Fetch own profile, creating an empty draft at revision 1 on first access */
  async function findOrCreateProfile(userId: string): Promise<ProfileDocument> {
    const existing = await profiles.findOne({ userId });
    if (existing) return existing;
    const profile = createEmptyProfile(userId);
    try {
      await profiles.insertOne(profile);
      return profile;
    } catch (err: unknown) {
      // Concurrent first access created it — use the stored profile
      if (!isDuplicateKeyError(err)) throw err;
      return (await profiles.findOne({ userId }))!;
    }
  }

  function sendRevisionConflict(req: Request, res: Response, currentRevision: number) {
    res.status(409).json({
      error: {
        code: 'REVISION_CONFLICT',
        message: 'Profile has been modified. Please refresh and try again.',
        currentRevision,
        retryable: true,
      },
      requestId: req.requestId,
    });
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

    const profile = await findOrCreateProfile(user._id);
    const body = req.body as Record<string, unknown>;

    // Every edit must name the revision it was based on (two-device safety)
    const expectedRevision = body['expectedRevision'];
    if (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision)) {
      res.status(422).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid fields',
          fieldErrors: [{ field: 'expectedRevision', message: 'Required integer revision' }],
          retryable: false,
        },
        requestId: req.requestId,
      });
      return;
    }
    if (expectedRevision !== profile.revision) {
      sendRevisionConflict(req, res, profile.revision);
      return;
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

    if (body['languages'] !== undefined) {
      const err = validateLanguages(body['languages']);
      if (err) errors.push(err);
      else updates['languages'] = [...new Set(body['languages'] as string[])];
    }

    // Simple string optional fields
    for (const field of ['hometown', 'occupation', 'education', 'religion']) {
      if (body[field] !== undefined) {
        const err = validateOptionalText(body[field], field);
        if (err) errors.push(err);
        else updates[field] = body[field] === null ? null : normalizeWhitespace(body[field] as string);
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

    // Compare-and-set on revision so concurrent edits cannot both win
    const result = await profiles.updateOne(
      { _id: profile._id, revision: expectedRevision },
      { $set: updates },
    );
    if (result.matchedCount === 0) {
      const current = await profiles.findOne({ _id: profile._id });
      sendRevisionConflict(req, res, current?.revision ?? profile.revision);
      return;
    }

    const eligibilityChanged = 'genderIdentity' in updates || 'cityId' in updates;
    await recomputeReadiness(db, user._id, { eligibilityChanged });

    res.json({
      data: { updated: Object.keys(updates).filter(k => k !== 'updatedAt' && k !== 'revision'), revision: updates['revision'] },
      meta: { requestId: req.requestId },
    });
  });

  /**
   * GET /v1/me/profile
   * Owner view: every own field, visibility settings and answers awaiting review.
   */
  router.get('/v1/me/profile', requireAuth, async (req: Request, res: Response) => {
    const { uid } = req as AuthenticatedRequest;
    const user = await users.findOne({ firebaseUid: uid });
    if (!user) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Account not found', retryable: false },
        requestId: req.requestId,
      });
      return;
    }

    const profile = await findOrCreateProfile(user._id);
    const answers = await promptAnswers.find({ ownerId: user._id }).toArray();

    res.json({
      data: toSelfProfileDTO(profile, user, answers),
      meta: { requestId: req.requestId },
    });
  });

  /**
   * GET /v1/me/profile/preview
   * Self preview with public projection semantics: exactly what others would
   * see, so hidden fields and unreviewed answers are absent.
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

    const profile = await findOrCreateProfile(user._id);
    const answers = await promptAnswers.find({ ownerId: user._id }).toArray();

    res.json({
      data: toPublicProfileDTO(profile, user, answers),
      meta: { requestId: req.requestId },
    });
  });

  /**
   * POST /v1/me/prompts
   * Add a prompt answer. At most MAX_PROMPT_ANSWERS, one per distinct prompt.
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

    const promptId = body['promptId'] as string;
    const sendDuplicate = () => res.status(409).json({
      error: { code: 'DUPLICATE_PROMPT', message: 'You already answered this prompt', retryable: false },
      requestId: req.requestId,
    });

    // Claim the first free slot. The unique (ownerId, slot) index makes the cap
    // atomic: a concurrent request that took the same slot makes this insert
    // fail, and the re-read decides between the next slot, a duplicate or the limit.
    // Each lost race means another answer landed, so MAX + 1 rounds always settle.
    let answer: PromptAnswerDocument | null = null;
    for (let round = 0; round <= MAX_PROMPT_ANSWERS && !answer; round++) {
      const owned = await promptAnswers.find({ ownerId: user._id }).toArray();
      if (owned.some(a => a.promptId === promptId)) {
        sendDuplicate();
        return;
      }
      // Answers saved before slots existed hold none until the startup migration
      // assigns one, so they still count toward the limit
      const used = new Set(owned.map(a => a.slot));
      const slot = owned.length >= MAX_PROMPT_ANSWERS
        ? undefined
        : Array.from({ length: MAX_PROMPT_ANSWERS }, (_, i) => i).find(i => !used.has(i));
      if (slot === undefined) {
        res.status(422).json({
          error: { code: 'PROMPT_LIMIT', message: `You can have at most ${MAX_PROMPT_ANSWERS} prompt answers`, retryable: false },
          requestId: req.requestId,
        });
        return;
      }

      // New answers wait for review; nothing is published until it is approved
      const candidate: PromptAnswerDocument = {
        _id: uuidv4(),
        ownerId: user._id,
        promptId,
        slot,
        approvedText: null,
        pendingText: normalizeWhitespace(body['text'] as string),
        state: 'pending',
        revision: 1,
        publishedRevision: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      try {
        await promptAnswers.insertOne(candidate);
        answer = candidate;
      } catch (err: unknown) {
        // Lost a race for this slot or this prompt; the next round re-reads
        if (!isDuplicateKeyError(err)) throw err;
      }
    }

    if (!answer) {
      // Only reachable if concurrent deletes keep freeing slots mid-race
      res.status(409).json({
        error: { code: 'CONCURRENT_EDIT', message: 'Your answers changed while saving. Please try again.', retryable: true },
        requestId: req.requestId,
      });
      return;
    }
    await recomputeReadiness(db, user._id);

    res.status(201).json({
      data: { id: answer._id, promptId: answer.promptId, state: answer.state, revision: answer.revision },
      meta: { requestId: req.requestId },
    });
  });

  /**
   * PATCH /v1/me/prompts/:id
   * Submit replacement text for review. Approved text stays published until
   * review accepts the replacement, so readiness is unaffected.
   */
  router.patch('/v1/me/prompts/:id', requireAuth, async (req: Request, res: Response) => {
    const { uid } = req as AuthenticatedRequest;
    const user = await users.findOne({ firebaseUid: uid });
    if (!user) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Account not found', retryable: false },
        requestId: req.requestId,
      });
      return;
    }

    const answerId = req.params['id'] as string;
    const answer = await promptAnswers.findOne({ _id: answerId, ownerId: user._id });
    if (!answer) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Prompt answer not found', retryable: false },
        requestId: req.requestId,
      });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const errors: FieldError[] = [];
    const expectedRevision = body['expectedRevision'];
    if (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision)) {
      errors.push({ field: 'expectedRevision', message: 'Required integer revision' });
    }
    const textErr = validatePromptAnswer(body['text']);
    if (textErr) errors.push(textErr);

    if (errors.length > 0) {
      res.status(422).json({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid fields', fieldErrors: errors, retryable: false },
        requestId: req.requestId,
      });
      return;
    }

    const revision = answer.revision + 1;
    // Compare-and-set on revision so concurrent edits cannot both win
    const result = await promptAnswers.updateOne(
      { _id: answer._id, ownerId: user._id, revision: expectedRevision as number },
      {
        $set: {
          pendingText: normalizeWhitespace(body['text'] as string),
          state: 'pending',
          revision,
          updatedAt: new Date(),
        },
      },
    );
    if (result.matchedCount === 0) {
      const current = await promptAnswers.findOne({ _id: answer._id });
      res.status(409).json({
        error: {
          code: 'REVISION_CONFLICT',
          message: 'This answer has been modified. Please refresh and try again.',
          currentRevision: current?.revision ?? answer.revision,
          retryable: true,
        },
        requestId: req.requestId,
      });
      return;
    }

    res.json({
      data: { id: answer._id, state: 'pending', revision },
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

    await recomputeReadiness(db, user._id);

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
    const { uid } = req as AuthenticatedRequest;
    const viewer = await users.findOne({ firebaseUid: uid });
    // Only active, ready accounts may view other profiles (R-AUTH-08).
    // Contextual eligibility (discovery/like/match) is added with Phase 07-09.
    if (!viewer || !canInteract(viewer.accountStatus) || !viewer.profileReady) {
      res.status(403).json({
        error: { code: 'ACCOUNT_NOT_ELIGIBLE', message: 'Complete your profile to view others', retryable: false },
        requestId: req.requestId,
      });
      return;
    }

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

    // Published text only; an answer with an edit awaiting review stays visible
    const answers = await promptAnswers.find({
      ownerId: targetUserId,
      approvedText: { $ne: null },
    }).toArray();

    const publicDTO = toPublicProfileDTO(profile, targetUser, answers);

    res.json({
      data: publicDTO,
      meta: { requestId: req.requestId },
    });
  });

  return router;
}
