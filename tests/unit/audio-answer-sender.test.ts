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

/**
 * Binds a recording to its question and sends it, the way the recording area does: the
 * question is chosen when the recording appears, and the send that follows carries no
 * question at all. Two calls rather than one, because that separation is the fix - a
 * helper that took both and passed both would be the old API wearing a different name.
 */
async function prepareAndSend(
  sender: AudioAnswerSender,
  recording: CapturedAudio,
  questionId: string = QUESTION,
): Promise<void> {
  sender.prepare(recording, questionId);
  await sender.send(recording);
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

    await prepareAndSend(sender, recording);

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
    await prepareAndSend(sender, capture(WEBM, { type: "audio/webm;codecs=opus" }));
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

    await prepareAndSend(sender, capture(bytes, { type: label, source: "file", fileName: "ton.dat" }));

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

    await prepareAndSend(sender, recording);
    expect(sender.snapshot().phase).toBe("failed");
    expect(sender.snapshot().failure).toBe("transport");
    // The recording is still the one in hand: nothing was consumed by the failure.
    expect(sender.snapshot().recording).toBe(recording);

    await prepareAndSend(sender, recording);
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
    await prepareAndSend(sender, first);
    await prepareAndSend(sender, capture(OGG));

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

    const first = prepareAndSend(sender, recording);
    // Let the size check and the sniff settle so the attempt is genuinely in flight.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(sender.snapshot().phase).toBe("sending");

    await prepareAndSend(sender, recording);
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

    await prepareAndSend(sender, recording);
    await prepareAndSend(sender, recording);

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

    const first = prepareAndSend(sender, abandoned);
    await settle();
    const second = prepareAndSend(sender, current);
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

    await prepareAndSend(sender, recording);

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
    await prepareAndSend(sender, capture(WEBM));

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

    await prepareAndSend(sender, oversized);

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

    await prepareAndSend(sender, { ...capture(WEBM), blob: new Blob([bytes], { type: "audio/webm" }) });

    expect(sender.snapshot().phase).toBe("sent");
    expect(drafts).toHaveLength(1);
  });

  it.each([
    ["an HTML document", HTML],
    ["an executable", ELF],
  ])("refuses %s before it is uploaded", async (_name, bytes) => {
    const sender = senderFor(unreachableInbox);

    await prepareAndSend(sender, capture(bytes, { type: "audio/webm", source: "file" }));

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

    await prepareAndSend(sender, unreadable);

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

    await prepareAndSend(sender, recording);
    expect(sender.snapshot().phase).toBe("failed");

    sender.dismissFailure();
    expect(sender.snapshot().phase).toBe("idle");
    expect(sender.snapshot().failure).toBeNull();
    // Still about the same recording, so the area does not fall back to "no recording".
    expect(sender.snapshot().recording).toBe(recording);

    await prepareAndSend(sender, recording);
    expect(drafts[0].submissionId).toBe(drafts[1].submissionId);
  });

  it("tells its subscribers about every change and stops when they leave", async () => {
    const { inbox } = acknowledging();
    const sender = senderFor(inbox);
    const seen: string[] = [];
    const unsubscribe = sender.subscribe(() => seen.push(sender.snapshot().phase));

    await prepareAndSend(sender, capture(WEBM));
    // Three, not two: binding a recording is itself a published change since MCL-35.
    // It has to be, because the binding lives in private state that no snapshot exposes,
    // and the recording area only learns it may offer the send button by re-rendering.
    // A silent `prepare` would leave the button disabled until something else happened.
    expect(seen).toEqual(["idle", "sending", "sent"]);

    unsubscribe();
    await prepareAndSend(sender, capture(OGG));
    expect(seen).toEqual(["idle", "sending", "sent"]);
  });
});

/**
 * MCL-35. A recording answers the question it was made for, and nothing that happens
 * afterwards can re-aim it.
 *
 * This is the hazard MCL-30 handed over: `send` used to take the question as a parameter,
 * so every attempt re-stated it - and the recording area passed whatever the page was
 * asking at that moment. A recording captured while A was being asked, sent after an
 * adult closed A, went to the project as an answer to B. Nothing would have looked wrong
 * anywhere: the child spoke about A, the project filed it under B.
 *
 * The cases below are written so that they FAIL if the binding ever moves back to send
 * time, rather than merely passing while it happens to be right.
 */
describe("AudioAnswerSender question binding", () => {
  const LATER_QUESTION = "druhen-protection";

  it("sends the question the recording was bound to, not the one asked later", async () => {
    const { inbox, drafts } = acknowledging();
    const sender = senderFor(inbox);
    const recording = capture(WEBM);

    // Bound while A is being asked.
    sender.prepare(recording, QUESTION);
    // The page rotates: an adult closed A, so the recorder's effect runs again with B.
    sender.prepare(recording, LATER_QUESTION);

    await sender.send(recording);

    expect(drafts).toHaveLength(1);
    expect(drafts[0].questionId).toBe(QUESTION);
    expect(sender.boundQuestionIdFor(recording)).toBe(QUESTION);
  });

  it("keeps both the submissionId and the question across an ambiguous retry", async () => {
    let attempts = 0;
    const { inbox, drafts } = inboxThat(async () => {
      attempts += 1;
      // The dangerous shape: the first attempt never produced an answer, so this browser
      // cannot know whether the project already holds the recording.
      if (attempts === 1) throw new AudioAnswerInboxError("transport");
      return RECEIPT;
    });

    const sender = senderFor(inbox);
    const recording = capture(WEBM);

    sender.prepare(recording, QUESTION);
    await sender.send(recording);
    expect(sender.snapshot().phase).toBe("failed");

    // Rotation happens between the failure and the retry - the worst possible moment,
    // and the one a child is most likely to hit, because a failure is exactly when they
    // leave the page open and come back.
    sender.prepare(recording, LATER_QUESTION);
    await sender.send(recording);

    expect(drafts).toHaveLength(2);
    // Same answer, twice attempted: the route is idempotent by submissionId, so this is
    // what makes the retry converge on one stored answer instead of filing a second.
    expect(drafts[0].submissionId).toBe(drafts[1].submissionId);
    expect(drafts[0].createdAt).toBe(drafts[1].createdAt);
    // And it converges under the SAME question. Without this, a retry after rotation
    // would produce one answer to A and one to B for one spoken sentence.
    expect(drafts.map((draft) => draft.questionId)).toEqual([QUESTION, QUESTION]);
  });

  it("offers no parameter through which a later question could enter a send", async () => {
    // The structural countertest. Every behavioural case above could be satisfied by a
    // guard inside `send`; this one cannot - it fails the moment the parameter comes
    // back, whatever the body of the method then does with it.
    const sender = senderFor(unreachableInbox);

    expect(sender.send.length).toBe(1);
    expect(sender.prepare.length).toBe(2);
  });

  it("does nothing at all for a recording that was never bound", async () => {
    const sender = senderFor(unreachableInbox);
    const recording = capture(WEBM);

    await sender.send(recording);

    // Not an error and not a failure state: unreachable from the recording area, which
    // does not offer the button until the recording is bound. What matters is that no
    // question was invented to make the send possible - the inbox was never called.
    expect(sender.snapshot()).toEqual<AudioSendState>({
      phase: "idle",
      failure: null,
      receipt: null,
      recording: null,
    });
    expect(sender.boundQuestionIdFor(recording)).toBeNull();
  });

  it("binds a new recording to the question being asked when it appears", async () => {
    const { inbox, drafts } = acknowledging();
    const sender = senderFor(inbox);

    const first = capture(WEBM);
    sender.prepare(first, QUESTION);

    // The child throws it away and records again, after the rotation. The new recording
    // is a different object, so it is a different answer to a different question - which
    // is exactly right.
    const second = capture(OGG);
    sender.prepare(second, LATER_QUESTION);

    await sender.send(second);

    expect(drafts).toHaveLength(1);
    expect(drafts[0].questionId).toBe(LATER_QUESTION);
    expect(sender.boundQuestionIdFor(first)).toBeNull();
    expect(sender.boundQuestionIdFor(second)).toBe(LATER_QUESTION);
  });
});

/** Lets the size check, the sniff and the inbox call all reach their first await. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
}
