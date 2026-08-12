import { describe, expect, it } from "vitest";
import { familyGateMessage } from "@/app/family-gate-message";
import type { FamilySessionAttempt } from "@/application/access/family-session-client";
import { expectChildSafe } from "../support/child-safe";

const attempts: ReadonlyArray<FamilySessionAttempt> = [
  "granted",
  "denied",
  "rate-limited",
  "unavailable",
  "transport",
];

describe("familyGateMessage", () => {
  it("has a sentence for every outcome", () => {
    for (const attempt of attempts) {
      expect(familyGateMessage(attempt).trim().length, attempt).toBeGreaterThan(0);
    }
  });

  it("keeps every sentence free of security and delivery vocabulary", () => {
    for (const attempt of attempts) {
      expectChildSafe(familyGateMessage(attempt), `the sign-in message for "${attempt}"`);
    }
  });

  it("never leaks a status code or an internal outcome name to a child", () => {
    for (const attempt of attempts) {
      const message = familyGateMessage(attempt);
      expect(message, attempt).not.toMatch(/\b(401|403|429|503|cookie|token|session)\b/iu);
      expect(message, attempt).not.toContain(attempt);
    }
  });

  it("tells the four failures apart", () => {
    const failures = attempts.filter((attempt) => attempt !== "granted");
    const messages = failures.map((attempt) => familyGateMessage(attempt));

    // A wrong code, a pause, a broken gate and an unreachable one need different
    // reactions from a family; one shared sentence would hide which of them happened.
    expect(new Set(messages).size).toBe(failures.length);
  });
});
