import { describe, expect, it } from "vitest";
import { childMessageFor } from "@/app/child-submission-message";
import type {
  DeliveryFailureReason,
  DeliveryOutcome,
} from "@/application/submissions/deliver-submission";
import { childUnsafeVocabulary } from "@/content/content-source";
import { createTextSubmission, type TextSubmission } from "@/domain/submissions/submission";

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

function failure(reason: DeliveryFailureReason | undefined): DeliveryOutcome {
  return reason === undefined
    ? { delivered: false, submission }
    : { delivered: false, reason, submission };
}

describe("childMessageFor", () => {
  it("tells a child their answer arrived only when it really did", () => {
    expect(childMessageFor({ delivered: true, submission })).toContain("im Projekt angekommen");

    for (const reason of failureReasons) {
      expect(childMessageFor(failure(reason)), `${reason} must not claim arrival`).not.toMatch(
        /\bim Projekt angekommen\b/iu,
      );
    }
  });

  it("gives every failure reason its own non-empty sentence", () => {
    const messages = failureReasons.map((reason) => childMessageFor(failure(reason)));

    for (const message of messages) {
      expect(message.trim()).not.toBe("");
    }
    expect(new Set(messages).size, "two reasons must never share one vague sentence").toBe(
      failureReasons.length,
    );
  });

  it("says the answer is safe on the device in every failure case", () => {
    for (const reason of failureReasons) {
      expect(childMessageFor(failure(reason))).toContain("auf diesem Gerät");
    }
  });

  it("still answers when a failure carries no reason at all", () => {
    expect(childMessageFor(failure(undefined)).trim()).not.toBe("");
  });

  it("uses no child-unsafe vocabulary in any message", () => {
    const messages = [
      childMessageFor({ delivered: true, submission }),
      ...failureReasons.map((reason) => childMessageFor(failure(reason))),
      childMessageFor(failure(undefined)),
    ];

    for (const message of messages) {
      for (const word of childUnsafeVocabulary) {
        // Word boundaries, not substrings: German "Papier" contains "api" and would
        // otherwise fail a perfectly good sentence. Case-insensitive, because these
        // are authored German sentences where "server" is as unfit as "Server".
        const mention = new RegExp(`\\b${word}\\b`, "iu");
        expect(message, `a child message must not mention ${word}`).not.toMatch(mention);
      }
    }
  });

  it("names no error codes or technical failure detail", () => {
    const messages = failureReasons.map((reason) => childMessageFor(failure(reason)));

    for (const message of messages) {
      expect(message, "a child message must carry no numeric code").not.toMatch(/\d/u);
      for (const word of ["HTTP", "fetch", "Timeout", "Stack", "Fehlercode", "Verbindung"]) {
        expect(message, `a child message must not mention ${word}`).not.toMatch(
          new RegExp(`\\b${word}\\b`, "iu"),
        );
      }
    }
  });
});
