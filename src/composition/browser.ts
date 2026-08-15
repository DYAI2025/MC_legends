import { HttpAdminInboxClient } from "@/adapters/http/http-admin-inbox-client";
import { HttpFamilySessionClient } from "@/adapters/http/http-family-session-client";
import { HttpSubmissionInbox } from "@/adapters/http/http-submission-inbox";
import { IndexedDbSubmissionRepository } from "@/adapters/persistence/indexeddb-submission-repository";
import type { FamilySessionClient } from "@/application/access/family-session-client";
import type { AdminInboxClient } from "@/application/submissions/admin-inbox-client";
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

/**
 * Sign-in from the browser. Sends what the family typed and receives an outcome; the
 * session cookie is set by the server and is never readable here.
 */
export function createBrowserFamilySessionClient(): FamilySessionClient {
  return new HttpFamilySessionClient();
}

/**
 * Admin sign-in from the browser. The same HTTP client as the family sign-in, pointed
 * at the admin endpoint - the transport is identical, and it is the endpoint and the
 * secret behind it that differ. Reusing the class keeps one timeout, one status mapping
 * and one place where "the request never arrived" is told apart from "you were refused".
 */
export function createBrowserAdminSessionClient(): FamilySessionClient {
  return new HttpFamilySessionClient({ endpoint: "/api/admin/session" });
}

/** Reading the protected inbox from the browser. Carries no credential of its own. */
export function createBrowserAdminInboxClient(): AdminInboxClient {
  return new HttpAdminInboxClient();
}
