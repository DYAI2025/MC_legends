import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type {
  AudioSendFailureReason,
  AudioSendPhase,
} from "@/adapters/media/audio-answer-sender";
import { audioSendFailureMessage, audioSendPhaseMessage } from "@/app/audio-send-message";
import { expectChildSafe } from "../support/child-safe";

/**
 * What a child reads about sending a recording (MCL-30B).
 *
 * The rule with teeth here is the arrival claim. AGENTS.md forbids "Im Projekt
 * angekommen" without a server acknowledgement, and the sender reaches its `sent` phase
 * only from a receipt - so the claim is safe exactly as long as no OTHER sentence in this
 * table makes it. That is asserted below rather than reviewed, because the sentence that
 * would break it is a one-word edit in a file full of reassuring German.
 */

const phases: readonly AudioSendPhase[] = ["idle", "sending", "sent", "failed"];

const reasons: readonly AudioSendFailureReason[] = [
  "transport",
  "unavailable",
  "rate-limited",
  "unauthorized",
  "refused",
  "audio-too-large",
  "audio-type-unsupported",
  "audio-unreadable",
];

/** Words that would claim the recording is with the project, in any spelling a child reads. */
const arrivalClaims = ["angekommen", "gespeichert", "abgeschickt", "gesendet", "geschickt"];

describe("audio send messages", () => {
  it("has a sentence for every phase and every failure", () => {
    for (const phase of phases) {
      expect(audioSendPhaseMessage(phase).trim().length, phase).toBeGreaterThan(0);
    }

    for (const reason of reasons) {
      expect(audioSendFailureMessage(reason).trim().length, reason).toBeGreaterThan(0);
    }
  });

  it("keeps every sentence child-safe", () => {
    for (const phase of phases) {
      expectChildSafe(audioSendPhaseMessage(phase), `the ${phase} phase message`);
    }

    for (const reason of reasons) {
      expectChildSafe(audioSendFailureMessage(reason), `the ${reason} failure message`);
    }
  });

  it("claims arrival in exactly one sentence, and it is the one a receipt produces", () => {
    expect(audioSendPhaseMessage("sent")).toContain("angekommen");

    for (const phase of phases.filter((candidate) => candidate !== "sent")) {
      const message = audioSendPhaseMessage(phase).toLowerCase();
      for (const claim of arrivalClaims) {
        expect(message, `the ${phase} phase message must not say "${claim}"`).not.toContain(claim);
      }
    }
  });

  it("never claims arrival in a failure sentence", () => {
    for (const reason of reasons) {
      const message = audioSendFailureMessage(reason).toLowerCase();
      for (const claim of arrivalClaims) {
        expect(message, `the ${reason} message must not say "${claim}"`).not.toContain(claim);
      }
    }
  });

  it("tells a child their recording survived every failure", () => {
    // The reassurance is in the phase line rather than repeated in each reason, so it is
    // asserted where it lives - a `failed` sentence that stopped saying this would leave
    // eight failure messages that all read like the recording is gone.
    expect(audioSendPhaseMessage("failed")).toContain("noch da");
  });

  it("offers a next step in every failure sentence", () => {
    // Except the one a retry cannot fix. `refused` deliberately asks for a new recording
    // instead of inviting a retry that will be declined identically.
    for (const reason of reasons.filter((candidate) => candidate !== "refused")) {
      expect(
        audioSendFailureMessage(reason).toLowerCase(),
        `the ${reason} message must tell a child what to do next`,
      ).toMatch(/noch einmal|nimm|such|warte/u);
    }

    expect(audioSendFailureMessage("refused").toLowerCase()).toMatch(/nimm|such/u);
    expect(audioSendFailureMessage("refused").toLowerCase()).not.toContain("noch einmal");
  });

  it("is a total table, so a new phase or reason cannot fall through to silence", async () => {
    // The `satisfies Record<Union, string>` is what makes that a compile error rather than
    // a blank line on the page, and it is the property this file cannot observe at
    // runtime - a missing key would only show as an undefined nobody rendered.
    const source = await readFile("src/app/audio-send-message.ts", "utf8");

    expect(source).toContain("as const satisfies Record<AudioSendPhase, string>");
    expect(source).toContain("as const satisfies Record<AudioSendFailureReason, string>");
  });
});
