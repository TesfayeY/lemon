/**
 * Generated test images. Everything here is synthetic: solid colors and
 * hand-built headers, never real photos of people.
 */

import { deflateSync, crc32 } from 'node:zlib';
import sharp from 'sharp';

const BERRY = '#b5446e';

export function jpeg(width = 400, height = 500, background = BERRY): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background } }).jpeg().toBuffer();
}

export function png(width = 400, height = 500, options: { alpha?: boolean } = {}): Promise<Buffer> {
  const background = options.alpha ? { r: 181, g: 68, b: 110, alpha: 0 } : BERRY;
  return sharp({ create: { width, height, channels: options.alpha ? 4 : 3, background } }).png().toBuffer();
}

export function webp(width = 400, height = 500): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: BERRY } }).webp().toBuffer();
}

export function gif(width = 400, height = 400): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: BERRY } }).gif().toBuffer();
}

export function avif(width = 400, height = 400): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: BERRY } }).avif().toBuffer();
}

export async function animatedWebp(width = 400, height = 400): Promise<Buffer> {
  const frame = (background: string) =>
    sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();
  return sharp([await frame(BERRY), await frame('#c98a3d')], { join: { animated: true } }).webp().toBuffer();
}

/** A HEIC-branded ISO-BMFF header. Real HEIC encoding isn't available in tests; the brand is what we detect. */
export function heicHeader(): Buffer {
  const ftyp = Buffer.alloc(24);
  ftyp.writeUInt32BE(24, 0);
  ftyp.write('ftypheic', 4, 'latin1');
  ftyp.writeUInt32BE(0, 12);
  ftyp.write('mif1heic', 16, 'latin1');
  return Buffer.concat([ftyp, Buffer.alloc(512, 0x2a)]);
}

/** First half of a valid JPEG. */
export async function truncatedJpeg(): Promise<Buffer> {
  const full = await jpeg(400, 500);
  return full.subarray(0, Math.floor(full.length / 2));
}

/** A shell script wearing a .jpg name and image/jpeg content type. */
export function disguisedScript(): Buffer {
  return Buffer.from('#!/bin/sh\necho "not a photo"\n'.repeat(20), 'utf8');
}

/**
 * A tiny PNG whose header declares the given dimensions. Decoding it would need
 * width*height pixels of memory, which is exactly what a decompression bomb does.
 */
export function pngHeader(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(1024))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Metadata-bearing JPEG (committed as gps-exif.jpg) ---

export const FIXTURE_MAKE = 'LemonTestCam';
export const FIXTURE_CREATOR = 'Fictional Tester';

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header[0] = 0xff;
  header[1] = marker;
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

/** Big-endian TIFF/EXIF block: IFD0 (Make, Orientation=6, GPS pointer) + GPS IFD (fictional coordinates). */
function exifSegment(): Buffer {
  const make = Buffer.from(`${FIXTURE_MAKE}\0`, 'latin1');
  const MAKE_OFFSET = 8 + 2 + 3 * 12 + 4;
  const GPS_OFFSET = MAKE_OFFSET + make.length + (make.length % 2);
  const LAT_OFFSET = GPS_OFFSET + 2 + 5 * 12 + 4;
  const LON_OFFSET = LAT_OFFSET + 24;
  const tiff = Buffer.alloc(LON_OFFSET + 24);

  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);

  let p = 8;
  const entry = (tag: number, type: number, count: number, value: (at: number) => void) => {
    tiff.writeUInt16BE(tag, p);
    tiff.writeUInt16BE(type, p + 2);
    tiff.writeUInt32BE(count, p + 4);
    value(p + 8);
    p += 12;
  };
  const rationals = (at: number, values: number[]) => {
    values.forEach((v, i) => {
      tiff.writeUInt32BE(v, at + i * 8);
      tiff.writeUInt32BE(1, at + i * 8 + 4);
    });
  };

  tiff.writeUInt16BE(3, p);
  p += 2;
  entry(0x010f, 2, make.length, (at) => tiff.writeUInt32BE(MAKE_OFFSET, at)); // Make
  entry(0x0112, 3, 1, (at) => tiff.writeUInt16BE(6, at)); // Orientation: rotate 90° CW
  entry(0x8825, 4, 1, (at) => tiff.writeUInt32BE(GPS_OFFSET, at)); // GPSInfo IFD pointer
  tiff.writeUInt32BE(0, p);
  make.copy(tiff, MAKE_OFFSET);

  p = GPS_OFFSET;
  tiff.writeUInt16BE(5, p);
  p += 2;
  entry(0x0000, 1, 4, (at) => tiff.set([2, 2, 0, 0], at)); // GPSVersionID
  entry(0x0001, 2, 2, (at) => tiff.write('N\0', at, 'latin1')); // GPSLatitudeRef
  entry(0x0002, 5, 3, (at) => tiff.writeUInt32BE(LAT_OFFSET, at)); // GPSLatitude
  entry(0x0003, 2, 2, (at) => tiff.write('W\0', at, 'latin1')); // GPSLongitudeRef
  entry(0x0004, 5, 3, (at) => tiff.writeUInt32BE(LON_OFFSET, at)); // GPSLongitude
  tiff.writeUInt32BE(0, p);
  rationals(LAT_OFFSET, [47, 36, 0]);
  rationals(LON_OFFSET, [122, 19, 0]);

  return jpegSegment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]));
}

function xmpSegment(): Buffer {
  const packet =
    '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    `<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:creator="${FIXTURE_CREATOR}"/>` +
    '</rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
  return jpegSegment(0xe1, Buffer.from(`http://ns.adobe.com/xap/1.0/\0${packet}`, 'latin1'));
}

function iptcSegment(): Buffer {
  const byline = Buffer.from(FIXTURE_CREATOR, 'latin1');
  const dataset = (id: number, value: Buffer) => {
    const head = Buffer.from([0x1c, 0x02, id, 0, 0]);
    head.writeUInt16BE(value.length, 3);
    return Buffer.concat([head, value]);
  };
  const iptc = Buffer.concat([dataset(0x00, Buffer.from([0, 4])), dataset(0x50, byline)]);
  const resourceHeader = Buffer.alloc(12);
  resourceHeader.write('8BIM', 0, 'latin1');
  resourceHeader.writeUInt16BE(0x0404, 4);
  resourceHeader.writeUInt16BE(0, 6); // empty, padded resource name
  resourceHeader.writeUInt32BE(iptc.length, 8);
  const padding = Buffer.alloc(iptc.length % 2);
  return jpegSegment(0xed, Buffer.concat([Buffer.from('Photoshop 3.0\0', 'latin1'), resourceHeader, iptc, padding]));
}

/**
 * 600×400 stored pixels (top half red, bottom half blue) tagged Orientation=6,
 * so it should display as 400×600 with red on the right and blue on the left.
 * Carries EXIF (with GPS), XMP and IPTC metadata that must all be stripped.
 */
export async function jpegWithGpsExif(): Promise<Buffer> {
  const red = await sharp({ create: { width: 600, height: 200, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const base = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#0000ff' } })
    .composite([{ input: red, top: 0, left: 0 }])
    .jpeg({ quality: 90 })
    .toBuffer();
  return Buffer.concat([base.subarray(0, 2), exifSegment(), xmpSegment(), iptcSegment(), base.subarray(2)]);
}
