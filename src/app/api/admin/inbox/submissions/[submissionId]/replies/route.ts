import { readBoundedJson } from "@/adapters/http/bounded-json-body";
import { guardAdminRequest } from "@/adapters/http/admin-request-guard";
import { composeReply } from "@/application/replies/compose-reply";
import { ReplyTargetError } from "@/application/replies/submission-reply-log";
import { childForbiddenVocabulary } from "@/content/content-source";
import {
  createAdminAccessGate,
  createAdminRouteRateLimiter,
  createReceiptId,
  createSubmissionReplyLog,
  createSubmissionReplyReader,
  replyBlockedNames,
} from "@/composition/server";

/**
 * Writing and reading one submission's replies (MCL-74).
 *
 * Behind the admin identity of MCL-50, and it has to be: this is the route that puts
 * words in front of a child. A family session is refused here exactly as an anonymous
 * caller is - the gate this route asks for only knows the admin code, so there is no
 * argument at this call site that could admit a child.
 *
 * POST appends; there is no PUT and no DELETE. A correction is a new reply, and the one
 * a child already heard read aloud stays readable afterwards. Next.js answers 405 for a
 * verb this module does not export, so the absence is the enforcement.
 */

/** Generous for a two-field document, and small enough that a refusal costs nothing. */
const MAX_BODY_BYTES = 16 * 1024;

type ReplyRouteError =
  | "invalid-payload"
  | "unauthorized"
  | "too-many-requests"
  | "unknown-submission"
  | "replies-unavailable";

/** Machine-readable codes only - never an exception message, path or stack trace. */
function refuse(status: 400 | 401 | 404 | 429 | 503, error: ReplyRouteError): Response {
  return Response.json({ error }, { status });
}

type Draft = Readonly<{ understood: string; question: string }>;

function readDraft(body: unknown): Draft | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const source = body as Record<string, unknown>;
  if (typeof source.understood !== "string" || typeof source.question !== "string") return null;
  return { understood: source.understood, question: source.question };
}

function guard(request: Request): "granted" | Response {
  const access = guardAdminRequest(request, createAdminAccessGate(), createAdminRouteRateLimiter());

  if (access === "unavailable") {
    console.error("admin access gate unavailable: no admin access code configured");
    return refuse(503, "replies-unavailable");
  }
  if (access === "unauthorized") return refuse(401, "unauthorized");
  if (access === "rate-limited") return refuse(429, "too-many-requests");
  return "granted";
}

export async function POST(
  request: Request,
  context: { params: Promise<{ submissionId: string }> },
): Promise<Response> {
  // First, and from headers alone. An unauthorised caller must not be able to make this
  // server parse a body, open a connection or touch the store.
  const access = guard(request);
  if (access !== "granted") return access;

  const { submissionId } = await context.params;
  const draft = readDraft(await readBoundedJson(request, MAX_BODY_BYTES));
  if (draft === null) return refuse(400, "invalid-payload");

  const composed = composeReply(
    { submissionId, understood: draft.understood, question: draft.question, author: "human" },
    {
      forbiddenVocabulary: childForbiddenVocabulary,
      blockedNames: replyBlockedNames(),
      createId: createReceiptId,
      now: () => new Date(),
    },
  );

  if (!composed.ok) {
    /*
      The reason code travels; the text that caused it never does.

      That is the whole point of answering with a code here. A body echoing the refused
      sentence back would put a configured name into an HTTP response - the one place
      this check exists to keep it out of - where it would land in a proxy log, a browser
      cache and an error report. The adult who typed it still has it on screen.
    */
    return Response.json({ error: "invalid-payload", reason: composed.reason }, { status: 400 });
  }

  try {
    await createSubmissionReplyLog().append(composed.reply);
    return Response.json(
      { reply: composed.reply },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (cause) {
    if (cause instanceof ReplyTargetError) {
      // 404, not 503: the submission does not exist, and no retry will make it exist.
      // Reporting it as an outage would invite an adult to keep pressing send.
      return refuse(404, "unknown-submission");
    }
    // Server-side only, and fail closed.
    console.error("submission reply append failed", cause);
    return refuse(503, "replies-unavailable");
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ submissionId: string }> },
): Promise<Response> {
  const access = guard(request);
  if (access !== "granted") return access;

  const { submissionId } = await context.params;

  try {
    const replies = await createSubmissionReplyReader().listForSubmission(submissionId);
    return Response.json({ replies }, { status: 200, headers: { "cache-control": "no-store" } });
  } catch (cause) {
    console.error("submission reply read failed", cause);
    return refuse(503, "replies-unavailable");
  }
}
