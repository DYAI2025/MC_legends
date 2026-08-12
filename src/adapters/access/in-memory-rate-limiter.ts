import type { RateLimiter } from "@/application/access/rate-limiter";

/**
 * How many distinct keys may be tracked before stale ones are swept. Purely a memory
 * guard: without it a flood of one-off keys grows this map without bound.
 */
const SWEEP_THRESHOLD = 5_000;

export type InMemoryRateLimiterOptions = Readonly<{
  limit: number;
  windowMs: number;
  now?: () => number;
}>;

/**
 * Sliding-window counter held in this process's memory.
 *
 * Deliberately NOT production-grade and not to be described as such:
 * - process-local, so two instances of the app allow the limit each,
 * - not distributed and not shared with any other service,
 * - a restart forgets every counter, so the allowance resets.
 *
 * It is an MVP abuse brake for a private family site, and it is testable, which is
 * what MCL-34 asks for. A shared limiter belongs with the durable backend work.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly attempts = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: InMemoryRateLimiterOptions) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.now = options.now ?? Date.now;
  }

  tryConsume(key: string): boolean {
    const now = this.now();
    const oldestAllowed = now - this.windowMs;
    const recent = (this.attempts.get(key) ?? []).filter((at) => at > oldestAllowed);

    if (recent.length >= this.limit) {
      // Stored without the refused attempt: counting it would let a caller that is
      // already over the limit keep pushing its own window forward forever.
      this.attempts.set(key, recent);
      return false;
    }

    recent.push(now);
    this.attempts.set(key, recent);
    this.sweep(oldestAllowed);
    return true;
  }

  private sweep(oldestAllowed: number): void {
    if (this.attempts.size <= SWEEP_THRESHOLD) {
      return;
    }

    for (const [key, timestamps] of this.attempts) {
      if (timestamps.every((at) => at <= oldestAllowed)) {
        this.attempts.delete(key);
      }
    }
  }
}
