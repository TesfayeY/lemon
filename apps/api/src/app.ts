import express, { type Request, type Response, type NextFunction } from 'express';
import type { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { describeError } from './logging.js';

export interface AppDependencies {
  mongoCheck: () => Promise<boolean>;
  firebaseCheck: () => Promise<boolean>;
  routes?: Router[];
}

/** Client-supplied request IDs are echoed into logs and responses, so only plain tokens are kept. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function resolveRequestId(header: string | undefined): string {
  return header !== undefined && REQUEST_ID_PATTERN.test(header) ? header : uuidv4();
}

interface ClientError {
  status: number;
  code: string;
  message: string;
}

/**
 * Errors caused by the request itself: body-parser's (malformed JSON, body over
 * the limit), any http-error marked `expose`, and the router's URIError for a
 * malformed path parameter (status 400, not marked `expose`). Anything else is a
 * server fault and stays a 500.
 */
function toClientError(err: unknown): ClientError | null {
  if (typeof err !== 'object' || err === null) return null;
  const { type, status, expose } = err as { type?: unknown; status?: unknown; expose?: unknown };

  if (type === 'entity.parse.failed') {
    return { status: 400, code: 'INVALID_JSON', message: 'The request body is not valid JSON' };
  }
  if (type === 'entity.too.large') {
    return { status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large' };
  }
  if (typeof status !== 'number' || status < 400 || status > 499) return null;
  if (expose !== true && !(err instanceof URIError)) return null;
  if (status === 413) return { status, code: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large' };
  if (status === 415) return { status, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'The request body encoding is not supported' };
  return { status, code: 'BAD_REQUEST', message: 'The request could not be processed' };
}

export function createApp(deps: AppDependencies) {
  const app = express();
  app.disable('x-powered-by');

  // Attach a request ID first, so every response (body-parser errors included) carries one
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.requestId = resolveRequestId(req.get('x-request-id'));
    next();
  });

  app.use(express.json({ limit: '1mb' }));

  // Express 5 leaves req.body undefined when no JSON body was sent. Default it once so no
  // route crashes reading a field. Multipart routes are unaffected: multer sets its own body.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.body ??= {};
    next();
  });

  // Health check — always responds if the process is running
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      data: { status: 'ok' },
      meta: { requestId: _req.requestId },
    });
  });

  // Readiness — checks dependencies
  app.get('/ready', async (req: Request, res: Response) => {
    const checks: Record<string, boolean> = {};

    try {
      checks['mongodb'] = await deps.mongoCheck();
    } catch {
      checks['mongodb'] = false;
    }

    try {
      checks['firebase'] = await deps.firebaseCheck();
    } catch {
      checks['firebase'] = false;
    }

    const allReady = Object.values(checks).every(Boolean);

    res.status(allReady ? 200 : 503).json({
      data: {
        status: allReady ? 'ready' : 'degraded',
        checks,
      },
      meta: { requestId: req.requestId },
    });
  });

  // Mount feature routes
  if (deps.routes) {
    for (const router of deps.routes) {
      app.use(router);
    }
  }

  // 404 for unknown routes
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: `Route ${req.method} ${req.path} not found`,
        retryable: false,
      },
      requestId: req.requestId,
    });
  });

  // Error handler. Never exposes stack traces or internal details, and never logs
  // error messages (they can contain stored values; see describeError).
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      // Too late for an error body (e.g. a stream failed mid-response): drop the connection
      console.error(`[${req.requestId}] Error after response started: ${describeError(err)}`);
      req.socket.destroy();
      return;
    }

    const clientError = toClientError(err);
    if (clientError) {
      res.status(clientError.status).json({
        error: { code: clientError.code, message: clientError.message, retryable: false },
        requestId: req.requestId,
      });
      return;
    }

    const route = (req.route as { path?: unknown } | undefined)?.path;
    const where = typeof route === 'string' ? `${req.method} ${route}` : req.method;
    console.error(`[${req.requestId}] Unhandled error in ${where}: ${describeError(err)}`);
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
        retryable: true,
      },
      requestId: req.requestId,
    });
  });

  return app;
}
