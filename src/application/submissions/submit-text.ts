import {
  createTextSubmission,
  type CreateTextSubmissionInput,
  type SubmissionFactoryDependencies,
  type TextSubmission,
} from "@/domain/submissions/submission";
import type { SubmissionRepository } from "./submission-repository";

export async function submitText(
  input: CreateTextSubmissionInput,
  repository: SubmissionRepository,
  dependencies: SubmissionFactoryDependencies,
): Promise<TextSubmission> {
  const submission = createTextSubmission(input, dependencies);
  await repository.save(submission);
  return submission;
}
