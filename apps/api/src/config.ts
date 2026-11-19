import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  MONGO_URI: z.string().min(1),
  MONGO_DB_NAME: z.string().min(1).default('lemon'),

  // Firebase
  FIREBASE_PROJECT_ID: z.string().min(1),
  FIRESTORE_EMULATOR_HOST: z.string().optional(),
  FIREBASE_AUTH_EMULATOR_HOST: z.string().optional(),

  // Media
  MEDIA_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  MEDIA_LOCAL_DIR: z.string().min(1).default('.local-media'),

  // Discovery (cursor HMAC secret is required in production; see modules/discovery/cursor.ts)
  DISCOVERY_CURSOR_SECRET: z.string().min(32).optional(),
  PASS_COOLDOWN_DAYS: z.coerce.number().int().positive().default(30),
  // Likes: new likes per UTC day (P-10 proposes 8, pending owner confirmation)
  LIKES_PER_UTC_DAY: z.coerce.number().int().min(0).default(8),

  // Rate limits and upload bounds: proposed pilot values pending owner confirmation
  // (spec "Proposed abuse limits"; see docs/features/rate-limits.md)
  PHOTO_UPLOADS_PER_HOUR: z.coerce.number().int().positive().default(10), // per account, all processes
  MEDIA_MAX_CONCURRENT_UPLOADS: z.coerce.number().int().positive().default(4), // per process
  DISCOVERY_SESSIONS_PER_HOUR: z.coerce.number().int().positive().default(30), // per account, all processes
  REQUEST_RATE_LIMIT_BURST: z.coerce.number().int().positive().default(60), // per account, per process
  REQUEST_RATE_LIMIT_PER_SECOND: z.coerce.number().positive().default(2), // refill after the burst

  // Admin: account actions require a Firebase sign-in at most this many seconds old
  ADMIN_RECENT_AUTH_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(900),
});

export type Env = z.infer<typeof envSchema>;

/** Invalid environment. Its message names the variables and rules, never their values, so it is safe to log. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function loadConfig(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Invalid environment configuration:\n${formatted}`);
  }

  const config = result.data;

  // Fail fast: prevent accidental production Firebase usage in test/dev
  if (config.NODE_ENV !== 'production') {
    if (!config.FIRESTORE_EMULATOR_HOST && !config.FIREBASE_AUTH_EMULATOR_HOST) {
      console.warn(
        'WARNING: No Firebase emulator hosts set in non-production mode. ' +
        'Set FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST to use emulators.'
      );
    }
  }

  assertNoEmulatorsInProduction(config);

  return config;
}

const EMULATOR_HOST_VARS = ['FIREBASE_AUTH_EMULATOR_HOST', 'FIRESTORE_EMULATOR_HOST'] as const;

/**
 * Refuse to start production with Firebase emulator settings. With
 * FIREBASE_AUTH_EMULATOR_HOST set, firebase-admin accepts unsigned emulator ID
 * tokens, so anyone could sign in as anyone. Any value counts as set, even an
 * empty one: the fix is to remove the variable.
 */
function assertNoEmulatorsInProduction(config: Env): void {
  if (config.NODE_ENV !== 'production') return;
  const present = EMULATOR_HOST_VARS.filter((name) => config[name] !== undefined);
  if (present.length > 0) {
    // ConfigError: the message names variables only, so startup logs it in full
    throw new ConfigError(`Firebase emulator settings are not allowed in production. Unset: ${present.join(', ')}`);
  }
}
