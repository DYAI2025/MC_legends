import type { SubmissionReply } from "@/domain/replies/reply";
import type { ComposeReplyRefusal } from "@/application/replies/compose-reply";

/**
 * MCL-74. The adult side of replying, from the browser.
 *
 * `invalid` carries the reason code rather than a sentence. The refusal has to become
 * German prose an adult can act on ("zwei Fragen" reads differently from "zu lang"), and
 * that mapping belongs in the message table next to every other piece of copy - not in a
 * client that would then be the one module deciding how the product talks.
 *
 * `unknown-submission` is separate from `transport` because they are different facts: the
 * first means this card is answering something that is no longer in the inbox, and no
 * amount of retrying will change that.
 */
export type AdminReplyPostResult =
  | { outcome: "created"; reply: SubmissionReply }
  | { outcome: "invalid"; reason: ComposeReplyRefusal }
  | { outcome: "denied" }
  | { outcome: "unknown-submission" }
  | { outcome: "rate-limited" }
  | { outcome: "unavailable" }
  | { outcome: "transport" };

export type AdminReplyListResult =
  | { outcome: "granted"; replies: readonly SubmissionReply[] }
  | { outcome: "denied" }
  | { outcome: "unknown-submission" }
  | { outcome: "rate-limited" }
  | { outcome: "unavailable" }
  | { outcome: "transport" };

export type ReplyDraft = Readonly<{ understood: string; question: string }>;

export interface AdminReplyClient {
  /** Never throws. One submission's replies, oldest first. */
  list(submissionId: string): Promise<AdminReplyListResult>;
  /** Never throws. */
  post(submissionId: string, draft: ReplyDraft): Promise<AdminReplyPostResult>;
}
