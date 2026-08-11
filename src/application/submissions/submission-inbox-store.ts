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

/** Server-side persistence boundary for the family project inbox. */
export interface SubmissionInboxStore {
  append(record: InboxRecord): Promise<void>;
}
