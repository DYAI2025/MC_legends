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
