import { HttpSubmissionInbox } from "@/adapters/http/http-submission-inbox";
import { IndexedDbSubmissionRepository } from "@/adapters/persistence/indexeddb-submission-repository";
import type { SubmissionInbox } from "@/application/submissions/submission-inbox";
import type { SubmissionRepository } from "@/application/submissions/submission-repository";

export function createBrowserSubmissionRepository(): SubmissionRepository {
  return new IndexedDbSubmissionRepository();
}

/**
 * Same-origin delivery to the project inbox. Carries no credentials and no secrets;
 * the server composition root is deliberately a separate module so it never reaches
 * the client bundle.
 */
export function createBrowserSubmissionInbox(): SubmissionInbox {
  return new HttpSubmissionInbox();
}
