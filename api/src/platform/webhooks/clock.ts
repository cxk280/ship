/**
 * Injectable clock. The retry scheduler depends on this seam so tests drive time
 * deterministically (TestClock.advance) instead of sleeping — "timing-based
 * webhook tests are flaky tests" (PRD).
 */
export interface Clock {
  now(): number; // ms
  schedule(fn: () => void | Promise<void>, delayMs: number): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  schedule: (fn, ms) => {
    const t = setTimeout(() => void fn(), ms);
    // Don't keep the process alive for a pending retry.
    (t as unknown as { unref?: () => void }).unref?.();
  },
};

/** Deterministic clock for tests: time only moves when you advance() it. */
export class TestClock implements Clock {
  private current = 0;
  private queue: { at: number; fn: () => void | Promise<void> }[] = [];

  now(): number {
    return this.current;
  }

  schedule(fn: () => void | Promise<void>, delayMs: number): void {
    this.queue.push({ at: this.current + delayMs, fn });
  }

  /** Advance virtual time by ms, awaiting each scheduled callback as it fires. */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    this.queue.sort((a, b) => a.at - b.at);
    while (this.queue.length && this.queue[0]!.at <= target) {
      const job = this.queue.shift()!;
      this.current = job.at;
      await job.fn();
      this.queue.sort((a, b) => a.at - b.at);
    }
    this.current = target;
  }
}
