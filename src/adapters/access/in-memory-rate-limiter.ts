import type { RateLimiter } from "@/application/access/rate-limiter";

/**
 * Hard ceiling on how many distinct keys this limiter will ever hold at once.
 *
 * A sweep alone was not a bound: it only removed keys whose attempts had aged out, so a
 * caller producing fresh keys faster than the window expires kept the map growing. Once
 * this many keys are tracked and none of them are stale, a key never seen before is
 * refused rather than admitted, because admitting it would mean admitting it untracked.
 */
const DEFAULT_MAX_TRACKED_KEYS = 5_000;

export type InMemoryRateLimiterOptions = Readonly<{
  limit: number;
  windowMs: number;
  /** Hard cap on concurrently tracked keys. Defaults to {@link DEFAULT_MAX_TRACKED_KEYS}. */
  maxTrackedKeys?: number;
  now?: () => number;
}>;

/**
 * Sliding-window counter held in this process's memory.
 *
 * Deliberately NOT production-grade and not to be described as such:
 * - process-local, so two instances of the app allow the limit each,
 * - not distributed and not shared with any other service,
 * - a restart forgets every counter, so the allowance resets,
 * - bounded in memory by refusing new keys at capacity, which means a flood of
 *   made-up keys can deny service to a caller this process has not seen before.
 *   That trade is taken on purpose: refusing is recoverable, unbounded growth is not.
 *
 * It is an MVP abuse brake for a private family site, and it is testable, which is
 * what MCL-34 asks for. A shared limiter belongs with the durable backend work.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly attempts = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxTrackedKeys: number;
  private readonly now: () => number;

  constructor(options: InMemoryRateLimiterOptions) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.maxTrackedKeys = options.maxTrackedKeys ?? DEFAULT_MAX_TRACKED_KEYS;
    this.now = options.now ?? Date.now;
  }

  tryConsume(key: string): boolean {
    const now = this.now();
    const oldestAllowed = now - this.windowMs;
    const known = this.attempts.get(key);

    if (known === undefined && !this.hasRoomForNewKey(oldestAllowed)) {
      // Fail closed. Nothing is stored for this key, so this refusal costs no memory
      // either - which is the whole point of refusing it.
      return false;
    }

    const recent = (known ?? []).filter((at) => at > oldestAllowed);

    if (recent.length >= this.limit) {
      // Stored without the refused attempt: counting it would let a caller that is
      // already over the limit keep pushing its own window forward forever.
      this.attempts.set(key, recent);
      return false;
    }

    recent.push(now);
    this.attempts.set(key, recent);
    return true;
  }

  /** Stale entries are reclaimed first; only a genuinely full map refuses. */
  private hasRoomForNewKey(oldestAllowed: number): boolean {
    if (this.attempts.size < this.maxTrackedKeys) {
      return true;
    }

    this.sweepStale(oldestAllowed);
    return this.attempts.size < this.maxTrackedKeys;
  }

  private sweepStale(oldestAllowed: number): void {
    for (const [key, timestamps] of this.attempts) {
      if (timestamps.every((at) => at <= oldestAllowed)) {
        this.attempts.delete(key);
      }
    }
  }
}
