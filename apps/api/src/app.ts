import express, { type Request, type Response, type NextFunction } from 'express';
import type { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';

export interface AppDependencies {
  mongoCheck: () => Promise<boolean>;
  firebaseCheck: () => Promise<boolean>;
  routes?: Router[];
}

export function createApp(deps: AppDependencies) {
  const app = express();

  app.use(express.json({ limit: '1mb' }));

  // Attach request ID to every request
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.requestId = req.headers['x-request-id'] as string || uuidv4();
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

  // Error handler
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    // Never expose stack traces or internal details
    console.error(`[${req.requestId}] Unhandled error: ${err.message}`);
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
