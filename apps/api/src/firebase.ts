import { initializeApp, getApps, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import type { Env } from './config.js';

let app: App | null = null;
let configuredProjectId: string | null = null;

export function initFirebase(config: Env): App {
  configuredProjectId = config.FIREBASE_PROJECT_ID;

  if (getApps().length > 0) {
    app = getApps()[0]!;
    return app;
  }

  // In dev/test with emulators, use project ID only (no credentials needed)
  app = initializeApp({
    projectId: config.FIREBASE_PROJECT_ID,
  });

  return app;
}

/**
 * Readiness: the Admin SDK is initialized for the configured project.
 *
 * Deliberately local. `/ready` needs no sign-in, so it must not call the Admin
 * API on every request (that spends quota and needs service-account
 * credentials, while ID-token verification works with the project ID alone).
 */
export async function checkFirebase(): Promise<boolean> {
  if (!app || !configuredProjectId) return false;
  try {
    getAuth(app);
    return app.options.projectId === configuredProjectId;
  } catch {
    return false;
  }
}

export { getAuth, getFirestore };
