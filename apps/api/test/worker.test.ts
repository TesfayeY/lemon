import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Db } from 'mongodb';
import { InMemoryMediaStorage } from '../src/adapters/media/in-memory.js';
import { createMediaCleanupJob } from '../src/workers/media-cleanup.js';
import { runJobsOnce, startJobLoop, startWorker, type WorkerJob } from '../src/workers/runner.js';

/** A job whose runs stay pending until the test resolves them. */
function controlledJob(intervalMs = 1000) {
  const pending: (() => void)[] = [];
  const job: WorkerJob = {
    name: 'test-job',
    intervalMs,
    run: vi.fn(() => new Promise<void>((resolve) => pending.push(resolve))),
  };
  /** Finish the oldest pending run and let its continuation schedule the next tick. */
  const finishRun = async () => {
    pending.shift()!();
    await vi.advanceTimersByTimeAsync(0);
  };
  return { job, finishRun, running: () => pending.length };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('startJobLoop', () => {
  it('runs immediately, then again one interval after each run finishes', async () => {
    const { job, finishRun } = controlledJob(1000);
    const loop = startJobLoop(job);
    expect(job.run).toHaveBeenCalledTimes(1);

    await finishRun();
    await vi.advanceTimersByTimeAsync(999);
    expect(job.run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(job.run).toHaveBeenCalledTimes(2);

    await finishRun();
    await loop.stop();
  });

  it('never overlaps runs: a slow run delays the next one', async () => {
    const { job, finishRun, running } = controlledJob(1000);
    const loop = startJobLoop(job);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(job.run).toHaveBeenCalledTimes(1);
    expect(running()).toBe(1);

    await finishRun();
    await vi.advanceTimersByTimeAsync(1000);
    expect(job.run).toHaveBeenCalledTimes(2);

    await finishRun();
    await loop.stop();
  });

  it('logs a failed run without its message and keeps going', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('E11000 dup key: { firebaseUid: "uid-PRIVATE" }'), { code: 11000 }))
      .mockResolvedValue(undefined);
    const loop = startJobLoop({ name: 'flaky', intervalMs: 500, run });

    await vi.advanceTimersByTimeAsync(500);
    expect(run).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0]!.join(' ');
    expect(line).toContain('flaky');
    expect(line).toContain('code=11000');
    expect(line).not.toContain('uid-PRIVATE');

    await loop.stop();
  });

  it('stop() waits for the running pass and schedules no more', async () => {
    const { job, finishRun } = controlledJob(1000);
    const loop = startJobLoop(job);

    let stopped = false;
    const stopping = loop.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);

    await finishRun();
    await stopping;
    expect(stopped).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(job.run).toHaveBeenCalledTimes(1);
  });
});

describe('runJobsOnce', () => {
  it('runs every job once and reports whether all succeeded', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const ok = vi.fn().mockResolvedValue(undefined);
    const failing = vi.fn().mockRejectedValue(new Error('down'));

    expect(await runJobsOnce([{ name: 'a', intervalMs: 1, run: ok }])).toBe(true);
    expect(await runJobsOnce([
      { name: 'b', intervalMs: 1, run: failing },
      { name: 'c', intervalMs: 1, run: ok },
    ])).toBe(false);
    expect(ok).toHaveBeenCalledTimes(2);
  });
});

describe('startWorker', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)('on %s finishes the running pass, closes, then exits 0', async (signal) => {
    const { job, finishRun } = controlledJob(1000);
    const signals = new EventEmitter();
    const order: string[] = [];
    const close = vi.fn(async () => { order.push('close'); });
    const exit = vi.fn((code: number) => { order.push(`exit ${code}`); });
    startWorker({ jobs: [job], close, signals, exit });

    signals.emit(signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(close).not.toHaveBeenCalled();

    order.push('run finished');
    await finishRun();
    expect(order).toEqual(['run finished', 'close', 'exit 0']);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(job.run).toHaveBeenCalledTimes(1);
  });

  it('exits 1 straight away on a second signal', async () => {
    const { job } = controlledJob(1000);
    const signals = new EventEmitter();
    const exit = vi.fn();
    startWorker({ jobs: [job], close: async () => {}, signals, exit });

    signals.emit('SIGTERM');
    signals.emit('SIGINT');
    await vi.advanceTimersByTimeAsync(0);

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits 1 if closing resources fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const signals = new EventEmitter();
    const exit = vi.fn();
    const job: WorkerJob = { name: 'quick', intervalMs: 1000, run: async () => {} };
    startWorker({ jobs: [job], close: async () => { throw new Error('close failed'); }, signals, exit });

    signals.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(0);

    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe('createMediaCleanupJob', () => {
  /** Minimal photos collection: one stale `processing` upload, then nothing to do. */
  function fakeDb() {
    const stale = { _id: 'asset-1', ownerId: 'owner-1', state: 'processing', createdAt: new Date(0) };
    let expired = false;
    const collection = (name: string) => ({
      find: () => ({
        limit: () => ({
          toArray: async () => (name === 'photos' && !expired ? [stale] : []),
        }),
      }),
      updateOne: async () => {
        if (name === 'photos') expired = true;
        return { matchedCount: 1 };
      },
      findOne: async () => ({ _id: 'owner-1', ownerId: 'owner-1', revision: 2 }),
      insertOne: async () => ({}),
    });
    return { collection } as unknown as Db;
  }

  it('runs the media cleanup every minute and logs counts only when something changed', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const job = createMediaCleanupJob(fakeDb(), new InMemoryMediaStorage());
    expect(job.intervalMs).toBe(60_000);

    await job.run();
    expect(log).toHaveBeenCalledWith('Media cleanup: {"expired":1,"purged":0,"retryLater":0}');

    log.mockClear();
    await job.run();
    expect(log).not.toHaveBeenCalled();
  });
});
