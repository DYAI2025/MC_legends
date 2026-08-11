import type { ServerReceipt, TextSubmission } from "@/domain/submissions/submission";

/**
 * Why a delivery attempt produced no receipt.
 *
 * - `transport` - no usable answer at all: offline, timed out, the inbox itself is
 *   broken, or the answer could not be read. A later attempt can still succeed.
 * - `refused` - the inbox answered and declined this submission. Sending the same
 *   text again will be declined again.
 *
 * The distinction exists so the child-facing retry can be honest about which of the
 * two happened instead of offering "try again" for something that will never work.
 */
export type InboxFailureReason = "transport" | "refused";

export class SubmissionInboxError extends Error {
  constructor(
    readonly reason: InboxFailureReason,
    options?: Readonly<{ cause?: unknown }>,
  ) {
    super("inbox did not acknowledge the submission", options);
    this.name = "SubmissionInboxError";
  }
}

/**
 * Delivery boundary to the family project inbox. Sprint 2 ships an HTTP adapter;
 * a later Supabase adapter implements the same port without touching the UI.
 */
export interface SubmissionInbox {
  /**
   * Resolves with a receipt only on a real positive acknowledgement. Otherwise it
   * throws - a `SubmissionInboxError` when the implementation can say which kind of
   * failure it was.
   */
  deliver(submission: TextSubmission): Promise<ServerReceipt>;
}
