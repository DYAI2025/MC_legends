import { describe, expect, it } from "vitest";
import { adminGateMessage } from "@/app/admin-gate-message";
import type { FamilySessionAttempt } from "@/application/access/family-session-client";

/**
 * Derived from a Record the compiler must see every member of, not written out as a
 * plain literal. A literal list keeps compiling when FamilySessionAttempt grows, so the
 * table under test would gain an outcome that no case here ever reads - the message table
 * itself fails to compile, but this file would go on claiming to cover every outcome.
 */
const attempts = Object.keys({
  granted: null,
  denied: null,
  "rate-limited": null,
  unavailable: null,
  transport: null,
} satisfies Record<FamilySessionAttempt, null>) as FamilySessionAttempt[];

describe("adminGateMessage", () => {
  it("has a sentence for every outcome", () => {
    for (const attempt of attempts) {
      expect(adminGateMessage(attempt).trim().length, attempt).toBeGreaterThan(0);
    }
  });

  it("never names a secret, a variable or a status code", () => {
    // An admin reads these, so they may be plainer than the child copy - but a refusal
    // that quotes the environment variable it could not find is a refusal that tells a
    // stranger exactly what to look for.
    for (const attempt of attempts) {
      expect(adminGateMessage(attempt)).not.toMatch(/AVALORIA_|process\.env|401|429|503/u);
      // Nor the internal outcome name: "transport" and "rate-limited" are our vocabulary
      // for our own states, and echoing one into the panel turns a message for a person
      // into a leak of how the check is wired.
      expect(adminGateMessage(attempt), attempt).not.toContain(attempt);
    }
  });

  it("tells the four failures apart", () => {
    const failures = attempts.filter((attempt) => attempt !== "granted");
    const messages = failures.map((attempt) => adminGateMessage(attempt));

    // A wrong code, a pause, an unconfigured gate and an unreachable one each need a
    // different move from the adult reading this; one shared sentence would hide which
    // of them happened, and send them to the deployment for a typo.
    expect(new Set(messages).size).toBe(failures.length);
  });
});
