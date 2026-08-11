export type InboxRecord = Readonly<{
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
