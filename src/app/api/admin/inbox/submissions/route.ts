import { guardAdminRequest } from "@/adapters/http/admin-request-guard";
import type {
  InboxEntryStatus,
  InboxQuery,
} from "@/application/submissions/submission-inbox-reader";
import { MAX_INBOX_PAGE_SIZE } from "@/application/submissions/submission-inbox-reader";
import {
  createAdminAccessGate,
  createAdminRouteRateLimiter,
  createSubmissionInboxReader,
} from "@/composition/server";

/**
 * The protected read side of the family inbox (MCL-50).
 *
 * GET and nothing else. There is deliberately no POST, PATCH, PUT or DELETE handler in
 * this module: "no change to the original text or audio through the UI" is an
 * acceptance criterion, and the strongest way to hold it is for the mutation verbs not
 * to exist rather than for them to exist and refuse. Next.js answers 405 for a verb the
 * route does not export, so the absence is the enforcement - and a test pins it, so a
 * later edit cannot reintroduce a writer here quietly.
 */

const KNOWN_STATUSES = ["RECEIVED"] as const satisfies readonly InboxEntryStatus[];
const KNOWN_KINDS = ["text"] as const;

/** Mirrors the questionId ceiling the write route and the schema already enforce. */
const MAX_QUESTION_ID_LENGTH = 200;

/**
 * Real type guards rather than `includes(value as T)`.
 *
 * The cast version compiles and reads the same, but it asserts the narrowing instead of
 * proving it - so widening either union without adding the new member to the list here
 * would still typecheck, and the route would refuse a value the rest of the system now
 * accepts. These fail to compile instead.
 */
function isKnownStatus(value: string): value is InboxEntryStatus {
  return (KNOWN_STATUSES as readonly string[]).includes(value);
}

function isKnownKind(value: string): value is (typeof KNOWN_KINDS)[number] {
  return (KNOWN_KINDS as readonly string[]).includes(value);
}

type AdminInboxError = "invalid-query" | "unauthorized" | "too-many-requests" | "inbox-unavailable";

/** Machine-readable codes only - never an exception message, path or stack trace. */
function refuse(status: 400 | 401 | 429 | 503, error: AdminInboxError): Response {
  return Response.json({ error }, { status });
}

/**
 * Reads the filters, refusing anything it does not recognise instead of ignoring it.
 *
 * Silently dropping an unknown filter is the dangerous option here: a caller who asks
 * for `?status=PROCESSED` and is handed every entry has been told something false about
 * what they are looking at, and they would have no way to notice. `null` means refuse.
 */
function readQuery(url: URL): InboxQuery | null {
  const query: {
    status?: InboxEntryStatus;
    kind?: "text";
    questionId?: string;
    limit?: number;
  } = {};

  const status = url.searchParams.get("status");
  if (status !== null) {
    if (!isKnownStatus(status)) {
      return null;
    }
    query.status = status;
  }

  const kind = url.searchParams.get("kind");
  if (kind !== null) {
    if (!isKnownKind(kind)) {
      return null;
    }
    query.kind = kind;
  }

  const questionId = url.searchParams.get("questionId");
  if (questionId !== null) {
    if (questionId.trim().length === 0 || questionId.length > MAX_QUESTION_ID_LENGTH) {
      return null;
    }
    query.questionId = questionId;
  }

  const limit = url.searchParams.get("limit");
  if (limit !== null) {
    const parsed = Number(limit);
    // Refused rather than clamped. A caller asking for 5000 has a different idea of the
    // page than this server does, and answering 200 without saying so lets them believe
    // they have seen everything.
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_INBOX_PAGE_SIZE) {
      return null;
    }
    query.limit = parsed;
  }

  return query;
}

export async function GET(request: Request): Promise<Response> {
  // First, and from headers alone. An unauthorised caller must not be able to make this
  // server parse a query, open a connection or touch the database.
  const access = guardAdminRequest(
    request,
    createAdminAccessGate(),
    createAdminRouteRateLimiter(),
  );

  if (access === "unavailable") {
    console.error("admin access gate unavailable: no admin access code configured");
    return refuse(503, "inbox-unavailable");
  }

  if (access === "unauthorized") {
    return refuse(401, "unauthorized");
  }

  if (access === "rate-limited") {
    return refuse(429, "too-many-requests");
  }

  const query = readQuery(new URL(request.url));
  if (query === null) {
    return refuse(400, "invalid-query");
  }

  try {
    const page = await createSubmissionInboxReader().list(query);

    // No caching header games: this response carries children's original words, and the
    // one thing it must never do is sit in a shared cache. Next.js treats a route
    // reading the request as dynamic already; this says it out loud.
    return Response.json(page, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  } catch (cause) {
    // Server-side only. The response stays a bare code so nothing internal reaches a
    // browser, but an outage has to leave a trace somewhere.
    console.error("admin inbox read failed", cause);
    return refuse(503, "inbox-unavailable");
  }
}
