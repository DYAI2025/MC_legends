import {
  acknowledgeSubmission,
  type ServerReceipt,
  type TextSubmission,
} from "@/domain/submissions/submission";
import { type SubmissionInbox, SubmissionInboxError } from "./submission-inbox";
import type { SubmissionRepository } from "./submission-repository";

export type DeliveryFailureReason = "transport" | "refused" | "local-save";

export type DeliveryOutcome = Readonly<{
  delivered: boolean;
  /** Why the attempt failed. Absent on success. */
  reason?: DeliveryFailureReason;
  /** Acknowledged copy on success, the untouched local submission on failure. */
  submission: TextSubmission;
}>;

/**
 * An unrecognised failure counts as transport. Inviting a retry for something that
 * was in fact refused wastes an attempt; the opposite - declaring a passing network
 * fault permanent - would tell a child their answer is lost when it is not.
 */
function inboxFailureReason(cause: unknown): DeliveryFailureReason {
  return cause instanceof SubmissionInboxError ? cause.reason : "transport";
}

/**
 * Attempts one delivery of an already locally saved submission to the project inbox.
 * On any failure - transport error, rejected payload or an invalid receipt - the local
 * submission is left exactly as it was, so nothing is lost and the caller can retry.
 *
 * A local save that fails *after* a genuine server acknowledgement is deliberately
 * treated as a failed delivery too. The child then reads "only on this device" for
 * something the server did receive, and a retry re-posts it. Both consequences are
 * accepted on purpose: this direction understates what arrived, and understating is
 * the only safe way to be wrong here - the opposite would promise a child that an
 * answer reached the project when this device cannot show that it did. The receipt
 * is dropped with it, so the server can hold a record this client never learns
 * about, and a retry can leave two inbox lines for one submissionId. De-duplicating
 * them belongs to the authenticated inbox work, not here.
 */
export async function deliverSubmission(
  submission: TextSubmission,
  repository: SubmissionRepository,
  inbox: SubmissionInbox,
): Promise<DeliveryOutcome> {
  let receipt: ServerReceipt;

  try {
    receipt = await inbox.deliver(submission);
  } catch (cause) {
    return { delivered: false, reason: inboxFailureReason(cause), submission };
  }

  let acknowledged: TextSubmission;

  try {
    acknowledged = acknowledgeSubmission(submission, receipt);
  } catch {
    // A receipt the domain rejects means this was not a real acknowledgement,
    // however positive the answer looked.
    return { delivered: false, reason: "refused", submission };
  }

  try {
    await repository.save(acknowledged);
  } catch {
    return { delivered: false, reason: "local-save", submission };
  }

  return { delivered: true, submission: acknowledged };
}
