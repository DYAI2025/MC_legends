import { IndexedDbSubmissionRepository } from "@/adapters/persistence/indexeddb-submission-repository";
import type { SubmissionRepository } from "@/application/submissions/submission-repository";

export function createBrowserSubmissionRepository(): SubmissionRepository {
  return new IndexedDbSubmissionRepository();
}
