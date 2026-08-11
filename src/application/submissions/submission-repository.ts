import type { SubmissionId, TextSubmission } from "@/domain/submissions/submission";

export interface SubmissionRepository {
  save(submission: TextSubmission): Promise<void>;
  findById(id: SubmissionId): Promise<TextSubmission | null>;
  list(): Promise<readonly TextSubmission[]>;
}
