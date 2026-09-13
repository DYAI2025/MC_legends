import { guardFamilyRequest } from "@/adapters/http/family-request-guard";
import {
  MAX_REPLY_PAGE_SIZE,
  type ReplyView,
} from "@/application/replies/submission-reply-reader";
import {
  createFamilyAccessGate,
  createProtectedRouteRateLimiter,
  createSubmissionReplyReader,
} from "@/composition/server";

/**
 * The household's replies, for the child's own page (MCL-74).
 *
 * Behind the family gate, and behind the same rate limiter the inbox write uses: a page
 * left open on a tablet polls this, and the honest ceiling for "how often may this
 * household ask" is the one already chosen for that household.
 *
 * Per household rather than per child. The family session is one code for the family
 * (MCL-34), so this route cannot tell two children apart and does not pretend to - it is
 * a documented limit of the Family MVP, written down in docs/ops/MCL-74-family-reply.md
 * rather than papered over with a guess about who is holding the tablet.
 *
 * GET only. Nothing a child's browser sends may write a reply.
 */

type FamilyReplyError = "invalid-request" | "unauthorized" | "too-many-requests" | "replies-unavailable";

function refuse(status: 400 | 401 | 429 | 503, error: FamilyReplyError): Response {
  return Response.json({ error }, { status });
}

/**
 * Exactly what a child's browser is allowed to know about a reply.
 *
 * Built field by field rather than by spreading the view. A spread would ship whatever
 * the read port grows next - `status`, an author, an internal id - to the one surface
 * that must never receive it, and it would do so silently, in a release nobody thought
 * was about this route. The snapshot test beside this file pins the key set for the same
 * reason.
 *
 * `status` and `author` are both deliberately absent. `status` is an adult's word for an
 * adult's problem. `author` is sharper: the reader already excludes `fallback`, but a
 * `{author: "llm", status: "ready"}` reply is a shape MCL-76 will legitimately write, and
 * shipping the field would put "a machine wrote this" in the browser of a child whose
 * card says "Papa hat geantwortet". Whether and how that is ever disclosed is a product
 * decision for MCL-76, not a field that leaks ahead of it.
 */
function forChild(view: ReplyView) {
  return {
    reply: {
      replyId: view.reply.replyId,
      submissionId: view.reply.submissionId,
      understood: view.reply.understood,
      question: view.reply.question,
      questionId: view.reply.questionId,
      createdAt: view.reply.createdAt,
    },
    submission: {
      submissionId: view.submission.submissionId,
      kind: view.submission.kind,
      questionId: view.submission.questionId,
      createdAt: view.submission.createdAt,
      originalTextExcerpt: view.submission.originalTextExcerpt,
    },
  };
}

export async function GET(request: Request): Promise<Response> {
  const access = guardFamilyRequest(
    request,
    createFamilyAccessGate(),
    createProtectedRouteRateLimiter(),
  );

  if (access === "unavailable") {
    console.error("family access gate unavailable: no family access code configured");
    return refuse(503, "replies-unavailable");
  }
  if (access === "unauthorized") return refuse(401, "unauthorized");
  if (access === "rate-limited") return refuse(429, "too-many-requests");

  const url = new URL(request.url);
  const rawSince = url.searchParams.get("since");
  const rawLimit = url.searchParams.get("limit");

  let since: string | undefined;
  if (rawSince !== null) {
    // Refused, never ignored. A `since` this server could not read would silently become
    // "everything", and a poll would quietly re-deliver the whole list every minute.
    if (rawSince.trim().length === 0 || Number.isNaN(Date.parse(rawSince))) {
      return refuse(400, "invalid-request");
    }
    since = new Date(rawSince).toISOString();
  }

  let limit: number | undefined;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    // Refused rather than clamped, exactly as the admin inbox route refuses an
    // out-of-range limit: a caller asking for 5000 has a bug, and quietly answering with
    // 100 hides it.
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_REPLY_PAGE_SIZE) {
      return refuse(400, "invalid-request");
    }
    limit = parsed;
  }

  try {
    const views = await createSubmissionReplyReader().latestForHousehold({ since, limit });
    return Response.json(
      { replies: views.map(forChild) },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  } catch (cause) {
    // Server-side only. The child surface draws nothing new rather than an error.
    console.error("family reply read failed", cause);
    return refuse(503, "replies-unavailable");
  }
}
