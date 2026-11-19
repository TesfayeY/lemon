import type { Request, Response } from 'express';

/** Sets `Retry-After` (whole seconds, at least 1) and returns the value sent. */
export function setRetryAfter(res: Response, seconds: number): number {
  const whole = Math.max(1, Math.ceil(seconds));
  res.setHeader('Retry-After', String(whole));
  return whole;
}

/**
 * 429 `RATE_LIMITED` in the standard error envelope, for every rate limit.
 * `retryAfterSeconds` repeats the Retry-After header for clients that only read the body.
 */
export function sendRateLimited(
  req: Request,
  res: Response,
  retryAfterSeconds: number,
  message = 'Too many requests. Please wait a moment and try again.',
): void {
  const seconds = setRetryAfter(res, retryAfterSeconds);
  res.status(429).json({
    error: { code: 'RATE_LIMITED', message, retryable: true, retryAfterSeconds: seconds },
    requestId: req.requestId,
  });
}
