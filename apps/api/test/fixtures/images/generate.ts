/**
 * Regenerates the committed image fixtures.
 * Run from apps/api: npx tsx test/fixtures/images/generate.ts
 */

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { jpegWithGpsExif } from './factory.js';

const target = fileURLToPath(new URL('./gps-exif.jpg', import.meta.url));
await writeFile(target, await jpegWithGpsExif());
console.log(`Wrote ${target}`);
