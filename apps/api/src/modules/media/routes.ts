import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Router, type Request, type Response } from 'express';
import type { Db } from 'mongodb';
import type { Auth } from 'firebase-admin/auth';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import type { Env } from '../../config.js';
import { LocalMediaStorage } from '../../adapters/media/local.js';
import type { MediaStorage } from '../../adapters/media/storage.js';
import { isDuplicateKeyError } from '../../indexes.js';
import { createAuthMiddleware, type AuthenticatedRequest } from '../auth/middleware.js';
import { canAuthenticate, canInteract, type UserDocument } from '../auth/account.js';
import { recomputeReadiness } from '../profiles/readiness-service.js';
import { toOwnerPhotoDTO } from './dto.js';
import { bumpPhotoSetRevision, findOrCreatePhotoSet, purgePhotoObjects } from './photo-set.js';
import { MASTER_CONTENT_TYPE, MediaValidationError, processImage, VARIANT_CONTENT_TYPE, type ProcessedImage } from './processing.js';
import {
  ACTIVE_PHOTO_STATES, MAX_PHOTOS, MIN_PHOTOS, OWNER_VISIBLE_PHOTO_STATES, PHOTO_VARIANTS, PhotoState,
  photoObjectKeys, type PhotoDocument, type PhotoSetDocument, type PhotoVariant,
} from './schema.js';

export type MediaRoutesConfig = Pick<Env, 'MEDIA_MAX_BYTES' | 'MEDIA_LOCAL_DIR'>;

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
/** Each failed attempt means another upload or reorder committed, so this bounds contention. */
const MAX_RESERVE_ATTEMPTS = 8;

type Reservation =
  | { kind: 'reserved'; photo: PhotoDocument; revision: number }
  | { kind: 'duplicate'; photo: PhotoDocument }
  | { kind: 'limit' }
  | { kind: 'busy' };

export function createMediaRoutes(
  db: Db,
  auth: Auth,
  config: MediaRoutesConfig,
  storage: MediaStorage = new LocalMediaStorage(config.MEDIA_LOCAL_DIR),
) {
  const router = Router();
  const requireAuth = createAuthMiddleware(auth);
  const users = db.collection<UserDocument>('users');
  const photos = db.collection<PhotoDocument>('photos');
  const photoSets = db.collection<PhotoSetDocument>('photoSets');

  // Bounded in-memory parse: busboy stops reading at fileSize and multer drains the rest
  const parseMultipart = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.MEDIA_MAX_BYTES, files: 1, fields: 0, parts: 1 },
  }).single('photo');

  function sendError(
    req: Request,
    res: Response,
    status: number,
    code: string,
    message: string,
    extra: Record<string, unknown> = {},
    retryable = false,
  ) {
    res.status(status).json({ error: { code, message, ...extra, retryable }, requestId: req.requestId });
  }

  /** Resolve the caller's account, or respond and return null. */
  async function loadAccount(req: Request, res: Response): Promise<UserDocument | null> {
    const { uid } = req as AuthenticatedRequest;
    const user = await users.findOne({ firebaseUid: uid });
    if (!user) {
      sendError(req, res, 404, 'NOT_FOUND', 'Account not found');
      return null;
    }
    if (!canAuthenticate(user.accountStatus)) {
      sendError(req, res, 403, 'ACCOUNT_RESTRICTED', 'This account is not available');
      return null;
    }
    return user;
  }

  /** Parse the single `photo` file part, or respond and return null. */
  function readUpload(req: Request, res: Response): Promise<Express.Multer.File | null> {
    return new Promise((resolve) => {
      parseMultipart(req, res, (err: unknown) => {
        if (err) {
          const code = err instanceof multer.MulterError ? err.code : null;
          if (code === 'LIMIT_FILE_SIZE') {
            sendError(req, res, 413, 'PAYLOAD_TOO_LARGE', 'This photo is too large to upload. Please choose a smaller one.', {
              maxBytes: config.MEDIA_MAX_BYTES,
            });
          } else {
            sendError(req, res, 400, 'INVALID_MULTIPART', 'Send exactly one photo as multipart/form-data in a field named "photo".');
          }
          resolve(null);
          return;
        }
        if (!req.file) {
          sendError(req, res, 400, 'FILE_REQUIRED', 'Send the photo as multipart/form-data in a field named "photo".');
          resolve(null);
          return;
        }
        resolve(req.file);
      });
    });
  }

  function activePhotos(ownerId: string) {
    return photos.find({ ownerId, state: { $in: ACTIVE_PHOTO_STATES } }).toArray();
  }

  /**
   * Claim a slot for a new photo. The photo is inserted (as `processing`) before
   * the compare-and-set on the set revision: of any uploads that counted the same
   * revision, only one commits and the rest roll back and recount, so the
   * MAX_PHOTOS limit holds under concurrency without a transaction.
   */
  async function reservePhoto(
    ownerId: string,
    idempotencyKey: string,
    requestHash: string,
    image: ProcessedImage,
  ): Promise<Reservation> {
    const assetId = uuidv4();
    for (let attempt = 0; attempt < MAX_RESERVE_ATTEMPTS; attempt++) {
      const set = await findOrCreatePhotoSet(db, ownerId);
      const active = await activePhotos(ownerId);
      if (active.length >= MAX_PHOTOS) return { kind: 'limit' };

      const now = new Date();
      const photo: PhotoDocument = {
        _id: assetId,
        ownerId,
        state: PhotoState.PROCESSING,
        ...photoObjectKeys(ownerId, assetId),
        width: image.width,
        height: image.height,
        order: active.reduce((next, p) => Math.max(next, p.order + 1), 0),
        contentVersion: 1,
        moderationReason: null,
        idempotencyKey,
        requestHash,
        reviewedAt: null,
        deletedAt: null,
        objectsPurgedAt: null,
        createdAt: now,
        updatedAt: now,
      };

      try {
        await photos.insertOne(photo);
      } catch (err: unknown) {
        // Concurrent retry with the same Idempotency-Key won the unique index
        if (!isDuplicateKeyError(err)) throw err;
        const existing = await photos.findOne({ ownerId, idempotencyKey });
        if (existing) return { kind: 'duplicate', photo: existing };
        continue;
      }

      const cas = await photoSets.updateOne(
        { _id: ownerId, revision: set.revision },
        { $set: { revision: set.revision + 1, updatedAt: now } },
      );
      if (cas.matchedCount === 1) return { kind: 'reserved', photo, revision: set.revision + 1 };

      await photos.deleteOne({ _id: assetId, state: PhotoState.PROCESSING });
    }
    return { kind: 'busy' };
  }

  /** Compensate a reserved upload: release the slot, free the key, remove objects. */
  async function failUpload(photo: PhotoDocument): Promise<void> {
    const now = new Date();
    const result = await photos.updateOne(
      { _id: photo._id, state: PhotoState.PROCESSING },
      { $set: { state: PhotoState.FAILED, updatedAt: now }, $unset: { idempotencyKey: '' } },
    );
    if (result.matchedCount === 1) await bumpPhotoSetRevision(db, photo.ownerId);
    const current = await photos.findOne({ _id: photo._id });
    if (current) await purgePhotoObjects(db, storage, current);
  }

  /** Same Idempotency-Key seen again: return the original result, never a second photo. */
  async function replayUpload(req: Request, res: Response, existing: PhotoDocument, requestHash: string) {
    if (existing.requestHash !== requestHash) {
      sendError(req, res, 409, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different photo.');
      return;
    }
    if (existing.state === PhotoState.PROCESSING) {
      sendError(req, res, 409, 'UPLOAD_IN_PROGRESS', 'This photo is still uploading. Please try again shortly.', {}, true);
      return;
    }
    if (existing.state === PhotoState.DELETED) {
      sendError(req, res, 409, 'IDEMPOTENCY_KEY_REUSED', 'This upload already finished and the photo was removed.');
      return;
    }
    const set = await findOrCreatePhotoSet(db, existing.ownerId);
    res.status(200).json({
      data: { id: existing._id, state: existing.state, order: existing.order, revision: set.revision },
      meta: { requestId: req.requestId },
    });
  }

  function sendPhotoLimit(req: Request, res: Response) {
    sendError(req, res, 422, 'PHOTO_LIMIT_REACHED', `You can have up to ${MAX_PHOTOS} photos. Remove one to add another.`, {
      maxPhotos: MAX_PHOTOS,
    });
  }

  function sendRevisionConflict(req: Request, res: Response, currentRevision: number) {
    sendError(req, res, 409, 'REVISION_CONFLICT', 'Your photos have changed. Please refresh and try again.', { currentRevision }, true);
  }

  /**
   * POST /v1/me/photos
   * Upload one photo into private quarantine for review.
   */
  router.post('/v1/me/photos', requireAuth, async (req: Request, res: Response) => {
    const user = await loadAccount(req, res);
    if (!user) return;

    const idempotencyKey = req.get('Idempotency-Key');
    if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      sendError(req, res, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'An Idempotency-Key header (8-128 letters, digits, "-" or "_") is required.');
      return;
    }

    const file = await readUpload(req, res);
    if (!file) return;
    const requestHash = createHash('sha256').update(file.buffer).digest('hex');

    const existing = await photos.findOne({ ownerId: user._id, idempotencyKey });
    if (existing) {
      await replayUpload(req, res, existing, requestHash);
      return;
    }

    // Cheap check before decoding; reservePhoto enforces the limit atomically
    if ((await activePhotos(user._id)).length >= MAX_PHOTOS) {
      sendPhotoLimit(req, res);
      return;
    }

    let image: ProcessedImage;
    try {
      image = await processImage(file.buffer);
    } catch (err) {
      if (!(err instanceof MediaValidationError)) throw err;
      sendError(req, res, err.status, err.code, err.message, err.details);
      return;
    }

    const reservation = await reservePhoto(user._id, idempotencyKey, requestHash, image);
    if (reservation.kind === 'duplicate') {
      await replayUpload(req, res, reservation.photo, requestHash);
      return;
    }
    if (reservation.kind === 'limit') {
      sendPhotoLimit(req, res);
      return;
    }
    if (reservation.kind === 'busy') {
      sendError(req, res, 503, 'PHOTO_SET_BUSY', 'Your photos are being updated. Please try again.', {}, true);
      return;
    }

    const { photo, revision } = reservation;
    try {
      await storage.putObject(photo.originalPrivateKey, image.master, { contentType: MASTER_CONTENT_TYPE });
      for (const variant of PHOTO_VARIANTS) {
        await storage.putObject(photo.variantKeys[variant], image.variants[variant], { contentType: VARIANT_CONTENT_TYPE });
      }
    } catch (err) {
      console.error(`[${req.requestId}] Media storage write failed: ${(err as Error).message}`);
      await failUpload(photo);
      sendError(req, res, 503, 'STORAGE_UNAVAILABLE', 'This photo did not finish uploading. Try again.', {}, true);
      return;
    }

    const committed = await photos.updateOne(
      { _id: photo._id, state: PhotoState.PROCESSING },
      { $set: { state: PhotoState.PENDING, updatedAt: new Date() } },
    );
    if (committed.matchedCount === 0) {
      // Removed by the owner (or expired by the cleanup worker) mid-upload
      await failUpload(photo);
      sendError(req, res, 404, 'PHOTO_NOT_FOUND', 'This photo was removed before it finished uploading.');
      return;
    }

    res.status(201).json({
      data: { id: photo._id, state: PhotoState.PENDING, order: photo.order, revision },
      meta: { requestId: req.requestId },
    });
  });

  /**
   * GET /v1/me/photos
   * Owner's photos in display order, then rejected photos awaiting replacement.
   */
  router.get('/v1/me/photos', requireAuth, async (req: Request, res: Response) => {
    const user = await loadAccount(req, res);
    if (!user) return;

    const set = await findOrCreatePhotoSet(db, user._id);
    const owned = await photos.find({ ownerId: user._id, state: { $in: OWNER_VISIBLE_PHOTO_STATES } }).toArray();
    const active = owned.filter((p) => p.state !== PhotoState.REJECTED).sort((a, b) => a.order - b.order);
    const rejected = owned
      .filter((p) => p.state === PhotoState.REJECTED)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    res.json({
      data: {
        photos: [...active, ...rejected].map(toOwnerPhotoDTO),
        revision: set.revision,
        minPhotos: MIN_PHOTOS,
        maxPhotos: MAX_PHOTOS,
      },
      meta: { requestId: req.requestId },
    });
  });

  /**
   * PATCH /v1/me/photos/order
   * Replace the full ordering. Must list every current non-rejected photo exactly once.
   */
  router.patch('/v1/me/photos/order', requireAuth, async (req: Request, res: Response) => {
    const user = await loadAccount(req, res);
    if (!user) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const expectedRevision = body['expectedRevision'];
    const photoIds = body['photoIds'];
    const fieldErrors: { field: string; message: string }[] = [];
    if (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision)) {
      fieldErrors.push({ field: 'expectedRevision', message: 'Required integer revision' });
    }
    if (!Array.isArray(photoIds) || photoIds.length > MAX_PHOTOS || !photoIds.every((id) => typeof id === 'string')) {
      fieldErrors.push({ field: 'photoIds', message: `Required array of up to ${MAX_PHOTOS} photo IDs` });
    }
    if (fieldErrors.length > 0) {
      sendError(req, res, 422, 'VALIDATION_ERROR', 'Invalid fields', { fieldErrors });
      return;
    }
    const revision = expectedRevision as number;
    const requested = photoIds as string[];

    const set = await findOrCreatePhotoSet(db, user._id);
    if (revision !== set.revision) {
      sendRevisionConflict(req, res, set.revision);
      return;
    }

    const currentIds = new Set((await activePhotos(user._id)).map((p) => p._id));
    const missing = [...currentIds].filter((id) => !requested.includes(id));
    const unexpected = requested.filter((id) => !currentIds.has(id));
    if (missing.length > 0 || unexpected.length > 0 || new Set(requested).size !== requested.length) {
      sendError(req, res, 422, 'PHOTO_SET_MISMATCH', 'List each of your current photos exactly once.', { missing, unexpected });
      return;
    }

    // Compare-and-set so concurrent reorders, uploads and deletes cannot both win
    const cas = await photoSets.updateOne(
      { _id: user._id, revision },
      { $set: { revision: revision + 1, updatedAt: new Date() } },
    );
    if (cas.matchedCount === 0) {
      const current = await findOrCreatePhotoSet(db, user._id);
      sendRevisionConflict(req, res, current.revision);
      return;
    }

    const now = new Date();
    for (const [index, id] of requested.entries()) {
      await photos.updateOne({ _id: id, ownerId: user._id }, { $set: { order: index, updatedAt: now } });
    }

    res.json({
      data: { revision: revision + 1, photoIds: requested },
      meta: { requestId: req.requestId },
    });
  });

  /**
   * DELETE /v1/me/photos/:id
   * Owner only. Access ends immediately; objects are purged now or by the cleanup worker.
   */
  router.delete('/v1/me/photos/:id', requireAuth, async (req: Request, res: Response) => {
    const user = await loadAccount(req, res);
    if (!user) return;

    const photoId = String(req.params['id']);
    const now = new Date();
    const result = await photos.updateOne(
      { _id: photoId, ownerId: user._id, state: { $in: OWNER_VISIBLE_PHOTO_STATES } },
      { $set: { state: PhotoState.DELETED, deletedAt: now, updatedAt: now } },
    );
    if (result.matchedCount === 0) {
      sendError(req, res, 404, 'PHOTO_NOT_FOUND', 'Photo not found');
      return;
    }

    const revision = await bumpPhotoSetRevision(db, user._id);
    await recomputeReadiness(db, user._id);

    const deleted = await photos.findOne({ _id: photoId });
    if (deleted) await purgePhotoObjects(db, storage, deleted);

    res.json({
      data: { deleted: true, revision },
      meta: { requestId: req.requestId },
    });
  });

  /**
   * GET /v1/media/:assetId/:variant
   * Stream a thumb or display variant after rechecking access on every request.
   * Originals and quarantine objects are never served.
   */
  router.get('/v1/media/:assetId/:variant', requireAuth, async (req: Request, res: Response) => {
    const variant = String(req.params['variant']) as PhotoVariant;
    if (!PHOTO_VARIANTS.includes(variant)) {
      sendError(req, res, 404, 'MEDIA_UNAVAILABLE', 'This photo is not available');
      return;
    }

    const viewer = await loadAccount(req, res);
    if (!viewer) return;

    const photo = await photos.findOne({ _id: String(req.params['assetId']) });
    const isOwner = photo !== null && photo.ownerId === viewer._id;

    // Same eligibility rule as viewing a profile (R-AUTH-08)
    if (!isOwner && (!canInteract(viewer.accountStatus) || !viewer.profileReady)) {
      sendError(req, res, 403, 'ACCOUNT_NOT_ELIGIBLE', 'Complete your profile to view others');
      return;
    }

    let visible = false;
    if (photo && isOwner) {
      visible = photo.state === PhotoState.PENDING || photo.state === PhotoState.APPROVED || photo.state === PhotoState.REJECTED;
    } else if (photo && photo.state === PhotoState.APPROVED) {
      const owner = await users.findOne({ _id: photo.ownerId });
      visible = owner !== null && canInteract(owner.accountStatus) && owner.profileReady;
    }
    if (!photo || !visible) {
      sendError(req, res, 404, 'MEDIA_UNAVAILABLE', 'This photo is not available');
      return;
    }

    // Revalidation is cheap but still passes through the access check above
    const etag = `"${photo._id}-${photo.contentVersion}-${variant}"`;
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('ETag', etag);
    if (req.get('If-None-Match') === etag) {
      res.status(304).end();
      return;
    }

    let stream;
    try {
      stream = await storage.getObjectStream(photo.variantKeys[variant]);
    } catch (err) {
      console.error(`[${req.requestId}] Media storage read failed: ${(err as Error).message}`);
      sendError(req, res, 503, 'STORAGE_UNAVAILABLE', 'This photo could not be loaded. Try again.', {}, true);
      return;
    }
    if (!stream) {
      console.error(`[${req.requestId}] Missing media object for photo ${photo._id} (${variant})`);
      sendError(req, res, 404, 'MEDIA_UNAVAILABLE', 'This photo is not available');
      return;
    }

    res.status(200);
    res.setHeader('Content-Type', VARIANT_CONTENT_TYPE);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      await pipeline(stream, res);
    } catch (err) {
      console.error(`[${req.requestId}] Media stream interrupted: ${(err as Error).message}`);
    }
  });

  return router;
}
