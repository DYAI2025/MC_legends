import type {
  QuestionLifecycleAction,
  QuestionState,
} from "@/domain/questions/question-lifecycle";

/**
 * MCL-35. What the protected question board reads and what one close or reopen answers.
 *
 * The wording is resolved on the SERVER and travels in these shapes. The alternative -
 * sending ids and letting the board look the titles up in the content dataset - would
 * work today and would quietly become wrong the moment a deployment serves a page built
 * from a different dataset than the events refer to. Resolving once, where the events are
 * read, means the board can only ever show a title that belongs to the row it is next to.
 */

export type QuestionBoardEntry = Readonly<{
  id: string;
  title: string;
  state: QuestionState;
  /** Whether this is the question children are being asked right now. */
  active: boolean;
}>;

/**
 * One line of the archive.
 *
 * `title` is nullable on purpose: an event outlives the wording it refers to, and a
 * question removed from the dataset still has history. Rendering the id instead would put
 * an internal identifier on a screen; rendering nothing would silently drop the evidence.
 */
export type QuestionBoardHistoryEntry = Readonly<{
  questionId: string;
  title: string | null;
  action: QuestionLifecycleAction;
  occurredAt: string;
  revision: number;
}>;

export type QuestionBoardPage = Readonly<{
  questions: readonly QuestionBoardEntry[];
  history: readonly QuestionBoardHistoryEntry[];
  /**
   * How many events exist, independent of how many are in `history`. Separate so a capped
   * page cannot make the archive look shorter than it is - the same reason InboxPage
   * carries a total.
   */
  historyTotal: number;
}>;

/**
 * What one read produced.
 *
 * `denied` and `unavailable` are kept apart for the reason the inbox client already
 * records: the first sends an adult back to the sign-in panel, the second sends them to
 * the deployment, and collapsing them sends them to the wrong one every second time.
 */
export type QuestionBoardResult =
  | { outcome: "granted"; page: QuestionBoardPage }
  | { outcome: "denied" }
  | { outcome: "rate-limited" }
  | { outcome: "unavailable" }
  | { outcome: "transport" };

/**
 * What one close or reopen produced.
 *
 * `stale` is its own outcome and not a failure: somebody else changed the question first,
 * nothing was written, and the board can show what actually holds. Folding it into
 * `invalid-request` would tell an adult they did something wrong when they did not.
 */
export type QuestionChangeResult =
  | { outcome: "applied"; state: QuestionState }
  | { outcome: "stale"; currentState: QuestionState }
  | { outcome: "denied" }
  | { outcome: "invalid-request" }
  | { outcome: "rate-limited" }
  | { outcome: "unavailable" }
  | { outcome: "transport" };

/**
 * Boundary for the browser. The board depends on this port rather than on fetch, so its
 * behaviour is testable without a browser and without a server.
 */
export interface QuestionBoardClient {
  /** Never throws: every failure is one of the outcomes above. */
  list(): Promise<QuestionBoardResult>;

  /**
   * Asks for a state change, stating what the caller believed the state to be.
   *
   * `expectedState` is not a convenience - it is the concurrency contract. A caller that
   * only said "close this" could not be told apart from one acting on a board it loaded
   * an hour ago, and the server would have no way to refuse the second.
   */
  change(
    questionId: string,
    nextState: QuestionState,
    expectedState: QuestionState,
  ): Promise<QuestionChangeResult>;
}
