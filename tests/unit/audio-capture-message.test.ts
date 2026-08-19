import { describe, expect, it } from "vitest";
import type {
  AudioCaptureFailureReason,
  AudioCapturePhase,
} from "@/adapters/media/audio-capture-controller";
import {
  audioCaptureFailureMessage,
  audioCapturePhaseMessage,
} from "@/app/audio-capture-message";
import { expectChildSafe } from "../support/child-safe";

/**
 * MCL-30A. Pins the two properties of the recording copy that a compiler cannot see:
 * that a child never reads browser vocabulary, and that no sentence claims the
 * recording went anywhere. There is no server path for audio in this slice, so a
 * sentence promising arrival would be the one lie this whole area is built to avoid.
 */

const phases: readonly AudioCapturePhase[] = [
  "ready",
  "requesting-permission",
  "recording",
  "recorded",
  "error",
];

const failures: readonly AudioCaptureFailureReason[] = [
  "recording-unsupported",
  "microphone-unavailable",
  "permission-denied",
  "recording-failed",
  "empty-recording",
  "file-not-audio",
];

/** Words that would claim delivery, storage or receipt - none of which happens yet. */
const arrivalClaims = [
  "angekommen",
  "geschickt",
  "gesendet",
  "hochgeladen",
  "im Projekt",
  "gespeichert",
];

describe("audio capture messages", () => {
  it("answers every phase with a sentence a child can read", () => {
    for (const phase of phases) {
      const message = audioCapturePhaseMessage(phase);
      expect(message.length, phase).toBeGreaterThan(0);
      expectChildSafe(message, `phase message for ${phase}`);
    }
  });

  it("answers every failure with a sentence a child can read", () => {
    for (const reason of failures) {
      const message = audioCaptureFailureMessage(reason);
      expect(message.length, reason).toBeGreaterThan(0);
      expectChildSafe(message, `failure message for ${reason}`);
    }
  });

  it("never tells a child the recording reached the project", () => {
    for (const message of [
      ...phases.map(audioCapturePhaseMessage),
      ...failures.map(audioCaptureFailureMessage),
    ]) {
      for (const claim of arrivalClaims) {
        expect(message.toLowerCase(), message).not.toContain(claim.toLowerCase());
      }
    }
  });

  it("says something different for each failure, so the advice is usable", () => {
    const messages = failures.map(audioCaptureFailureMessage);
    expect(new Set(messages).size).toBe(failures.length);
  });

  it("points at the file fallback whenever the microphone cannot be used", () => {
    for (const reason of [
      "recording-unsupported",
      "microphone-unavailable",
      "permission-denied",
    ] as const) {
      expect(audioCaptureFailureMessage(reason), reason).toContain("Tondatei");
    }
  });
});
