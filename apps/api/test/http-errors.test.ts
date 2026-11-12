import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import multer from 'multer';
import { createApp } from '../src/app.js';
import { buildApp } from './support.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** App with a few probe routes standing in for feature routes. */
function makeApp(fail: () => unknown = () => new Error('boom')) {
  const router = express.Router();
  router.post('/v1/echo', (req, res) => {
    res.json({ data: { body: req.body, name: (req.body as Record<string, unknown>)['name'] ?? null } });
  });
  router.patch('/v1/echo', (req, res) => {
    res.json({ data: { body: req.body } });
  });
  router.get('/v1/items/:id', (req, res) => {
    res.json({ data: { id: req.params.id } });
  });
  router.post('/v1/fail', () => {
    throw fail();
  });
  router.post('/v1/form', multer({ storage: multer.memoryStorage() }).single('photo'), (req, res) => {
    res.json({ data: { body: req.body, size: req.file?.size ?? null } });
  });
  return createApp({ mongoCheck: async () => true, firebaseCheck: async () => true, routes: [router] });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Malformed request bodies', () => {
  it('returns 400 INVALID_JSON for malformed JSON, not a retryable 500', async () => {
    const res = await request(makeApp())
      .post('/v1/echo')
      .set('Content-Type', 'application/json')
      .send('{"name": "Abebe",');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { code: 'INVALID_JSON', message: expect.any(String), retryable: false },
      requestId: expect.stringMatching(UUID),
    });
  });

  it('returns 413 PAYLOAD_TOO_LARGE for a JSON body over 1 MB', async () => {
    const res = await request(makeApp())
      .post('/v1/echo')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ name: 'x'.repeat(1024 * 1024) }));

    expect(res.status).toBe(413);
    expect(res.body.error).toEqual({ code: 'PAYLOAD_TOO_LARGE', message: expect.any(String), retryable: false });
    expect(res.body.requestId).toMatch(UUID);
  });

  it('maps other exposed 4xx body-parser errors to their status, never retryable', async () => {
    const res = await request(makeApp())
      .post('/v1/echo')
      .set('Content-Type', 'application/json; charset=koi8-r')
      .send('{}');

    expect(res.status).toBe(415);
    expect(res.body.error).toEqual({ code: 'UNSUPPORTED_MEDIA_TYPE', message: expect.any(String), retryable: false });
    expect(res.body.requestId).toBeDefined();
  });

  it('returns 400 BAD_REQUEST for a path parameter that is not valid percent-encoding', async () => {
    const res = await request(makeApp()).get('/v1/items/%E0%A4%A');

    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: 'BAD_REQUEST', message: expect.any(String), retryable: false });
  });

  it('does not log client errors as unhandled', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await request(makeApp()).post('/v1/echo').set('Content-Type', 'application/json').send('{');
    expect(log).not.toHaveBeenCalled();
  });
});

describe('Missing request bodies', () => {
  it('gives routes an empty object when no body is sent', async () => {
    const res = await request(makeApp()).patch('/v1/echo');

    expect(res.status).toBe(200);
    expect(res.body.data.body).toEqual({});
  });

  it('gives routes an empty object for a non-JSON content type', async () => {
    const res = await request(makeApp()).post('/v1/echo').set('Content-Type', 'text/plain').send('name=Abebe');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ body: {}, name: null });
  });

  it('PATCH /v1/me/onboarding with no body is a 400 NO_UPDATES, not a 500', async () => {
    const app = buildApp();
    await request(app).post('/v1/me/bootstrap').set('Authorization', 'Bearer valid-token').expect(201);

    const res = await request(app).patch('/v1/me/onboarding').set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_UPDATES');
  });

  it('leaves multipart parsing to multer', async () => {
    const res = await request(makeApp())
      .post('/v1/form')
      .field('caption', 'hello')
      .attach('photo', Buffer.from('fake image bytes'), 'photo.jpg');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ body: { caption: 'hello' }, size: 16 });
  });
});

describe('Request IDs', () => {
  it('echoes a well-formed client request ID', async () => {
    const res = await request(makeApp()).get('/health').set('x-request-id', 'req_01J9:edge-7.a');
    expect(res.body.meta.requestId).toBe('req_01J9:edge-7.a');
  });

  it.each([
    ['spaces and markup', '<script>alert(1)</script> x'],
    ['a forged log line', 'abc\tERROR admin login'],
    ['an over-long value', 'a'.repeat(129)],
    ['an empty value', ''],
  ])('replaces a request ID with %s by a generated UUID', async (_label, header) => {
    const res = await request(makeApp()).get('/health').set('x-request-id', header);
    expect(res.body.meta.requestId).toMatch(UUID);
  });

  it('attaches the request ID to body-parser errors', async () => {
    const res = await request(makeApp())
      .post('/v1/echo')
      .set('x-request-id', 'client-42')
      .set('Content-Type', 'application/json')
      .send('not json');

    expect(res.status).toBe(400);
    expect(res.body.requestId).toBe('client-42');
  });
});

describe('Unhandled errors', () => {
  it('stay a retryable 500 INTERNAL_ERROR', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(makeApp()).post('/v1/fail').send({});

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', retryable: true },
      requestId: expect.stringMatching(UUID),
    });
  });
});

describe('Response headers', () => {
  it('does not advertise Express', async () => {
    const res = await request(makeApp()).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
