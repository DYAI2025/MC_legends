import type { ServerReceipt } from "@/domain/submissions/submission";
import type { AudioMimeType } from "@/domain/media/audio-artifact";

/**
 * Delivery boundary for a spoken answer (MCL-30B).
 *
 * A sibling of SubmissionInbox rather than a widening of it, for the same reason the two
 * routes are siblings: one carries a JSON document and a string, the other carries opaque
 * bytes whose identity the server computes. A single port would have to describe a
 * payload that is sometimes text and sometimes a recording, and the one property that
 * matters here - "the bytes that reached the server are the bytes the microphone made" -
 * is exactly what such a union would blur.
 *
 * The draft is what a browser can honestly assemble. It deliberately does NOT carry an
 * AudioArtifact: the object key, the digest and the stored size are the server's
 * findings about the bytes, and a client that could name them could name them wrongly.
 */
export type AudioAnswerDraft = Readonly<{
  /**
   * Stable for one recording across every attempt to send it. The route is idempotent by
   * this value, so reusing it is what makes an ambiguous timeout converge on the receipt
   * the server may already have minted instead of leaving a second copy behind.
   */
  submissionId: string;
  questionId: string;
  /** ISO-8601. Minted with the submissionId, so a retry does not re-date the answer. */
  createdAt: string;
  /**
   * What the bytes actually are, read from the bytes themselves rather than from the
   * browser's label for them. The route refuses a request whose declared type disagrees
   * with what it sniffs, so anything less than the sniffed type is a refusal by design.
   */
  mimeType: AudioMimeType;
  /** The original recording, untouched. Never re-encoded, re-containered or copied. */
  bytes: Blob;
}>;

/**
 * Why a delivery attempt produced no receipt.
 *
 * Five reasons rather than the text path's two, because the audio route answers with four
 * distinct refusals and a child needs a different next step for each. "Wait a moment" and
 * "ask an adult to sign in again" are not the same sentence, and folding them into one
 * would send a child back to a button that cannot work yet.
 *
 * - `transport` - no usable answer at all: offline, the deadline passed, the answer could
 *   not be read, or it read as positive while carrying no receipt. Worth retrying, and the
 *   server may already hold the submission. That last shape is MCL-30B finding F1: a
 *   receipt-less 2xx is evidence about this CLIENT's knowledge, never about what the
 *   server stored, so it belongs here with the other ambiguous outcomes and not below.
 * - `unavailable` - the project answered that it cannot take this right now. Retryable.
 * - `rate-limited` - too many uploads in a short time. Retryable after a pause.
 * - `unauthorized` - this browser has no valid family session any more. A retry needs a
 *   sign-in first, so offering a bare "try again" would be a lie.
 * - `refused` - the project answered and EXPLICITLY declined this recording, with a status
 *   that says so. Sending the same bytes again will be declined again. Reserved for that:
 *   an outcome that is merely unproven is a `transport`, because the sentence this reason
 *   produces asks the child to record something new, and a child cannot un-send bytes the
 *   server may already have kept.
 */
export type AudioInboxFailureReason =
  | "transport"
  | "unavailable"
  | "rate-limited"
  | "unauthorized"
  | "refused";

export class AudioAnswerInboxError extends Error {
  constructor(
    readonly reason: AudioInboxFailureReason,
    options?: Readonly<{ cause?: unknown }>,
  ) {
    super("audio inbox did not acknowledge the recording", options);
    this.name = "AudioAnswerInboxError";
  }
}

export interface AudioAnswerInbox {
  /**
   * Resolves with a receipt only on a real positive acknowledgement. Every other
   * outcome throws an AudioAnswerInboxError naming which of the five it was - there is
   * no return value that means "probably arrived".
   */
  deliver(draft: AudioAnswerDraft): Promise<ServerReceipt>;
}
