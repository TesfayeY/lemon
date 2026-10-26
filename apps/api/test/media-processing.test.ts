import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { processImage, sniffFormat, MediaValidationError, MEDIA_LIMITS } from '../src/modules/media/processing.js';
import { LocalMediaStorage } from '../src/adapters/media/local.js';
import { InMemoryMediaStorage } from '../src/adapters/media/in-memory.js';
import { FirebaseMediaStorage } from '../src/adapters/media/firebase-storage.js';
import * as images from './fixtures/images/factory.js';

const GPS_FIXTURE = new URL('./fixtures/images/gps-exif.jpg', import.meta.url);

async function rejection(input: Buffer): Promise<MediaValidationError> {
  try {
    await processImage(input);
  } catch (err) {
    if (err instanceof MediaValidationError) return err;
    throw err;
  }
  throw new Error('Expected processImage to reject');
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

describe('sniffFormat', () => {
  it('identifies accepted formats by magic bytes', async () => {
    expect(sniffFormat(await images.jpeg())).toBe('jpeg');
    expect(sniffFormat(await images.png())).toBe('png');
    expect(sniffFormat(await images.webp())).toBe('webp');
  });

  it('identifies HEIC, AVIF and GIF', async () => {
    expect(sniffFormat(images.heicHeader())).toBe('heic');
    expect(sniffFormat(await images.avif())).toBe('avif');
    expect(sniffFormat(await images.gif())).toBe('gif');
  });

  it('returns unknown for anything else, including empty input', () => {
    expect(sniffFormat(images.disguisedScript())).toBe('unknown');
    expect(sniffFormat(Buffer.alloc(0))).toBe('unknown');
  });
});

describe('processImage: accepted input', () => {
  it.each([
    ['JPEG', () => images.jpeg(400, 500)],
    ['PNG', () => images.png(400, 500)],
    ['WebP', () => images.webp(400, 500)],
  ])('accepts %s: JPEG master, WebP variants', async (_name, make) => {
    const result = await processImage(await make());
    expect(result.width).toBe(400);
    expect(result.height).toBe(500);
    expect(sniffFormat(result.master)).toBe('jpeg');
    expect(sniffFormat(result.variants.thumb)).toBe('webp');
    expect(sniffFormat(result.variants.display)).toBe('webp');
  });

  it('WebP display variant is smaller than a JPEG at the same size', async () => {
    const result = await processImage(await images.jpegWithGpsExif());
    const jpegEquivalent = await sharp(result.master)
      .resize({ width: 1080, height: 2160, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
    expect(result.variants.display.length).toBeLessThan(jpegEquivalent.length);
  });

  it('produces bounded thumb and display variants without upscaling', async () => {
    const large = await processImage(await images.jpeg(2000, 3000));
    const thumb = await sharp(large.variants.thumb).metadata();
    const display = await sharp(large.variants.display).metadata();
    expect([thumb.width, thumb.height]).toEqual([320, 480]);
    expect([display.width, display.height]).toEqual([1080, 1620]);

    const small = await processImage(await images.jpeg(400, 500));
    const smallDisplay = await sharp(small.variants.display).metadata();
    expect([smallDisplay.width, smallDisplay.height]).toEqual([400, 500]);
  });

  it('flattens transparent PNGs onto white', async () => {
    const result = await processImage(await images.png(400, 400, { alpha: true }));
    const { data } = await sharp(result.variants.display).raw().toBuffer({ resolveWithObject: true });
    expect([data[0], data[1], data[2]]).toEqual([255, 255, 255]);
  });
});

describe('processImage: metadata and orientation (R-MEDIA-02)', () => {
  it('fixture really carries EXIF GPS, XMP, IPTC and a rotated orientation', async () => {
    const meta = await sharp(await readFile(GPS_FIXTURE)).metadata();
    expect(meta.orientation).toBe(6);
    expect(meta.exif?.includes(Buffer.from([0x88, 0x25]))).toBe(true); // GPSInfo IFD pointer
    expect(meta.xmp).toBeDefined();
    expect(meta.iptc).toBeDefined();
  });

  it('strips all EXIF/XMP/IPTC metadata from the master and every variant', async () => {
    const result = await processImage(await readFile(GPS_FIXTURE));
    for (const output of [result.master, result.variants.thumb, result.variants.display]) {
      const meta = await sharp(output).metadata();
      expect(meta.exif).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
      expect(meta.iptc).toBeUndefined();
      expect(meta.icc).toBeUndefined();
      expect(meta.orientation).toBeUndefined();
      expect(output.includes(Buffer.from(images.FIXTURE_MAKE))).toBe(false);
      expect(output.includes(Buffer.from(images.FIXTURE_CREATOR))).toBe(false);
      expect(output.includes(Buffer.from('Exif\0\0', 'latin1'))).toBe(false);
    }
  });

  it('applies EXIF orientation to the pixels', async () => {
    const result = await processImage(await readFile(GPS_FIXTURE));
    expect([result.width, result.height]).toEqual([400, 600]);

    // Stored top half (red) is displayed on the right after a 90° clockwise turn
    const { data, info } = await sharp(result.master).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => {
      const i = (y * info.width + x) * info.channels;
      return { r: data[i]!, b: data[i + 2]! };
    };
    expect(pixel(350, 300).r).toBeGreaterThan(200);
    expect(pixel(350, 300).b).toBeLessThan(60);
    expect(pixel(50, 300).b).toBeGreaterThan(200);
    expect(pixel(50, 300).r).toBeLessThan(60);
  });
});

describe('processImage: rejected input (R-MEDIA-01)', () => {
  it('rejects HEIC with an informative 415', async () => {
    const err = await rejection(images.heicHeader());
    expect(err.status).toBe(415);
    expect(err.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(err.details['detectedFormat']).toBe('heic');
    expect(err.message).toMatch(/HEIC/);
  });

  it('rejects AVIF and GIF even though the decoder could read them', async () => {
    for (const input of [await images.avif(), await images.gif()]) {
      const err = await rejection(input);
      expect(err.status).toBe(415);
    }
  });

  it('rejects animated images', async () => {
    const err = await rejection(await images.animatedWebp());
    expect(err.status).toBe(415);
    expect(err.details['animated']).toBe(true);
  });

  it('rejects non-image bytes', async () => {
    const err = await rejection(images.disguisedScript());
    expect(err.status).toBe(415);
    expect(err.details['detectedFormat']).toBe('unknown');
  });

  it('rejects a truncated JPEG as corrupt', async () => {
    const err = await rejection(await images.truncatedJpeg());
    expect(err.status).toBe(422);
    expect(err.code).toBe('INVALID_IMAGE');
  });

  it('rejects a valid signature followed by garbage', async () => {
    const garbage = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2048, 0x41)]);
    const err = await rejection(garbage);
    expect(err.code).toBe('INVALID_IMAGE');
  });

  it(`rejects images under ${MEDIA_LIMITS.minShortSide}px on the short side`, async () => {
    const err = await rejection(await images.jpeg(1000, 300));
    expect(err.code).toBe('IMAGE_DIMENSIONS_INVALID');
    expect(err.details['reason']).toBe('too_small');
  });

  it(`rejects images over ${MEDIA_LIMITS.maxLongSide}px on the long side`, async () => {
    const err = await rejection(images.pngHeader(8001, 400));
    expect(err.code).toBe('IMAGE_DIMENSIONS_INVALID');
    expect(err.details['reason']).toBe('too_large');
  });

  it('rejects images over 40 megapixels', async () => {
    const err = await rejection(images.pngHeader(6500, 6500));
    expect(err.code).toBe('IMAGE_DIMENSIONS_INVALID');
    expect(err.details['reason']).toBe('too_many_pixels');
  });

  it('rejects a decompression bomb from its header without decoding it', async () => {
    const bomb = images.pngHeader(50_000, 50_000); // ~1 KB declaring 2.5 gigapixels
    expect(bomb.length).toBeLessThan(2048);
    const started = Date.now();
    const err = await rejection(bomb);
    expect(err.code).toBe('IMAGE_DIMENSIONS_INVALID');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('Media storage adapters', () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('LocalMediaStorage writes, streams and deletes objects', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'lemon-media-'));
    const storage = new LocalMediaStorage(dir);
    const key = 'quarantine/owner-1/asset-1';

    await storage.putObject(key, Buffer.from('bytes'), { contentType: 'image/jpeg' });
    expect(await readFile(storage.pathFor(key), 'utf8')).toBe('bytes');
    expect((await streamToBuffer((await storage.getObjectStream(key))!)).toString()).toBe('bytes');

    await storage.deleteObject(key);
    expect(await storage.getObjectStream(key)).toBeNull();
    await expect(storage.deleteObject(key)).resolves.toBeUndefined();
  });

  it('rejects keys that could escape the storage root', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'lemon-media-'));
    const local = new LocalMediaStorage(dir);
    const memory = new InMemoryMediaStorage();
    for (const key of ['../etc/passwd', 'quarantine/../../x', '/abs/path', 'quarantine/a b', 'quarantine']) {
      await expect(local.putObject(key, Buffer.from('x'))).rejects.toThrow('Invalid media object key');
      await expect(memory.putObject(key, Buffer.from('x'), { contentType: 'image/jpeg' })).rejects.toThrow('Invalid media object key');
    }
  });

  it('Firebase adapter refuses to run until P-04 is approved', async () => {
    await expect(new FirebaseMediaStorage().putObject()).rejects.toThrow('P-04');
  });
});
