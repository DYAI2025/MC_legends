import { describe, expect, it } from "vitest";
import {
  AudioAnswerInboxError,
  type AudioAnswerDraft,
  type AudioAnswerInbox,
  type AudioInboxFailureReason,
} from "@/application/media/audio-answer-inbox";
import {
  AudioAnswerSender,
  type AudioSendFailureReason,
  type AudioSendState,
} from "@/adapters/media/audio-answer-sender";
import type { CapturedAudio } from "@/adapters/media/audio-capture-controller";
import { MAX_AUDIO_BYTES } from "@/domain/media/audio-artifact";
import type { ServerReceipt } from "@/domain/submissions/submission";
import { ELF, HTML, MP3_ID3, MP4, OGG, WAV, WEBM } from "../support/audio-fixtures";

/**
 * The send machine behind MCL-30B, exercised without React, without a network and without
 * a microphone.
 *
 * Three properties are what this file exists for, and none of them is visible from a green
 * happy path:
 *
 * 1. `sent` is reachable ONLY from a receipt. Every other outcome - including a positive
 *    answer the inbox refused to read as one - leaves the recording unsent and retryable.
 * 2. One recording carries ONE submissionId, however many times it is sent. That is the
 *    whole of the ambiguous-timeout answer: the route is idempotent by that value, so a
 *    retry after an attempt that may already have landed converges on the receipt the
 *    server minted rather than leaving a second copy of one answer behind.
 * 3. A recording is never taken away by a failure. A child must be able to press the
 *    button again without recording anything a second time.
 */

const RECEIPT: ServerReceipt = {
  receiptId: "receipt-audio-1",
  receivedAt: "2026-08-22T09:00:01.000Z",
};

const QUESTION = "companion-animal";

/** Deterministic dependencies: a counter and a fixed clock, so the ids are readable. */
function dependencies(): { createId: () => string; now: () => Date } {
  let issued = 0;
  return {
    createId: () => `id-${++issued}`,
    now: () => new Date("2026-08-22T09:00:00.000Z"),
  };
}

function capture(
  bytes: Uint8Array<ArrayBuffer>,
  overrides: Partial<{ type: string; source: "microphone" | "file"; fileName: string | null }> = {},
): CapturedAudio {
  return {
    blob: new Blob([bytes], { type: overrides.type ?? "audio/webm;codecs=opus" }),
    previewUrl: "blob:preview",
    source: overrides.source ?? "microphone",
    fileName: overrides.fileName ?? null,
  };
}

/** An inbox that records what it was handed and answers however the case wants. */
function inboxThat(answer: (attempt: number) => Promise<ServerReceipt>): {
  drafts: AudioAnswerDraft[];
  inbox: AudioAnswerInbox;
} {
  const drafts: AudioAnswerDraft[] = [];
  return {
    drafts,
    inbox: {
      deliver: (draft) => {
        drafts.push(draft);
        return answer(drafts.length);
      },
    },
  };
}

const acknowledging = () => inboxThat(async () => RECEIPT);

const refusingWith = (reason: AudioInboxFailureReason) =>
  inboxThat(async () => {
    throw new AudioAnswerInboxError(reason);
  });

/** The inbox that must never be reached, for the cases decided before any request. */
const unreachableInbox: AudioAnswerInbox = {
  deliver: () => {
    throw new Error("the inbox must not be called for a recording refused locally");
  },
};

function senderFor(inbox: AudioAnswerInbox): AudioAnswerSender {
  return new AudioAnswerSender(inbox, dependencies());
}

describe("AudioAnswerSender", () => {
  it("starts idle and claims nothing", () => {
    const state = senderFor(unreachableInbox).snapshot();

    expect(state).toEqual<AudioSendState>({
      phase: "idle",
      failure: null,
      receipt: null,
      recording: null,
    });
  });

  it("reaches sent only with a receipt, and carries the one it was given", async () => {
    const { inbox, drafts } = acknowledging();
    const sender = senderFor(inbox);
    const recording = capture(WEBM);

    await sender.send(recording, QUESTION);

    const state = sender.snapshot();
    expect(state.phase).toBe("sent");
    expect(state.receipt).toEqual(RECEIPT);
    expect(state.failure).toBeNull();
    expect(state.recording).toBe(recording);

    // And the recording itself went, untouched.
    expect(drafts).toHaveLength(1);
    expect(drafts[0].bytes).toBe(recording.blob);
    expect(drafts[0].questionId).toBe(QUESTION);
    expect(drafts[0].createdAt).toBe("2026-08-22T09:00:00.000Z");
  });

  it("declares what the bytes are, not what the browser labelled them", async () => {
    const { inbox, drafts } = acknowledging();
    const sender = senderFor(inbox);

    // A Chromium recording arrives as `audio/webm;codecs=opus`, which is not an allowlist
    // member; the route refuses anything whose declared type is not one. Sniffing makes
    // the declaration agree with what the route will compute, by construction.
    await sender.send(capture(WEBM, { type: "audio/webm;codecs=opus" }), QUESTION);
    expect(drafts[0].mimeType).toBe("audio/webm");
  });

  it.each([
    { name: "webm", bytes: WEBM, label: "audio/webm;codecs=opus", expected: "audio/webm" },
    { name: "ogg", bytes: OGG, label: "audio/ogg", expected: "audio/ogg" },
    { name: "m4a with a vendor label", bytes: MP4, label: "audio/x-m4a", expected: "audio/mp4" },
    { name: "mp3 with no label at all", bytes: MP3_ID3, label: "", expected: "audio/mpeg" },
    { name: "wav", bytes: WAV, label: "audio/wav", expected: "audio/wav" },
  ])("sends a chosen $name down the same path as a recording", async ({ bytes, label, expected }) => {
    const { inbox, drafts } = acknowledging();
    const sender = senderFor(inbox);

    await sender.send(capture(bytes, { type: label, source: "file", fileName: "ton.dat" }), QUESTION);

    expect(sender.snapshot().phase).toBe("sent");
    // The vendor spelling and the empty label are the two cases a browser really produces
    // for a picked file, and both would be refused by the route if they were forwarded.
    expect(drafts[0].mimeType).toBe(expected);
  });

  it("reuses one submissionId for every attempt at one recording", async () => {
    let attempts = 0;
    const { inbox, drafts } = inboxThat(async () => {
      attempts += 1;
      // The ambiguous case: the first attempt never produced an answer, so the client
      // cannot know whether the server stored it. The second one succeeds.
      if (attempts === 1) throw new AudioAnswerInboxError("transport");
      return RECEIPT;
    });

    const sender = senderFor(inbox);
    const recording = capture(WEBM);

    await sender.send(recording, QUESTION);
    expect(sender.snapshot().phase).toBe("failed");
    expect(sender.snapshot().failure).toBe("transport");
    // The recording is still the one in hand: nothing was consumed by the failure.
    expect(sender.snapshot().recording).toBe(recording);

    await sender.send(recording, QUESTION);
    expect(sender.snapshot().phase).toBe("sent");

    expect(drafts).toHaveLength(2);
    expect(drafts[0].submissionId).toBe(drafts[1].submissionId);
    expect(drafts[0].createdAt).toBe(drafts[1].createdAt);
    // Exactly one id was ever minted, however many times the child pressed the button.
    expect(drafts[0].submissionId).toBe("id-1");
  });

  it("gives a different recording a different submissionId", async () => {
    const { inbox, drafts } = acknowledging();
    const sender = senderFor(inbox);

    const first = capture(WEBM);
    await sender.send(first, QUESTION);
    await sender.send(capture(OGG), QUESTION);

    expect(drafts.map((draft) => draft.submissionId)).toEqual(["id-1", "id-2"]);
    // And the first id is still the first recording's, not reassigned.
    expect(sender.submissionIdFor(first)).toBeNull();
  });

  it("ignores a second press while the first attempt is still open", async () => {
    // Initialised rather than left null: assigning inside the executor narrows a
    // `null` initialiser to `never`, and the call below then does not typecheck.
    let release = (): void => {};
    const { inbox, drafts } = inboxThat(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return RECEIPT;
    });

    const sender = senderFor(inbox);
    const recording = capture(WEBM);

    const first = sender.send(recording, QUESTION);
    // Let the size check and the sniff settle so the attempt is genuinely in flight.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(sender.snapshot().phase).toBe("sending");

    await sender.send(recording, QUESTION);
    release();
    await first;

    // One recording, one press that counted: a double click must not put two rows in the
    // project, and must not race two answers into the same sentence.
    expect(drafts).toHaveLength(1);
    expect(sender.snapshot().phase).toBe("sent");
  });

  it("does not send a recording that already arrived", async () => {
    const { inbox, drafts } = acknowledging();
    const sender = senderFor(inbox);
    const recording = capture(WEBM);

    await sender.send(recording, QUESTION);
    await sender.send(recording, QUESTION);

    expect(drafts).toHaveLength(1);
  });

  it("drops the outcome of an attempt the child has moved on from", async () => {
    const answers: Array<(receipt: ServerReceipt) => void> = [];
    const { inbox } = inboxThat(
      () => new Promise<ServerReceipt>((resolve) => answers.push(resolve)),
    );

    const sender = senderFor(inbox);
    const abandoned = capture(WEBM);
    const current = capture(OGG);

    const first = sender.send(abandoned, QUESTION);
    await settle();
    const second = sender.send(current, QUESTION);
    await settle();

    // The abandoned attempt answers last. Its outcome must not land on the page the child
    // is looking at, which is showing the recording that replaced it.
    answers[1]({ receiptId: "receipt-current", receivedAt: RECEIPT.receivedAt });
    answers[0]({ receiptId: "receipt-abandoned", receivedAt: RECEIPT.receivedAt });
    await Promise.all([first, second]);

    expect(sender.snapshot().recording).toBe(current);
    expect(sender.snapshot().receipt?.receiptId).toBe("receipt-current");
  });

  it.each([
    ["transport", "transport"],
    ["unavailable", "unavailable"],
    ["rate-limited", "rate-limited"],
    ["unauthorized", "unauthorized"],
    ["refused", "refused"],
  ] as const)("reports the inbox's %s as %s and keeps the recording", async (reason, expected) => {
    const { inbox } = refusingWith(reason);
    const sender = senderFor(inbox);
    const recording = capture(WEBM);

    await sender.send(recording, QUESTION);

    const state = sender.snapshot();
    expect(state.phase).toBe("failed");
    expect(state.failure).toBe<AudioSendFailureReason>(expected);
    expect(state.receipt).toBeNull();
    expect(state.recording).toBe(recording);
  });

  it("treats a failure it cannot name as retryable rather than final", async () => {
    const { inbox } = inboxThat(async () => {
      throw new TypeError("something nobody classified");
    });

    const sender = senderFor(inbox);
    await sender.send(capture(WEBM), QUESTION);

    // Reporting a passing fault as permanent would tell a child to record something new
    // when the recording they have is fine.
    expect(sender.snapshot().failure).toBe("transport");
  });

  it("refuses a recording over the product ceiling without spending a child's connection", async () => {
    const sender = senderFor(unreachableInbox);
    const oversized: CapturedAudio = {
      ...capture(WEBM),
      blob: new Blob([new Uint8Array(MAX_AUDIO_BYTES + 1)], { type: "audio/webm" }),
    };

    await sender.send(oversized, QUESTION);

    expect(sender.snapshot().phase).toBe("failed");
    expect(sender.snapshot().failure).toBe("audio-too-large");
    // And the recording is still there: the child is asked for a shorter one, not told
    // theirs was thrown away.
    expect(sender.snapshot().recording).toBe(oversized);
  });

  it("accepts a recording of exactly the ceiling", async () => {
    // `>` and not `>=`: the documented maximum has to be sendable, or the largest
    // legitimate recording is refused with no way to tell that from a genuine overrun.
    const bytes = new Uint8Array(MAX_AUDIO_BYTES);
    bytes.set(WEBM.slice(0, 8), 0);

    const { inbox, drafts } = acknowledging();
    const sender = senderFor(inbox);

    await sender.send({ ...capture(WEBM), blob: new Blob([bytes], { type: "audio/webm" }) }, QUESTION);

    expect(sender.snapshot().phase).toBe("sent");
    expect(drafts).toHaveLength(1);
  });

  it.each([
    ["an HTML document", HTML],
    ["an executable", ELF],
  ])("refuses %s before it is uploaded", async (_name, bytes) => {
    const sender = senderFor(unreachableInbox);

    await sender.send(capture(bytes, { type: "audio/webm", source: "file" }), QUESTION);

    // The label said audio; the bytes did not. Refused here rather than sent for the
    // route to refuse, because the answer is already knowable from sixteen bytes.
    expect(sender.snapshot().failure).toBe("audio-type-unsupported");
  });

  it("says so when the chosen file can no longer be read", async () => {
    const sender = senderFor(unreachableInbox);
    const unreadable: CapturedAudio = {
      ...capture(WEBM),
      blob: {
        size: 64,
        type: "audio/webm",
        slice: () => ({ arrayBuffer: () => Promise.reject(new Error("gone")) }),
      } as unknown as Blob,
    };

    await sender.send(unreadable, QUESTION);

    // Distinct from "not audio": the child's next step is to choose the file again, not
    // to choose a different one.
    expect(sender.snapshot().failure).toBe("audio-unreadable");
  });

  it("lets a child put a failure aside without minting a second answer", async () => {
    const { inbox, drafts } = inboxThat(async (attempt) => {
      if (attempt === 1) throw new AudioAnswerInboxError("rate-limited");
      return RECEIPT;
    });

    const sender = senderFor(inbox);
    const recording = capture(WEBM);

    await sender.send(recording, QUESTION);
    expect(sender.snapshot().phase).toBe("failed");

    sender.dismissFailure();
    expect(sender.snapshot().phase).toBe("idle");
    expect(sender.snapshot().failure).toBeNull();
    // Still about the same recording, so the area does not fall back to "no recording".
    expect(sender.snapshot().recording).toBe(recording);

    await sender.send(recording, QUESTION);
    expect(drafts[0].submissionId).toBe(drafts[1].submissionId);
  });

  it("tells its subscribers about every change and stops when they leave", async () => {
    const { inbox } = acknowledging();
    const sender = senderFor(inbox);
    const seen: string[] = [];
    const unsubscribe = sender.subscribe(() => seen.push(sender.snapshot().phase));

    await sender.send(capture(WEBM), QUESTION);
    expect(seen).toEqual(["sending", "sent"]);

    unsubscribe();
    await sender.send(capture(OGG), QUESTION);
    expect(seen).toEqual(["sending", "sent"]);
  });
});

/** Lets the size check, the sniff and the inbox call all reach their first await. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
}
