import { initializeApp, cert, getApps, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import type { Env } from './config.js';

let app: App | null = null;

export function initFirebase(config: Env): App {
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

export async function checkFirebase(): Promise<boolean> {
  try {
    // Simple check: verify the app is initialized
    if (!app) return false;
    const auth = getAuth(app);
    // Try listing (0 results) to verify emulator connection
    await auth.listUsers(1);
    return true;
  } catch {
    return false;
  }
}

export { getAuth, getFirestore };
