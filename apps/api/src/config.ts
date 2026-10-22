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
});

export type Env = z.infer<typeof envSchema>;

export function loadConfig(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${formatted}`);
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

  return config;
}
