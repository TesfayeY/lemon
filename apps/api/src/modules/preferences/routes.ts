import { Router, type Request, type Response } from 'express';
import type { Db } from 'mongodb';
import type { Auth } from 'firebase-admin/auth';
import { createAuthMiddleware, type AuthenticatedRequest } from '../auth/middleware.js';
import type { UserDocument } from '../auth/account.js';
import { createDefaultPreferences, type PreferencesDocument, type LocationScope } from './schema.js';
import { isValidGenderId } from '../catalogs/data.js';
import { isDuplicateKeyError } from '../../indexes.js';

const VALID_SCOPES: LocationScope[] = ['city', 'state', 'nationwide'];

export function createPreferencesRoutes(db: Db, auth: Auth) {
  const router = Router();
  const requireAuth = createAuthMiddleware(auth);
  const users = db.collection<UserDocument>('users');
  const preferences = db.collection<PreferencesDocument>('preferences');

  /** Fetch preferences, creating defaults on first access (race-safe via unique userId index) */
  async function findOrCreatePreferences(userId: string): Promise<PreferencesDocument> {
    const existing = await preferences.findOne({ userId });
    if (existing) return existing;
    const prefs = createDefaultPreferences(userId);
    try {
      await preferences.insertOne(prefs);
      return prefs;
    } catch (err: unknown) {
      if (!isDuplicateKeyError(err)) throw err;
      return (await preferences.findOne({ userId }))!;
    }
  }

  /** GET /v1/me/preferences */
  router.get('/v1/me/preferences', requireAuth, async (req: Request, res: Response) => {
    const { uid } = req as AuthenticatedRequest;
    const user = await users.findOne({ firebaseUid: uid });
    if (!user) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Account not found', retryable: false },
        requestId: req.requestId,
      });
      return;
    }

    const prefs = await findOrCreatePreferences(user._id);

    res.json({
      data: {
        acceptedGenderCategories: prefs.acceptedGenderCategories,
        minAge: prefs.minAge,
        maxAge: prefs.maxAge,
        locationScope: prefs.locationScope,
        longDistance: prefs.longDistance,
        revision: prefs.revision,
      },
      meta: { requestId: req.requestId },
    });
  });

  /** PATCH /v1/me/preferences */
  router.patch('/v1/me/preferences', requireAuth, async (req: Request, res: Response) => {
    const { uid } = req as AuthenticatedRequest;
    const user = await users.findOne({ firebaseUid: uid });
    if (!user) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Account not found', retryable: false },
        requestId: req.requestId,
      });
      return;
    }

    const prefs = await findOrCreatePreferences(user._id);

    const body = req.body as Record<string, unknown>;
    const updates: Record<string, unknown> = {};
    const errors: { field: string; message: string }[] = [];

    if (body['acceptedGenderCategories'] !== undefined) {
      if (!Array.isArray(body['acceptedGenderCategories'])) {
        errors.push({ field: 'acceptedGenderCategories', message: 'Must be an array' });
      } else {
        const ids = body['acceptedGenderCategories'] as string[];
        if (ids.length === 0) {
          errors.push({ field: 'acceptedGenderCategories', message: 'Select at least one' });
        } else if (!ids.every(id => typeof id === 'string' && isValidGenderId(id))) {
          errors.push({ field: 'acceptedGenderCategories', message: 'Contains unknown gender category' });
        } else {
          updates['acceptedGenderCategories'] = [...new Set(ids)]; // dedupe
        }
      }
    }

    if (body['minAge'] !== undefined) {
      if (typeof body['minAge'] !== 'number' || !Number.isInteger(body['minAge'])) {
        errors.push({ field: 'minAge', message: 'Must be an integer' });
      } else if ((body['minAge'] as number) < 18) {
        errors.push({ field: 'minAge', message: 'Minimum age is 18' });
      } else {
        updates['minAge'] = body['minAge'];
      }
    }

    if (body['maxAge'] !== undefined) {
      if (typeof body['maxAge'] !== 'number' || !Number.isInteger(body['maxAge'])) {
        errors.push({ field: 'maxAge', message: 'Must be an integer' });
      } else if ((body['maxAge'] as number) < 18) {
        errors.push({ field: 'maxAge', message: 'Maximum age must be at least 18' });
      } else {
        updates['maxAge'] = body['maxAge'];
      }
    }

    // Cross-field: min <= max
    const effectiveMin = (updates['minAge'] as number | undefined) ?? prefs.minAge;
    const effectiveMax = (updates['maxAge'] as number | undefined) ?? prefs.maxAge;
    if (effectiveMin > effectiveMax) {
      errors.push({ field: 'minAge', message: 'Minimum age cannot exceed maximum age' });
    }

    if (body['locationScope'] !== undefined) {
      if (!VALID_SCOPES.includes(body['locationScope'] as LocationScope)) {
        errors.push({ field: 'locationScope', message: 'Must be "city", "state", or "nationwide"' });
      } else {
        updates['locationScope'] = body['locationScope'];
      }
    }

    if (body['longDistance'] !== undefined) {
      if (typeof body['longDistance'] !== 'boolean') {
        errors.push({ field: 'longDistance', message: 'Must be a boolean' });
      } else {
        updates['longDistance'] = body['longDistance'];
      }
    }

    if (errors.length > 0) {
      res.status(422).json({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid fields', fieldErrors: errors, retryable: false },
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
    updates['revision'] = prefs.revision + 1;

    await preferences.updateOne({ _id: prefs._id }, { $set: updates });

    res.json({
      data: { updated: Object.keys(updates).filter(k => k !== 'updatedAt' && k !== 'revision'), revision: updates['revision'] },
      meta: { requestId: req.requestId },
    });
  });

  return router;
}
