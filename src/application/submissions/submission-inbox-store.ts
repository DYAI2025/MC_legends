export type InboxRecord = Readonly<{
  /**
   * Which kind of submission this line holds, mirroring TextSubmission.kind. Only text
   * exists today; MCL-30 adds audio, and without this field the lines already on disk
   * would be indistinguishable from the audio ones written after it. Widening this
   * union later makes the compiler find every site that has to choose.
   */
  kind: "text";
  receiptId: string;
  receivedAt: string;
  submissionId: string;
  questionId: string;
  createdAt: string;
  /** Unchanged original text as submitted. */
  originalText: string;
}>;

/**
 * What one delivery attempt did to the store.
 *
 * `stored: false` is not a failure: it is the answer to a retry of a submissionId the
 * store already holds, and it carries the record that was kept so the caller can reply
 * with the receipt that submission already has. Without the existing record here, a
 * retry would either mint a second contradictory receipt or have to be refused - and a
 * refusal would leave a child's answer looking undelivered when it arrived long ago.
 */
export type AppendOutcome =
  | Readonly<{ stored: true }>
  | Readonly<{ stored: false; existing: InboxRecord }>;

/**
 * Server-side persistence boundary for the family project inbox.
 *
 * `appendIfAbsent` rather than `append` so idempotency is a property of the boundary
 * and not of one adapter's implementation: the file adapter enforces it by scanning
 * what it wrote, and the PostgreSQL adapter of MCL-48 is expected to enforce it with a
 * unique constraint on submissionId. Both satisfy the same contract, so the route does
 * not change when the store does.
 */
export interface SubmissionInboxStore {
  appendIfAbsent(record: InboxRecord): Promise<AppendOutcome>;
}
