import { acknowledgeSubmission, type TextSubmission } from "@/domain/submissions/submission";
import type { SubmissionInbox } from "./submission-inbox";
import type { SubmissionRepository } from "./submission-repository";

export type DeliveryOutcome = Readonly<{
  delivered: boolean;
  /** Acknowledged copy on success, the untouched local submission on failure. */
  submission: TextSubmission;
}>;

/**
 * Attempts one delivery to the project inbox. On any failure - transport error,
 * rejected payload or an invalid receipt - the local submission is left exactly as
 * it was, so nothing is lost and the caller can retry.
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
  try {
    const receipt = await inbox.deliver(submission);
    const acknowledged = acknowledgeSubmission(submission, receipt);
    await repository.save(acknowledged);
    return { delivered: true, submission: acknowledged };
  } catch {
    return { delivered: false, submission };
  }
}
