import type { ServerReceipt, TextSubmission } from "@/domain/submissions/submission";

/**
 * Delivery boundary to the family project inbox. Sprint 2 ships an HTTP adapter;
 * a later Supabase adapter implements the same port without touching the UI.
 */
export interface SubmissionInbox {
  /** Resolves with a receipt only on a real positive acknowledgement, throws otherwise. */
  deliver(submission: TextSubmission): Promise<ServerReceipt>;
}
