import { readBoundedJson } from "@/adapters/http/bounded-json-body";
import { guardAdminRequest } from "@/adapters/http/admin-request-guard";
import type { QuestionState } from "@/domain/questions/question-lifecycle";
import { QuestionLifecyclePayloadError } from "@/application/questions/question-lifecycle";
import { questionById } from "@/content/open-questions";
import {
  createAdminAccessGate,
  createAdminRouteRateLimiter,
  createQuestionLifecycleLog,
} from "@/composition/server";

/**
 * Closing and reopening one question (MCL-35).
 *
 * The only write in the whole slice, and it is behind the admin identity of MCL-50 -
 * a separate secret from the one children hold, checked server-side from headers before
 * anything else happens. A family session is refused here exactly as an anonymous caller
 * is: the gate that verifies this cookie only knows the admin code, so there is no
 * argument at this call site that could admit a child.
 *
 * POST and nothing else. There is deliberately no DELETE: a question is never removed,
 * because the archive is the whole point. Next.js answers 405 for a verb this module does
 * not export, so the absence is the enforcement.
 *
 * What this route does NOT do is refuse submissions for a closed question. Rotation
 * decides what is OFFERED to a child, never what is accepted from one: an answer a child
 * had already written or recorded stays an answer to the question it was written for, and
 * closing that question must not throw their work away. The inbox routes are untouched by
 * this slice for exactly that reason.
 */

/** Generous for a two-field document, and small enough that a refusal costs nothing. */
const MAX_BODY_BYTES = 16 * 1024;

type QuestionChangeError =
  | "invalid-request"
  | "unauthorized"
  | "too-many-requests"
  | "stale-state"
  | "questions-unavailable";

/** Machine-readable codes only - never an exception message, path or stack trace. */
function refuse(status: 400 | 401 | 409 | 429 | 503, error: QuestionChangeError): Response {
  return Response.json({ error }, { status });
}

/**
 * The two verbs and the state each produces.
 *
 * A total table over what a client may ask for, so the request carries an intention and
 * this server decides what that means. Letting a client post a target state directly
 * would work identically today and would silently accept `nextState: "open"` from
 * something that thought it was closing a question.
 */
const REQUESTED_STATE = {
  close: "closed",
  reopen: "open",
} as const satisfies Record<string, QuestionState>;

type QuestionAction = keyof typeof REQUESTED_STATE;

function isAction(value: unknown): value is QuestionAction {
  return value === "close" || value === "reopen";
}

function isState(value: unknown): value is QuestionState {
  return value === "open" || value === "closed";
}

type ChangeRequest = Readonly<{ action: QuestionAction; expectedState: QuestionState }>;

/**
 * Reads the two fields, refusing anything else rather than defaulting it.
 *
 * `expectedState` has no default on purpose. A caller that omitted it would be saying
 * "close this whatever it is", and the whole concurrency contract is that a change is
 * applied only against a state the caller actually saw.
 */
function readChange(body: unknown): ChangeRequest | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }

  const source = body as Record<string, unknown>;

  if (!isAction(source.action) || !isState(source.expectedState)) {
    return null;
  }

  return { action: source.action, expectedState: source.expectedState };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ questionId: string }> },
): Promise<Response> {
  // First, and from headers alone. An unauthorised caller must not be able to make this
  // server parse a body, open a connection or touch the store.
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

  const { questionId } = await context.params;

  // The dataset is the authority on which questions exist. An id it does not know is
  // refused before anything is written, so the log cannot fill up with events for
  // questions no page can ever show.
  const question = questionById(questionId);
  if (question === null) {
    return refuse(400, "invalid-request");
  }

  const change = readChange(await readBoundedJson(request, MAX_BODY_BYTES));
  if (change === null) {
    return refuse(400, "invalid-request");
  }

  const nextState = REQUESTED_STATE[change.action];

  try {
    const outcome = await createQuestionLifecycleLog().append({
      questionId,
      nextState,
      expectedState: change.expectedState,
      // What the dataset seeds, for a question the store holds no event for. Read here
      // rather than in the store, because the store must not have to import content.
      seededState: question.state,
    });

    if (!outcome.applied) {
      // 409, not 400 and not 500: the request was well-formed and the caller was
      // entitled to make it - somebody else simply got there first. The state that
      // actually holds travels with it, so a board can correct itself rather than only
      // apologise.
      return Response.json(
        { error: "stale-state", currentState: outcome.currentState },
        { status: 409 },
      );
    }

    return Response.json(
      { state: outcome.event.nextState },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  } catch (cause) {
    if (cause instanceof QuestionLifecyclePayloadError) {
      // The store refused the values, not the request that carried them. 503 here would
      // report a permanent refusal as an outage and invite an endless retry. Logged as an
      // error all the same: a request the guards above let through and the store would
      // not hold is a hole in those guards.
      console.error("question lifecycle append refused the request", cause);
      return refuse(400, "invalid-request");
    }

    // Server-side only, and fail closed: an adult must not be able to act on a state
    // nobody could read. The board shows the failure rather than a guess.
    console.error("question lifecycle append failed", cause);
    return refuse(503, "questions-unavailable");
  }
}
