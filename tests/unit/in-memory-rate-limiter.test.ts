import { describe, expect, it } from "vitest";
import { InMemoryRateLimiter } from "@/adapters/access/in-memory-rate-limiter";

function limiterAt(clock: { value: number }, limit = 3, windowMs = 1000) {
  return new InMemoryRateLimiter({ limit, windowMs, now: () => clock.value });
}

describe("InMemoryRateLimiter", () => {
  it("allows exactly the configured number of attempts inside the window", () => {
    const clock = { value: 0 };
    const limiter = limiterAt(clock);

    expect([limiter.tryConsume("a"), limiter.tryConsume("a"), limiter.tryConsume("a")]).toEqual([
      true,
      true,
      true,
    ]);
    expect(limiter.tryConsume("a")).toBe(false);
  });

  it("counts each key on its own", () => {
    const clock = { value: 0 };
    const limiter = limiterAt(clock);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      limiter.tryConsume("a");
    }

    expect(limiter.tryConsume("a")).toBe(false);
    expect(limiter.tryConsume("b")).toBe(true);
  });

  it("lets a caller through again once the window has passed", () => {
    const clock = { value: 0 };
    const limiter = limiterAt(clock);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      limiter.tryConsume("a");
    }
    expect(limiter.tryConsume("a")).toBe(false);

    clock.value = 1001;
    expect(limiter.tryConsume("a")).toBe(true);
  });

  it("does not let a refused attempt push the window forward", () => {
    const clock = { value: 0 };
    const limiter = limiterAt(clock);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      limiter.tryConsume("a");
    }

    // Hammering at the very end of the window must not extend the block past it: if
    // refused attempts were recorded, the caller below would still be locked out.
    clock.value = 999;
    expect(limiter.tryConsume("a")).toBe(false);

    clock.value = 1001;
    expect(limiter.tryConsume("a")).toBe(true);
  });

  it("slides rather than resetting in blocks", () => {
    const clock = { value: 0 };
    const limiter = limiterAt(clock);

    limiter.tryConsume("a");
    clock.value = 500;
    limiter.tryConsume("a");
    limiter.tryConsume("a");
    expect(limiter.tryConsume("a")).toBe(false);

    // The first attempt has aged out, the two at 500 have not: exactly one slot frees.
    clock.value = 1001;
    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(false);
  });
});
