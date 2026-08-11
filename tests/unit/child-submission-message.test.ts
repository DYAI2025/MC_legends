import { describe, expect, it } from "vitest";
import {
  childFailureMessage,
  childMessageFor,
  type ChildFailureReason,
} from "@/app/child-submission-message";
import type {
  DeliveryFailureReason,
  DeliveryOutcome,
} from "@/application/submissions/deliver-submission";
import { createTextSubmission, type TextSubmission } from "@/domain/submissions/submission";
import { expectChildSafe } from "../support/child-safe";

const submission: TextSubmission = createTextSubmission(
  { questionId: "companion-animal", originalText: "Mein Tier ist ein Steinwolf." },
  { createId: () => "sub-001", now: () => new Date("2026-08-11T00:00:00.000Z") },
);

/**
 * Hand-maintained list of every failure reason. A new reason has to be added here
 * before it can be tested, and the total table in the module under test makes
 * forgetting it a compile error rather than a silent fallback sentence.
 */
const failureReasons = ["transport", "refused", "local-save"] as const satisfies ReadonlyArray<
  DeliveryFailureReason
>;

/**
 * Every reason a child can be told about, including the one that happens before a
 * delivery is even attempted. Listed by hand so a new reason has to be added here
 * before it can be tested, while the total table in the module makes forgetting it in
 * the source a compile error.
 */
const childFailureReasons = [
  ...failureReasons,
  "not-saved",
] as const satisfies ReadonlyArray<ChildFailureReason>;

function failure(reason: DeliveryFailureReason | undefined): DeliveryOutcome {
  return reason === undefined
    ? { delivered: false, submission }
    : { delivered: false, reason, submission };
}

describe("childMessageFor", () => {
  it("tells a child their answer arrived only when it really did", () => {
    expect(childMessageFor({ delivered: true, submission })).toContain("im Projekt angekommen");

    for (const reason of childFailureReasons) {
      expect(childFailureMessage(reason), `${reason} must not claim arrival`).not.toMatch(
        /\bim Projekt angekommen\b/iu,
      );
    }
  });

  it("gives every failure reason its own non-empty sentence", () => {
    const messages = childFailureReasons.map((reason) => childFailureMessage(reason));

    for (const message of messages) {
      expect(message.trim()).not.toBe("");
    }
    expect(new Set(messages).size, "two reasons must never share one vague sentence").toBe(
      childFailureReasons.length,
    );
  });

  it("says the answer is safe on the device after every failed delivery", () => {
    for (const reason of failureReasons) {
      expect(childFailureMessage(reason)).toContain("auf diesem Gerät");
    }
  });

  it("does not claim the answer is safe when it could not be stored at all", () => {
    // "not-saved" is the one failure where nothing was written anywhere. Promising a
    // child their answer is safe on this device would be the same false comfort that
    // "Im Projekt angekommen" would be after a failed delivery.
    const message = childFailureMessage("not-saved");

    expect(message.trim()).not.toBe("");
    expect(message).not.toContain("auf diesem Gerät");
    expect(message).not.toContain("sicher");
  });

  it("routes a delivery outcome to the message for its own reason", () => {
    for (const reason of failureReasons) {
      expect(childMessageFor(failure(reason))).toBe(childFailureMessage(reason));
    }
  });

  it("still answers when a failure carries no reason at all", () => {
    expect(childMessageFor(failure(undefined)).trim()).not.toBe("");
  });

  it("uses no child-unsafe vocabulary in any message", () => {
    expectChildSafe(childMessageFor({ delivered: true, submission }), "the arrived message");
    for (const reason of childFailureReasons) {
      expectChildSafe(childFailureMessage(reason), `the ${reason} message`);
    }
    expectChildSafe(childMessageFor(failure(undefined)), "the unnamed-failure message");
  });

  it("names no error codes or technical failure detail", () => {
    const messages = childFailureReasons.map((reason) => childFailureMessage(reason));

    for (const message of messages) {
      expect(message, "a child message must carry no numeric code").not.toMatch(/\d/u);
      for (const word of ["Fehlercode", "Verbindung"]) {
        // Not in the shared list: these are plain German a child could meet elsewhere,
        // but in a failure sentence they name the machinery instead of the answer.
        expect(message, `a child message must not mention ${word}`).not.toMatch(
          new RegExp(`\\b${word}\\b`, "iu"),
        );
      }
    }
  });
});
