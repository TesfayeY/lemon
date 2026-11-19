/**
 * Interval runner for background jobs, shared by every job the worker entry
 * point (src/worker.ts) starts.
 */

import { describeError } from '../logging.js';

/** A recurring background job. `run` must be idempotent: a crash or shutdown can cut it off anywhere. */
export interface WorkerJob {
  name: string;
  /** Pause between the end of one run and the start of the next. */
  intervalMs: number;
  run: () => Promise<void>;
}

export interface JobLoop {
  /** Cancels the next run and resolves once the current one, if any, has finished. */
  stop(): Promise<void>;
}

/** Runs a job once. A failure is logged (name and code only) and reported as false; it never throws. */
async function runSafely(job: WorkerJob): Promise<boolean> {
  try {
    await job.run();
    return true;
  } catch (err) {
    console.error(`Worker job ${job.name} failed: ${describeError(err)}`);
    return false;
  }
}

/**
 * Runs the job now, then `intervalMs` after each run finishes, so runs never
 * overlap. A failed run is retried on the next tick.
 */
export function startJobLoop(job: WorkerJob): JobLoop {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let current: Promise<void> = Promise.resolve();

  const tick = () => {
    timer = null;
    current = runSafely(job).then(() => {
      if (!stopped) timer = setTimeout(tick, job.intervalMs);
    });
  };
  tick();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      await current;
    },
  };
}

/** Runs every job once, in order. Resolves to false if any of them failed. */
export async function runJobsOnce(jobs: WorkerJob[]): Promise<boolean> {
  let ok = true;
  for (const job of jobs) {
    if (!(await runSafely(job))) ok = false;
  }
  return ok;
}

export interface SignalSource {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export interface WorkerOptions {
  jobs: WorkerJob[];
  /** Releases shared resources (the MongoDB client) after the last run has finished. */
  close: () => Promise<void>;
  /** Defaults to the current process. */
  signals?: SignalSource;
  /** Defaults to process.exit. */
  exit?: (code: number) => void;
}

export interface RunningWorker {
  /** Graceful shutdown, as on the first SIGINT or SIGTERM. */
  shutdown(reason: string): Promise<void>;
}

/**
 * Starts every job loop and shuts down gracefully on SIGINT or SIGTERM: no new
 * runs start, running ones finish, then `close` runs and the process exits 0.
 * A second signal exits 1 straight away.
 */
export function startWorker({
  jobs,
  close,
  signals = process,
  exit = (code) => process.exit(code),
}: WorkerOptions): RunningWorker {
  const loops = jobs.map(startJobLoop);
  let shuttingDown = false;

  async function shutdown(reason: string) {
    if (shuttingDown) {
      console.warn(`Worker received ${reason} again; exiting without waiting for running jobs`);
      exit(1);
      return;
    }
    shuttingDown = true;
    console.log(`Worker received ${reason}; finishing running jobs`);
    let code = 0;
    try {
      await Promise.all(loops.map((loop) => loop.stop()));
      await close();
    } catch (err) {
      console.error(`Worker shutdown failed: ${describeError(err)}`);
      code = 1;
    }
    exit(code);
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    signals.on(signal, () => void shutdown(signal));
  }
  return { shutdown };
}
