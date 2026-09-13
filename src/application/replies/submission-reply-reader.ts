import type { SubmissionKind } from "@/domain/submissions/submission";
import type { SubmissionReply } from "@/domain/replies/reply";

/**
 * MCL-74. The read side of the reply log.
 *
 * Read by two identities through two routes: the child surface behind the family gate
 * (the household's newest replies) and the admin card behind the admin gate (one
 * submission's full history). One port, because both are the same capability - reading
 * replies - and the gates, not the port, are what separate them.
 */

/**
 * A reply together with just enough of the submission it answers for a child to
 * recognise which of their own ideas came back.
 *
 * The excerpt is deliberately not the whole original. A child's card needs a handle
 * ("ah, that one"), and shipping the full text would put an unbounded copy of a child's
 * own words into every poll response for a value nobody reads past the first line.
 *
 * `originalTextExcerpt` is `null` for audio rather than a transcript or a placeholder
 * sentence. AGENTS.md keeps original and derived representations separate, and a
 * recording's original is the recording: there is no text to excerpt, and inventing one
 * here would be this layer deciding what a child said.
 */
export type ReplyView = Readonly<{
  reply: SubmissionReply;
  submission: Readonly<{
    submissionId: string;
    kind: SubmissionKind;
    questionId: string;
    createdAt: string;
    originalTextExcerpt: string | null;
  }>;
}>;

/** How much of the original a card carries as a handle. */
export const MAX_ORIGINAL_EXCERPT_LENGTH = 120;

/**
 * The largest page the household view can ask for.
 *
 * Enforced by the adapter, not by the route, for the reason MCL-50 gives for the inbox:
 * a limit is a memory question, and the answer must not depend on which caller asked or
 * on a route remembering to clamp it.
 */
export const MAX_REPLY_PAGE_SIZE = 100;

export type HouseholdReplyQuery = Readonly<{
  /** ISO 8601. Only replies written strictly after this instant. */
  since?: string;
  limit?: number;
}>;

export interface SubmissionReplyReader {
  /**
   * The newest READY reply per submission, newest first.
   *
   * Per submission rather than every reply, because the child's card is "what came back
   * about my idea" and not an audit trail: a correction written ten minutes after a
   * first attempt should replace it on the card, not sit under it as a second answer to
   * the same thing. The full history stays reachable - through `listForSubmission`, on
   * the adult side, where it belongs.
   *
   * `fallback` replies are excluded here and only here. Nothing writes one today; when
   * MCL-76 does, this is the line that decides a machine's admitted best effort does not
   * reach a child as though an adult had written it.
   */
  latestForHousehold(query: HouseholdReplyQuery): Promise<readonly ReplyView[]>;

  /**
   * Every reply to one submission, oldest first.
   *
   * Oldest first, unlike everything else in this codebase, because this one is read as a
   * conversation rather than as an inbox: an adult opening a card wants to see what they
   * already said before they say the next thing.
   */
  listForSubmission(submissionId: string): Promise<readonly SubmissionReply[]>;
}
