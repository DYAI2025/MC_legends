import type { CapturedAudio } from "@/adapters/media/audio-capture-controller";
import {
  AudioAnswerInboxError,
  type AudioAnswerInbox,
  type AudioInboxFailureReason,
} from "@/application/media/audio-answer-inbox";
import {
  MAX_AUDIO_BYTES,
  sniffAudioMimeType,
  type AudioMimeType,
} from "@/domain/media/audio-artifact";
import type { ServerReceipt } from "@/domain/submissions/submission";

/**
 * MCL-30B: the browser side of a child deliberately sending a recording.
 *
 * The other half of MCL-30A's capture controller, and deliberately a sibling of it rather
 * than a growth of it. That module's contract says nothing in it may grow a delivery, a
 * receipt or a status that reads like arrival - so the recording area now holds two small
 * machines, one that owns the microphone and one that owns the attempt, and neither can
 * quietly acquire the other's job.
 *
 * The rule this file exists to keep, and the reason it is testable without React or a
 * network: `sent` is reachable from exactly one place, the resolution of an inbox call
 * that produced a receipt. There is no optimistic branch, no "the request left" branch and
 * no timer that promotes anything.
 */

/**
 * Where one recording is on its way to the project.
 *
 * `sending` and `failed` are kept apart from the capture controller's phases on purpose:
 * a child can be looking at a finished recording (capture says `recorded`) while the
 * attempt to send it is still open, and one merged phase would have to lie about one of
 * the two.
 */
export type AudioSendPhase = "idle" | "sending" | "sent" | "failed";

/**
 * Every way sending can fail, as a closed set.
 *
 * Five come back from the inbox. Three are decided here, before any request is made, and
 * they are worth deciding here rather than letting the route answer them: a recording over
 * the ceiling would otherwise be uploaded in full only to be refused by its declared
 * length, and a file this browser cannot read as audio would spend a child's connection to
 * learn what its first sixteen bytes already say.
 *
 * The local checks are a courtesy, never the authority. A deployment may configure a
 * SMALLER maximum than the product ceiling checked here, so the route can still refuse
 * something this module let through - which arrives as `refused`, exactly as it should.
 */
export type AudioSendFailureReason =
  | AudioInboxFailureReason
  | "audio-too-large"
  | "audio-type-unsupported"
  | "audio-unreadable";

export type AudioSendState = Readonly<{
  phase: AudioSendPhase;
  failure: AudioSendFailureReason | null;
  /**
   * Present only in `sent`, and never rendered. It is here so that "phase sent implies a
   * real receipt" is a property a test can assert directly, instead of a claim about a
   * code path somebody has to re-read.
   */
  receipt: ServerReceipt | null;
  /**
   * Which recording this state is about. The recording area compares it against the one
   * the capture controller currently holds and falls back to `idle` when they differ, so
   * throwing a recording away and making a new one resets the send area without an effect,
   * a subscription between the two controllers, or a second copy of "which recording is
   * current".
   */
  recording: CapturedAudio | null;
}>;

const idleState: AudioSendState = {
  phase: "idle",
  failure: null,
  receipt: null,
  recording: null,
};

/** The idle state for a recording that has not been sent yet. */
export const idleSendState = idleState;

/**
 * How many leading bytes are read to identify a recording.
 *
 * Sixteen covers every signature the domain sniffer looks at - the furthest is WAVE's
 * format word at offset 8, four bytes long - with room to spare and without pulling a
 * megabyte of audio into memory to answer a question about its header.
 */
const SNIFF_BYTES = 16;

export type AudioAnswerSenderDependencies = Readonly<{
  createId: () => string;
  now: () => Date;
}>;

/**
 * One recording's identity on the wire, minted once and reused by every retry.
 *
 * MCL-35 put `questionId` in here, and that is the whole of the rotation fix. It used to
 * be a parameter of `send`, which meant every attempt re-stated which question the
 * recording answered - so a recording captured while question A was being asked, sent
 * after an adult closed A, went to the project as an answer to B. Nothing anywhere would
 * have looked wrong: the child spoke about A, the project filed it under B.
 *
 * All four values are minted together and none of them can be changed afterwards, so
 * "one captured recording, one answer" is a property of this object rather than a rule
 * somebody has to keep at every call site.
 */
type SendIdentity = Readonly<{
  recording: CapturedAudio;
  submissionId: string;
  createdAt: string;
  questionId: string;
}>;

export class AudioAnswerSender {
  readonly #inbox: AudioAnswerInbox;
  readonly #dependencies: AudioAnswerSenderDependencies;
  readonly #listeners = new Set<() => void>();
  #state: AudioSendState = idleState;
  #identity: SendIdentity | null = null;
  /**
   * Bumped by every send. An attempt compares the number it started with before it
   * publishes, so an answer that arrives after the child moved on - threw the recording
   * away, chose a file, pressed send on something else - is dropped instead of writing a
   * stale sentence under whatever is on the page now.
   */
  #generation = 0;

  constructor(inbox: AudioAnswerInbox, dependencies: AudioAnswerSenderDependencies) {
    this.#inbox = inbox;
    this.#dependencies = dependencies;
  }

  /** Stable while nothing changed, so React may use it as an external store. */
  readonly snapshot = (): AudioSendState => this.#state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /**
   * The submissionId this recording is being sent under, or null before the first
   * attempt.
   *
   * Exposed for tests rather than for the page: no child-facing surface may show it. It is
   * the single value that makes a retry after an ambiguous timeout safe, and a test that
   * could not read it would have to infer "the same id was reused" from request headers,
   * which is the same assertion one layer further from the decision.
   */
  readonly submissionIdFor = (recording: CapturedAudio): string | null =>
    this.#identity?.recording === recording ? this.#identity.submissionId : null;

  /**
   * Which question this recording answers, or null before it has been bound.
   *
   * The recording area uses it to say - in child-safe words and never as an id - that a
   * recording belongs to a question that is no longer the one being asked. Tests use it
   * to assert the binding directly instead of inferring it from a request body.
   */
  readonly boundQuestionIdFor = (recording: CapturedAudio): string | null =>
    this.#identity?.recording === recording ? this.#identity.questionId : null;

  /**
   * Binds one recording to the question it answers, once.
   *
   * Called when the recording APPEARS, not when it is sent. A recording is an answer to
   * the question a child was looking at while they spoke, and that is knowable at exactly
   * one moment - any later reading of "the current question" is a different question that
   * happens to be current.
   *
   * Idempotent for a given recording object, and deliberately so rather than
   * defensively: the recorder calls it from an effect whose dependencies include the
   * question, so rotation re-runs it - and it must do nothing. A second call with a
   * different question is not an error and is not honoured; it is the exact event this
   * method exists to absorb.
   */
  readonly prepare = (recording: CapturedAudio, questionId: string): void => {
    if (this.#identity?.recording === recording) return;

    this.#identity = {
      recording,
      submissionId: this.#dependencies.createId(),
      createdAt: this.#dependencies.now().toISOString(),
      questionId,
    };

    // A new recording invalidates whatever attempt was still open: its outcome is about
    // something the child has moved on from, and publishing it would put a sentence about
    // a thrown-away recording under the one they are looking at.
    this.#generation += 1;

    // Published, not merely stored, and that is what makes the binding visible to React:
    // the identity is private state that no snapshot exposes, so without this the
    // recording area would never re-render to find out that its send button may now be
    // offered. The published state is `idle` for this recording, which is exactly what a
    // recording that has never been sent is.
    this.#publish({ ...idleState, recording });
  };

  /**
   * One deliberate attempt to send one recording.
   *
   * ONE parameter, and that is structural rather than tidy: there is no argument through
   * which the question a child is looking at NOW could enter an attempt to send a
   * recording they made earlier. A retry cannot re-aim a recording, because a retry has
   * nothing to re-aim it with.
   *
   * Never throws and never rejects: a child pressing a button is not an error path, and
   * every outcome this can have is a state the recording area draws.
   */
  readonly send = async (recording: CapturedAudio): Promise<void> => {
    // A second press on the recording that is already on its way, or one that already
    // arrived. Both are the same answer: nothing to do. Compared against the recording as
    // well as the phase, because a child who threw one recording away mid-flight and made
    // another must not find the new one's button dead.
    if (this.#state.recording === recording) {
      if (this.#state.phase === "sending" || this.#state.phase === "sent") return;
    }

    // Unreachable from the recording area, which does not offer the button until the
    // recording is bound. Handled anyway, and handled by doing NOTHING: inventing a
    // question here is the one mistake this whole redesign exists to make impossible, and
    // refusing loudly would put a failure in front of a child about a button they were
    // never shown.
    const identity = this.#identity;
    if (identity?.recording !== recording) return;

    const generation = ++this.#generation;
    this.#publish({ phase: "sending", failure: null, receipt: null, recording });

    // Checked before the bytes are read, and from the product ceiling rather than from
    // anything a deployment configured: this is the number the route and the schema both
    // spell out, and the only one a browser can know.
    if (recording.blob.size > MAX_AUDIO_BYTES) {
      this.#settle(generation, recording, { failure: "audio-too-large" });
      return;
    }

    let mimeType: AudioMimeType | null;
    try {
      mimeType = await this.#sniff(recording.blob);
    } catch {
      // A file the browser handed over and can no longer read - a removable disk, a file
      // replaced under the picker. Distinct from "not audio", because the child's next
      // step differs: choose it again, rather than choose a different one.
      this.#settle(generation, recording, { failure: "audio-unreadable" });
      return;
    }

    if (mimeType === null) {
      this.#settle(generation, recording, { failure: "audio-type-unsupported" });
      return;
    }

    // Everything on the wire comes from the identity minted when the recording appeared,
    // and nothing from this call. That is the whole of the ambiguous-timeout answer AND of
    // the rotation answer at once: the route is idempotent by submissionId, so a retry
    // after an attempt that may or may not have landed converges on the receipt the server
    // already minted - and it converges on it under the SAME question, whatever the page
    // is asking by then.
    let receipt: ServerReceipt;
    try {
      receipt = await this.#inbox.deliver({
        submissionId: identity.submissionId,
        questionId: identity.questionId,
        createdAt: identity.createdAt,
        mimeType,
        bytes: recording.blob,
      });
    } catch (cause) {
      this.#settle(generation, recording, { failure: inboxFailureReason(cause) });
      return;
    }

    // The only path to `sent` in this file.
    this.#settle(generation, recording, { receipt });
  };

  /**
   * Forgets the outcome of the last attempt without touching the recording or its
   * identity, so the recording area can go back to offering the button.
   *
   * Deliberately does NOT mint a new submissionId: a child who reads a failure and presses
   * send again is retrying one answer, not writing a second one.
   */
  readonly dismissFailure = (): void => {
    if (this.#state.phase !== "failed") return;
    this.#publish({ ...idleState, recording: this.#state.recording });
  };

  async #sniff(blob: Blob): Promise<AudioMimeType | null> {
    const head = new Uint8Array(await blob.slice(0, SNIFF_BYTES).arrayBuffer());
    return sniffAudioMimeType(head);
  }

  /**
   * Publishes the end of one attempt, unless a newer one has started since.
   *
   * The generation check is what keeps a slow failure from overwriting a fast success on
   * the recording that replaced it - and, just as importantly, from putting a sentence
   * about a thrown-away recording under the one the child is looking at.
   */
  #settle(
    generation: number,
    recording: CapturedAudio,
    outcome: Readonly<{ receipt: ServerReceipt } | { failure: AudioSendFailureReason }>,
  ): void {
    if (generation !== this.#generation) return;

    this.#publish(
      "receipt" in outcome
        ? { phase: "sent", failure: null, receipt: outcome.receipt, recording }
        : { phase: "failed", failure: outcome.failure, receipt: null, recording },
    );
  }

  #publish(state: AudioSendState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}

/**
 * An unrecognised throw counts as transport, mirroring the text delivery use case and for
 * the same reason: transport is the retryable reading, and a passing fault reported as a
 * permanent refusal would tell a child to record something new when the recording they
 * have is fine.
 */
function inboxFailureReason(cause: unknown): AudioSendFailureReason {
  return cause instanceof AudioAnswerInboxError ? cause.reason : "transport";
}
