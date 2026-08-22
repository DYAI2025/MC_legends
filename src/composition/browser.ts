import { HttpAdminInboxClient } from "@/adapters/http/http-admin-inbox-client";
import { HttpAudioAnswerInbox } from "@/adapters/http/http-audio-answer-inbox";
import { HttpFamilySessionClient } from "@/adapters/http/http-family-session-client";
import { HttpQuestionBoardClient } from "@/adapters/http/http-question-board-client";
import { HttpSubmissionInbox } from "@/adapters/http/http-submission-inbox";
import { AudioAnswerSender } from "@/adapters/media/audio-answer-sender";
import { AudioCaptureController } from "@/adapters/media/audio-capture-controller";
import { IndexedDbSubmissionRepository } from "@/adapters/persistence/indexeddb-submission-repository";
import type { FamilySessionClient } from "@/application/access/family-session-client";
import type { AdminInboxClient } from "@/application/submissions/admin-inbox-client";
import type { QuestionBoardClient } from "@/application/questions/question-board-client";
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

/**
 * Reading and changing the question board from the browser (MCL-35).
 *
 * One client for both, because they are one capability behind one gate: whoever may see
 * which questions are open is exactly whoever may close one. Splitting them would be two
 * factories the composition root has to keep pointed at the same endpoint.
 *
 * It carries no credential of its own - the admin session is an HttpOnly cookie this code
 * can never read - so nothing here reaches the client bundle that a script could steal.
 */
export function createBrowserQuestionBoardClient(): QuestionBoardClient {
  return new HttpQuestionBoardClient();
}

/** Reading the protected inbox from the browser. Carries no credential of its own. */
export function createBrowserAdminInboxClient(): AdminInboxClient {
  return new HttpAdminInboxClient();
}

/**
 * MCL-30A: one recording session for one mounted recording area. Deliberately a
 * factory rather than a shared instance - a microphone is a single resource, and two
 * components holding one controller would stop each other's recording.
 *
 * Reads the browser's own capabilities; on the server it finds none and answers that
 * it cannot record, which is never drawn and so cannot disagree with the client.
 */
export function createBrowserAudioCaptureController(): AudioCaptureController {
  return new AudioCaptureController();
}

/**
 * MCL-30B: one send machine for one mounted recording area, wired to the same-origin
 * audio inbox. A factory for the same reason the capture controller is one - the
 * submissionId it mints belongs to the recording in front of one child, and a shared
 * instance would hand a second recording area the first one's identity.
 *
 * The two dependencies are injected rather than reached for, so the whole send machine
 * runs in a test without a clock and without a random number generator: a stable
 * submissionId across retries is the property that has to be provable, and it cannot be
 * proved against a value the module invents for itself.
 */
export function createBrowserAudioAnswerSender(): AudioAnswerSender {
  return new AudioAnswerSender(new HttpAudioAnswerInbox(), {
    createId: () => crypto.randomUUID(),
    now: () => new Date(),
  });
}
