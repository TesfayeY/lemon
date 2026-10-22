import { Router, type Request, type Response } from 'express';
import type { Db } from 'mongodb';
import type { Auth } from 'firebase-admin/auth';
import { v4 as uuidv4 } from 'uuid';
import { createAuthMiddleware, type AuthenticatedRequest } from './middleware.js';
import { createNewUser, canAuthenticate, type UserDocument } from './account.js';
import { parseBirthDate, isAdultEligible } from './adult-gate.js';

export function createAuthRoutes(db: Db, auth: Auth) {
  const router = Router();
  const requireAuth = createAuthMiddleware(auth);
  const users = db.collection<UserDocument>('users');

  /**
   * POST /v1/me/bootstrap
   * Idempotently maps a Firebase identity to an app account.
   * Never trusts a UID from the request body — uses the verified token.
   */
  router.post('/v1/me/bootstrap', requireAuth, async (req: Request, res: Response) => {
    const { uid } = req as AuthenticatedRequest;

    // Check if user already exists
    const existing = await users.findOne({ firebaseUid: uid });
    if (existing) {
      if (!canAuthenticate(existing.accountStatus)) {
        res.status(403).json({
          error: {
            code: 'ACCOUNT_RESTRICTED',
            message: 'This account is not available',
            retryable: false,
          },
          requestId: req.requestId,
        });
        return;
      }

      res.status(200).json({
        data: {
          userId: existing._id,
          accountStatus: existing.accountStatus,
          profileReady: existing.profileReady,
          adultEligible: existing.adultEligible,
        },
        meta: { requestId: req.requestId },
      });
      return;
    }

    // Create new user — unique firebaseUid index prevents duplicates
    const newUser = createNewUser(uuidv4(), uid);
    try {
      await users.insertOne(newUser);
    } catch (err: unknown) {
      if ((err as { code?: number }).code === 11000) {
        // Duplicate key — concurrent bootstrap, fetch and return existing
        const raced = await users.findOne({ firebaseUid: uid });
        if (raced) {
          res.status(200).json({
            data: {
              userId: raced._id,
              accountStatus: raced.accountStatus,
              profileReady: raced.profileReady,
              adultEligible: raced.adultEligible,
            },
            meta: { requestId: req.requestId },
          });
          return;
        }
      }
      throw err;
    }

    res.status(201).json({
      data: {
        userId: newUser._id,
        accountStatus: newUser.accountStatus,
        profileReady: newUser.profileReady,
        adultEligible: newUser.adultEligible,
      },
      meta: { requestId: req.requestId },
    });
  });

  /**
   * GET /v1/me
   * Private own-account snapshot including readiness and next onboarding step.
   */
  router.get('/v1/me', requireAuth, async (req: Request, res: Response) => {
    const { uid } = req as AuthenticatedRequest;
    const user = await users.findOne({ firebaseUid: uid });

    if (!user || !canAuthenticate(user.accountStatus)) {
      res.status(403).json({
        error: {
          code: 'ACCOUNT_RESTRICTED',
          message: 'This account is not available',
          retryable: false,
        },
        requestId: req.requestId,
      });
      return;
    }

    res.json({
      data: {
        userId: user._id,
        accountStatus: user.accountStatus,
        emailVerified: user.emailVerified,
        birthDate: user.birthDate,
        adultEligible: user.adultEligible,
        profileReady: user.profileReady,
        discoverPaused: user.discoverPaused,
        agreements: user.agreements,
      },
      meta: { requestId: req.requestId },
    });
  });

  /**
   * PATCH /v1/me/onboarding
   * Validates and saves one onboarding step at a time.
   * Currently supports: birthDate
   */
  router.patch('/v1/me/onboarding', requireAuth, async (req: Request, res: Response) => {
    const { uid } = req as AuthenticatedRequest;
    const user = await users.findOne({ firebaseUid: uid });

    if (!user) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Account not found', retryable: false },
        requestId: req.requestId,
      });
      return;
    }

    if (user.accountStatus !== 'onboarding') {
      res.status(409).json({
        error: { code: 'INVALID_STATE', message: 'Not in onboarding', retryable: false },
        requestId: req.requestId,
      });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const updates: Record<string, unknown> = {};

    // Handle birthDate step
    if (body['birthDate'] !== undefined) {
      if (typeof body['birthDate'] !== 'string') {
        res.status(422).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid birth date',
            fieldErrors: [{ field: 'birthDate', message: 'Must be a string in YYYY-MM-DD format' }],
            retryable: false,
          },
          requestId: req.requestId,
        });
        return;
      }

      const result = parseBirthDate(body['birthDate']);
      if (!result.valid) {
        res.status(422).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: result.reason,
            fieldErrors: [{ field: 'birthDate', message: result.reason }],
            retryable: false,
          },
          requestId: req.requestId,
        });
        return;
      }

      const eligible = isAdultEligible(result.date);
      if (!eligible) {
        res.status(422).json({
          error: {
            code: 'AGE_INELIGIBLE',
            message: 'You must be at least 18 years old to use Lemon',
            retryable: false,
          },
          requestId: req.requestId,
        });
        return;
      }

      updates['birthDate'] = body['birthDate'];
      updates['adultEligible'] = true;
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({
        error: { code: 'NO_UPDATES', message: 'No valid fields provided', retryable: false },
        requestId: req.requestId,
      });
      return;
    }

    updates['updatedAt'] = new Date();

    await users.updateOne({ _id: user._id }, { $set: updates });

    res.json({
      data: { updated: Object.keys(updates).filter(k => k !== 'updatedAt') },
      meta: { requestId: req.requestId },
    });
  });

  return router;
}
