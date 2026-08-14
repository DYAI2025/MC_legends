import type {
  InboxEntryStatus,
  InboxQuery,
} from "@/application/submissions/submission-inbox-reader";

/**
 * What the filter controls hold. Empty string means "no constraint on this dimension",
 * because that is what an unselected `<select>` and an empty `<input>` produce - the
 * translation into an absent field happens once, here.
 */
export type AdminFilterState = Readonly<{
  status: "" | InboxEntryStatus;
  kind: "" | "text";
  questionId: string;
}>;

export const EMPTY_FILTERS: AdminFilterState = { status: "", kind: "", questionId: "" };

/**
 * How long the free-text question filter waits before it becomes a read.
 *
 * 300ms: comfortably longer than the gap between keystrokes of a fluent typist, so a
 * whole question id costs one read instead of one per character, and short enough that
 * the list does not feel stuck. Without it a 12-character question id issues 12 reads
 * against a route whose default ceiling is 60/min, and an adult can rate-limit
 * themselves out of their own inbox in a few searches - then read "Zu viele Abfragen"
 * with no way to connect it to anything they did.
 *
 * Only the free-text box is debounced. The selects and the reset button are discrete
 * choices and commit at once, because a discrete choice that waits feels broken.
 */
export const QUESTION_FILTER_DEBOUNCE_MS = 300;

/**
 * Orders a series of overlapping async reads so that only the newest one may act.
 *
 * Two inbox reads can be in flight at once - change a filter while one is running - and
 * nothing guarantees they resolve in the order they were issued. Whoever answers last
 * would otherwise win, so an older page can land under a newer filter. On this surface
 * that means showing a child's answers as the answer to a question nobody asked, which
 * is the one thing the protected read exists to get right.
 *
 * Pure and framework-free on purpose: the policy is the part worth testing, and keeping
 * it out of the component means it can be tested without a DOM. The view holds one of
 * these and asks it, after every await, whether the result in its hands is still the one
 * the screen should show.
 */
export function createLatestOnly(): {
  /** Claims a ticket for a read about to start. */
  issue: () => number;
  /** Whether that read is still the newest, and so still allowed to paint. */
  isLatest: (ticket: number) => boolean;
} {
  let latest = 0;

  return {
    issue: () => (latest += 1),
    // Strict equality: exactly one ticket is current at a time. Anything looser lets a
    // superseded read through, which is the overwrite this exists to prevent.
    isLatest: (ticket: number) => ticket === latest,
  };
}

/**
 * Turns the controls into a query.
 *
 * Absent rather than empty for every unset dimension: the route refuses `status=` and
 * a blank `questionId` with 400, so sending an empty value would turn "show me
 * everything" into an error the user never asked for.
 *
 * It does NOT validate lengths or values. The server is the authority on what is
 * acceptable, and a browser that silently rewrote an over-long question into a shorter
 * one would answer a question nobody asked and present it as the answer.
 */
export function buildInboxQuery(filters: AdminFilterState): InboxQuery {
  const query: {
    status?: InboxEntryStatus;
    kind?: "text";
    questionId?: string;
  } = {};

  if (filters.status !== "") query.status = filters.status;
  if (filters.kind !== "") query.kind = filters.kind;

  const questionId = filters.questionId.trim();
  if (questionId.length > 0) query.questionId = questionId;

  return query;
}
