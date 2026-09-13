import type { ReplyView } from "@/application/replies/submission-reply-reader";

/**
 * MCL-74. What one read of the household's replies from the child's browser produced.
 *
 * Mirrors `AdminInboxResult` on purpose, including keeping `denied` and `unavailable`
 * apart - but what the child surface does with them is the opposite of what the admin
 * view does. An adult is shown where to go; a child is shown nothing new at all.
 *
 * That is the rule this port exists to make easy: none of these outcomes has a
 * child-facing sentence of its own. A card that said "das hat nicht geklappt" every time
 * a poll missed would teach a child that the project is broken, when the truth is that a
 * page open on a tablet lost its connection for four seconds. The surface keeps the last
 * list it had and says nothing.
 */
export type FamilyReplyResult =
  | { outcome: "granted"; replies: readonly ReplyView[] }
  | { outcome: "denied" }
  | { outcome: "unavailable" }
  | { outcome: "transport" };

export interface FamilyReplyClient {
  /**
   * Never throws: every failure is one of the outcomes above.
   *
   * `since` lets a poll ask only for what it has not seen. Optional rather than
   * required, because the first read of a freshly opened page wants everything.
   */
  list(since?: string): Promise<FamilyReplyResult>;
}
