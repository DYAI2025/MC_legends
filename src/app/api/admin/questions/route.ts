import { guardAdminRequest } from "@/adapters/http/admin-request-guard";
import type {
  QuestionBoardEntry,
  QuestionBoardHistoryEntry,
  QuestionBoardPage,
} from "@/application/questions/question-board-client";
import {
  openQuestions,
  questionById,
  rotateQuestions,
} from "@/content/open-questions";
import {
  createAdminAccessGate,
  createAdminRouteRateLimiter,
  createQuestionLifecycleReader,
} from "@/composition/server";

/**
 * The protected question board (MCL-35).
 *
 * GET and nothing else in this module. The verb that changes a question lives one path
 * segment deeper, in `[questionId]/route.ts`, so a client can only ever mutate a question
 * it has named - there is no endpoint here that could take a list of ids.
 *
 * It answers with the wording resolved, so the board never has to look a title up: the
 * events and the words they refer to are read in one place, and a page cannot show a
 * title from a dataset the events do not belong to.
 */

/**
 * How many archive lines one read returns.
 *
 * A cap rather than everything, because this table grows with every button press for the
 * lifetime of the project and nothing else bounds it. `historyTotal` travels alongside so
 * the board can say that there are older entries rather than silently implying there are
 * not - a truncation nobody is told about reads as completeness.
 */
const MAX_HISTORY_ENTRIES = 200;

type AdminQuestionsError = "unauthorized" | "too-many-requests" | "questions-unavailable";

/** Machine-readable codes only - never an exception message, path or stack trace. */
function refuse(status: 401 | 429 | 503, error: AdminQuestionsError): Response {
  return Response.json({ error }, { status });
}

export async function GET(request: Request): Promise<Response> {
  // First, and from headers alone. An unauthorised caller must not be able to make this
  // server open a database connection or read a file.
  const access = guardAdminRequest(request, createAdminAccessGate(), createAdminRouteRateLimiter());

  if (access === "unavailable") {
    console.error("admin access gate unavailable: no admin access code configured");
    return refuse(503, "questions-unavailable");
  }

  if (access === "unauthorized") {
    return refuse(401, "unauthorized");
  }

  if (access === "rate-limited") {
    return refuse(429, "too-many-requests");
  }

  try {
    const reader = createQuestionLifecycleReader();
    const snapshot = await reader.snapshot();
    const events = await reader.history();
    const rotation = rotateQuestions(snapshot);

    const questions: QuestionBoardEntry[] = openQuestions.map((question) => ({
      id: question.id,
      title: question.title,
      state: snapshot[question.id]?.state ?? question.state,
      active: rotation.active?.id === question.id,
    }));

    const history: QuestionBoardHistoryEntry[] = events
      .slice(0, MAX_HISTORY_ENTRIES)
      .map((event) => ({
        questionId: event.questionId,
        // Null rather than the id when the dataset no longer carries the wording: an
        // internal identifier on a screen is an internal identifier in a screenshot.
        title: questionById(event.questionId)?.title ?? null,
        action: event.action,
        occurredAt: event.occurredAt,
        revision: event.revision,
      }));

    const page: QuestionBoardPage = { questions, history, historyTotal: events.length };

    // No caching header games. What this carries is not a child's words, but it is a
    // per-session view behind a gate, and a shared cache holding it would serve one
    // adult's board to the next visitor.
    return Response.json(page, { status: 200, headers: { "cache-control": "no-store" } });
  } catch (cause) {
    // Server-side only. The response stays a bare code so nothing internal reaches a
    // browser, but an outage has to leave a trace somewhere.
    console.error("admin question board read failed", cause);
    return refuse(503, "questions-unavailable");
  }
}
