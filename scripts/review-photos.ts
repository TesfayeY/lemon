/**
 * Dev-only manual photo review (no admin UI until Phase 13).
 *
 * Run from apps/api:
 *   npx tsx --env-file=.env ../../scripts/review-photos.ts list
 *   npx tsx --env-file=.env ../../scripts/review-photos.ts approve <photoId> --actor <reviewerId> [--note <text>]
 *   npx tsx --env-file=.env ../../scripts/review-photos.ts reject <photoId> --actor <reviewerId> --reason <code>
 *
 * Every decision goes through reviewPhoto(), which writes the audit log entry.
 */

import type { PhotoDocument } from '../apps/api/src/modules/media/schema.js' with { 'resolution-mode': 'import' };

function option(args: string[], name: string): string | null {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

async function main() {
  // Dynamic imports: scripts/ has no package.json, so this file may load as CommonJS
  const { loadConfig } = await import('../apps/api/src/config.js');
  const { connectDb, closeDb } = await import('../apps/api/src/db.js');
  const { LocalMediaStorage } = await import('../apps/api/src/adapters/media/local.js');
  const { reviewPhoto, REJECTION_REASONS } = await import('../apps/api/src/modules/media/review-service.js');
  const { PhotoState } = await import('../apps/api/src/modules/media/schema.js');

  const USAGE = `Usage:
  review-photos.ts list
  review-photos.ts approve <photoId> --actor <reviewerId> [--note <text>]
  review-photos.ts reject <photoId> --actor <reviewerId> --reason <${Object.keys(REJECTION_REASONS).join('|')}>`;

  const [command, photoId, ...rest] = process.argv.slice(2);
  const config = loadConfig();
  if (config.NODE_ENV === 'production') {
    throw new Error('review-photos.ts is a development tool and refuses to run in production');
  }

  const { db } = await connectDb(config);
  try {
    if (command === 'list') {
      const storage = new LocalMediaStorage(config.MEDIA_LOCAL_DIR);
      const pending = await db.collection<PhotoDocument>('photos')
        .find({ state: PhotoState.PENDING })
        .sort({ createdAt: 1 })
        .toArray();
      if (pending.length === 0) console.log('No photos awaiting review.');
      for (const photo of pending) {
        console.log(`${photo._id}  owner=${photo.ownerId}  ${photo.width}x${photo.height}  uploaded=${photo.createdAt.toISOString()}`);
        console.log(`  view: ${storage.pathFor(photo.variantKeys.display)}`);
      }
      return;
    }

    if ((command === 'approve' || command === 'reject') && photoId) {
      const actor = option(rest, 'actor');
      if (!actor) throw new Error(`--actor is required\n\n${USAGE}`);
      const reason = command === 'reject' ? option(rest, 'reason') : option(rest, 'note');
      const photo = await reviewPhoto(db, photoId, command, reason, actor);
      console.log(`Photo ${photo._id} is now ${photo.state}${photo.moderationReason ? ` (${photo.moderationReason})` : ''}.`);
      return;
    }

    console.log(USAGE);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}

main().catch((err: Error & { code?: string }) => {
  console.error(err.code ? `${err.code}: ${err.message}` : err.message);
  process.exit(1);
});
