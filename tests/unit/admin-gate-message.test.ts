import { describe, expect, it } from "vitest";
import { adminGateMessage } from "@/app/admin-gate-message";
import type { FamilySessionAttempt } from "@/application/access/family-session-client";

const attempts: FamilySessionAttempt[] = [
  "granted",
  "denied",
  "rate-limited",
  "unavailable",
  "transport",
];

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
    }
  });
});
