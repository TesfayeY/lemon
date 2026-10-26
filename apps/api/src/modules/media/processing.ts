/**
 * Upload validation and normalization.
 *
 * Rules:
 * - The decoded bytes decide the format; client MIME type and filename are ignored.
 * - Accept JPEG, PNG and WebP only. HEIC/HEIF, AVIF, GIF and everything else get
 *   an informative 415 (Flutter converts HEIC to JPEG before upload).
 * - Dimensions are read from the header and checked before any pixel decode, so a
 *   decompression bomb is rejected without allocating its pixels; sharp's
 *   limitInputPixels backs this up during decode.
 * - Orientation is applied to the pixels, then every byte of EXIF/XMP/IPTC/ICC
 *   metadata is dropped by re-encoding. The raw upload is never stored.
 * - The private master is JPEG; the served thumb/display variants are WebP
 *   (smaller than JPEG at similar quality, decoded natively by Flutter).
 * - Never fetches remote URLs: input is always an in-memory buffer.
 */

import sharp, { type Metadata, type SharpOptions } from 'sharp';
import type { PhotoVariant } from './schema.js';

export const MEDIA_LIMITS = {
  minShortSide: 320,
  maxLongSide: 8000,
  maxPixels: 40_000_000,
} as const;

const VARIANT_BOUNDS: Record<PhotoVariant, { width: number; height: number; quality: number }> = {
  thumb: { width: 320, height: 640, quality: 75 },
  display: { width: 1080, height: 2160, quality: 80 },
};

const MASTER_QUALITY = 90;

const SHARP_INPUT: SharpOptions = {
  failOn: 'warning',
  limitInputPixels: MEDIA_LIMITS.maxPixels,
  sequentialRead: true,
};

export const MASTER_CONTENT_TYPE = 'image/jpeg';
export const VARIANT_CONTENT_TYPE = 'image/webp';

export type AcceptedFormat = 'jpeg' | 'png' | 'webp';
export type SniffedFormat = AcceptedFormat | 'heic' | 'avif' | 'gif' | 'unknown';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);
const AVIF_BRANDS = new Set(['avif', 'avis']);

export class MediaValidationError extends Error {
  constructor(
    readonly status: 415 | 422,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface ProcessedImage {
  sourceFormat: AcceptedFormat;
  /** Orientation-normalized, metadata-free full-size re-encode (quarantine copy). */
  master: Buffer;
  variants: Record<PhotoVariant, Buffer>;
  width: number;
  height: number;
}

/** Identify a file by its magic bytes. */
export function sniffFormat(input: Buffer): SniffedFormat {
  if (input.length >= 3 && input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff) return 'jpeg';
  if (input.length >= 8 && input.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (input.length >= 12 && input.toString('latin1', 0, 4) === 'RIFF' && input.toString('latin1', 8, 12) === 'WEBP') {
    return 'webp';
  }
  if (input.length >= 6 && /^GIF8[79]a$/.test(input.toString('latin1', 0, 6))) return 'gif';
  if (input.length >= 12 && input.toString('latin1', 4, 8) === 'ftyp') {
    const brand = input.toString('latin1', 8, 12);
    if (AVIF_BRANDS.has(brand)) return 'avif';
    if (HEIC_BRANDS.has(brand)) return 'heic';
  }
  return 'unknown';
}

function unsupportedFormat(format: SniffedFormat): MediaValidationError {
  const messages: Record<string, string> = {
    heic: 'HEIC photos are not supported yet. Please choose a JPEG, PNG or WebP photo.',
    avif: 'AVIF photos are not supported. Please choose a JPEG, PNG or WebP photo.',
    gif: 'GIFs are not supported. Please choose a JPEG, PNG or WebP photo.',
  };
  return new MediaValidationError(
    415,
    'UNSUPPORTED_MEDIA_TYPE',
    messages[format] ?? 'This file is not a supported photo. Please choose a JPEG, PNG or WebP photo.',
    { detectedFormat: format, acceptedFormats: ['jpeg', 'png', 'webp'] },
  );
}

function invalidImage(): MediaValidationError {
  return new MediaValidationError(422, 'INVALID_IMAGE', 'This photo could not be read. It may be damaged. Please try another photo.');
}

function checkDimensions(width: number, height: number): void {
  const shortSide = Math.min(width, height);
  const longSide = Math.max(width, height);
  let reason: string | null = null;
  if (shortSide < MEDIA_LIMITS.minShortSide) reason = 'too_small';
  else if (longSide > MEDIA_LIMITS.maxLongSide) reason = 'too_large';
  else if (width * height > MEDIA_LIMITS.maxPixels) reason = 'too_many_pixels';
  if (!reason) return;

  const message = reason === 'too_small'
    ? `This photo is too small. Please use one at least ${MEDIA_LIMITS.minShortSide} pixels on its shortest side.`
    : 'This photo is too large. Please use a smaller version of it.';
  throw new MediaValidationError(422, 'IMAGE_DIMENSIONS_INVALID', message, {
    reason,
    width,
    height,
    limits: MEDIA_LIMITS,
  });
}

/** Validate an uploaded buffer and produce the stored master and variants. */
export async function processImage(input: Buffer): Promise<ProcessedImage> {
  const format = sniffFormat(input);
  if (format !== 'jpeg' && format !== 'png' && format !== 'webp') throw unsupportedFormat(format);

  // Header-only read: no pixels are decoded yet, so the pixel limit is applied
  // by checkDimensions (with a specific error) rather than by sharp here
  let meta: Metadata;
  try {
    meta = await sharp(input, { ...SHARP_INPUT, limitInputPixels: false }).metadata();
  } catch {
    throw invalidImage();
  }
  if (meta.format !== format || !meta.width || !meta.height) throw invalidImage();
  if ((meta.pages ?? 1) > 1) {
    throw new MediaValidationError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Animated images are not supported. Please choose a still photo.', {
      detectedFormat: format,
      animated: true,
    });
  }
  // EXIF orientations 5-8 swap width and height
  const oriented = meta.autoOrient ?? { width: meta.width, height: meta.height };
  checkDimensions(oriented.width, oriented.height);

  try {
    const master = await sharp(input, { ...SHARP_INPUT, autoOrient: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: MASTER_QUALITY, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });

    const [thumb, display] = await Promise.all(
      (['thumb', 'display'] as const).map((variant) => {
        const bounds = VARIANT_BOUNDS[variant];
        return sharp(master.data, SHARP_INPUT)
          .resize({ width: bounds.width, height: bounds.height, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: bounds.quality })
          .toBuffer();
      }),
    );

    return {
      sourceFormat: format,
      master: master.data,
      variants: { thumb: thumb!, display: display! },
      width: master.info.width,
      height: master.info.height,
    };
  } catch {
    throw invalidImage();
  }
}
