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
