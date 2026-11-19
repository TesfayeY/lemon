import { describe, it, expect, vi, afterEach } from 'vitest';
import { deleteApp, getApps } from 'firebase-admin/app';
import type { Env } from '../src/config.js';

/** Fresh copy of src/firebase.ts, so its module-level app starts unset. */
async function loadFirebaseModule() {
  vi.resetModules();
  return import('../src/firebase.js');
}

const config = (projectId: string) => ({ FIREBASE_PROJECT_ID: projectId }) as Env;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe('checkFirebase (readiness)', () => {
  it('is not ready before Firebase is initialized', async () => {
    const { checkFirebase } = await loadFirebaseModule();
    expect(await checkFirebase()).toBe(false);
  });

  it('is ready once initialized for the configured project, without calling the Admin API', async () => {
    const { initFirebase, checkFirebase, getAuth } = await loadFirebaseModule();
    const app = initFirebase(config('lemon-dev'));
    // Nothing listens here: any network call would fail the check
    vi.stubEnv('FIREBASE_AUTH_EMULATOR_HOST', '127.0.0.1:1');
    const listUsers = vi.spyOn(getAuth(app), 'listUsers');

    expect(await checkFirebase()).toBe(true);
    expect(listUsers).not.toHaveBeenCalled();
  });

  it('is not ready when the initialized app belongs to another project', async () => {
    const { initFirebase, checkFirebase } = await loadFirebaseModule();
    initFirebase(config('lemon-dev'));
    initFirebase(config('lemon-prod'));

    expect(await checkFirebase()).toBe(false);
  });
});
