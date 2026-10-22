import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp, type AppDependencies } from '../src/app.js';

function makeApp(overrides: Partial<AppDependencies> = {}) {
  return createApp({
    mongoCheck: async () => true,
    firebaseCheck: async () => true,
    ...overrides,
  });
}

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const app = makeApp();
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ok');
    expect(res.body.meta.requestId).toBeDefined();
  });

  it('includes a request ID from header if provided', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/health')
      .set('x-request-id', 'test-123');

    expect(res.body.meta.requestId).toBe('test-123');
  });
});

describe('GET /ready', () => {
  it('returns 200 when all dependencies are healthy', async () => {
    const app = makeApp();
    const res = await request(app).get('/ready');

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ready');
    expect(res.body.data.checks.mongodb).toBe(true);
    expect(res.body.data.checks.firebase).toBe(true);
  });

  it('returns 503 when MongoDB is unavailable', async () => {
    const app = makeApp({ mongoCheck: async () => false });
    const res = await request(app).get('/ready');

    expect(res.status).toBe(503);
    expect(res.body.data.status).toBe('degraded');
    expect(res.body.data.checks.mongodb).toBe(false);
  });

  it('returns 503 when Firebase is unavailable', async () => {
    const app = makeApp({ firebaseCheck: async () => false });
    const res = await request(app).get('/ready');

    expect(res.status).toBe(503);
    expect(res.body.data.status).toBe('degraded');
    expect(res.body.data.checks.firebase).toBe(false);
  });

  it('returns 503 when a dependency check throws', async () => {
    const app = makeApp({
      mongoCheck: async () => { throw new Error('connection refused'); },
    });
    const res = await request(app).get('/ready');

    expect(res.status).toBe(503);
    expect(res.body.data.checks.mongodb).toBe(false);
  });
});

describe('Unknown routes', () => {
  it('returns 404 with NOT_FOUND error for unknown paths', async () => {
    const app = makeApp();
    const res = await request(app).get('/v1/nonexistent');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.retryable).toBe(false);
    expect(res.body.requestId).toBeDefined();
  });

  it('returns 404 for POST to unknown path', async () => {
    const app = makeApp();
    const res = await request(app).post('/v1/nonexistent').send({});

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
