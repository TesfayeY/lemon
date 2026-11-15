/**
 * Caps how many operations run at once in this process, without a queue:
 * a caller that finds every slot taken is turned away (the route answers 503
 * with Retry-After) instead of waiting in a line that can grow without bound.
 */
export class ConcurrencyLimiter {
  private active = 0;

  constructor(readonly max: number) {
    if (!Number.isInteger(max) || max < 1) throw new Error(`Invalid concurrency limit: ${max}`);
  }

  get inFlight(): number {
    return this.active;
  }

  /** A release function (safe to call more than once), or null when every slot is taken. */
  tryAcquire(): (() => void) | null {
    if (this.active >= this.max) return null;
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
    };
  }
}
