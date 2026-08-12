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

  it("refuses a new key once the tracked-key capacity is reached instead of growing", () => {
    const clock = { value: 0 };
    const limiter = new InMemoryRateLimiter({
      limit: 5,
      windowMs: 1000,
      maxTrackedKeys: 3,
      now: () => clock.value,
    });

    expect([limiter.tryConsume("a"), limiter.tryConsume("b"), limiter.tryConsume("c")]).toEqual([
      true,
      true,
      true,
    ]);

    // No room to track a fourth caller, so it fails closed rather than being admitted
    // untracked - an untracked caller would be an unlimited one.
    expect(limiter.tryConsume("d")).toBe(false);

    // A caller already tracked still gets the rest of its own allowance.
    expect(limiter.tryConsume("a")).toBe(true);
  });

  it("cannot be grown without bound by a flood of fresh unique keys", () => {
    const clock = { value: 0 };
    const limiter = new InMemoryRateLimiter({
      limit: 1,
      windowMs: 1000,
      maxTrackedKeys: 8,
      now: () => clock.value,
    });

    // Exactly the spoofing shape: every attempt arrives under a key never seen before.
    let admitted = 0;
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      if (limiter.tryConsume(`spoofed-${attempt}`)) {
        admitted += 1;
      }
    }

    expect(admitted).toBe(8);
  });

  it("reclaims capacity from keys whose attempts have all aged out", () => {
    const clock = { value: 0 };
    const limiter = new InMemoryRateLimiter({
      limit: 5,
      windowMs: 1000,
      maxTrackedKeys: 3,
      now: () => clock.value,
    });

    for (const key of ["a", "b", "c"]) {
      limiter.tryConsume(key);
    }
    expect(limiter.tryConsume("d")).toBe(false);

    // Once the three tracked windows have passed, the space they hold is stale and a
    // new caller must get it - the bound is a memory bound, not a permanent lockout.
    clock.value = 1001;
    expect(limiter.tryConsume("d")).toBe(true);
  });
});
