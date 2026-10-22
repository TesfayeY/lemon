import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Set minimum required env vars
    process.env['NODE_ENV'] = 'test';
    process.env['MONGO_URI'] = 'mongodb://localhost:27017';
    process.env['MONGO_DB_NAME'] = 'lemon_test';
    process.env['FIREBASE_PROJECT_ID'] = 'lemon-dev';
    process.env['FIREBASE_AUTH_EMULATOR_HOST'] = '127.0.0.1:9099';
    process.env['FIRESTORE_EMULATOR_HOST'] = '127.0.0.1:8080';
  });

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  it('loads valid configuration', () => {
    const config = loadConfig();
    expect(config.NODE_ENV).toBe('test');
    expect(config.FIREBASE_PROJECT_ID).toBe('lemon-dev');
    expect(config.MONGO_URI).toBe('mongodb://localhost:27017');
  });

  it('throws on missing MONGO_URI', () => {
    delete process.env['MONGO_URI'];
    expect(() => loadConfig()).toThrow('Invalid environment configuration');
  });

  it('throws on missing FIREBASE_PROJECT_ID', () => {
    delete process.env['FIREBASE_PROJECT_ID'];
    expect(() => loadConfig()).toThrow('Invalid environment configuration');
  });

  it('rejects invalid NODE_ENV', () => {
    process.env['NODE_ENV'] = 'staging';
    expect(() => loadConfig()).toThrow('Invalid environment configuration');
  });

  it('coerces PORT to number', () => {
    process.env['PORT'] = '4000';
    const config = loadConfig();
    expect(config.PORT).toBe(4000);
  });

  it('defaults PORT to 3000', () => {
    delete process.env['PORT'];
    const config = loadConfig();
    expect(config.PORT).toBe(3000);
  });
});
