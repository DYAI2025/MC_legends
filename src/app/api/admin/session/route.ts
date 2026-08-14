import { readBoundedJson } from "@/adapters/http/bounded-json-body";
import { adminSessionSetCookie, isHttpsRequest } from "@/adapters/http/admin-session-cookie";
import { clientAddress } from "@/adapters/http/family-request-guard";
import {
  createAdminAccessGate,
  createAdminSessionRateLimiter,
  createGlobalAdminSessionRateLimiter,
} from "@/composition/server";

/**
 * Admin sign-in for the protected inbox (MCL-50).
 *
 * A sibling of /api/family/session, not a mode of it. The two differ only in which
 * secret they verify against and which cookie they mint - and that is exactly the
 * difference no argument, flag or query parameter must be able to get wrong. An adult
 * signs in here; a child signs in there; neither endpoint can issue the other's session.
 *
 * POST only. There is nothing here to read back.
 */

/** A code and nothing else, matching the family route's ceiling. */
const MAX_BODY_BYTES = 1024;
const MAX_ACCESS_CODE_LENGTH = 200;

/** One constant key: the whole process shares this bucket, by design. */
const GLOBAL_SIGN_IN_KEY = "admin-session";

type AdminSessionError =
  | "invalid-payload"
  | "invalid-credentials"
  | "too-many-requests"
  | "gate-unavailable";

/** Machine-readable codes only - never an exception message, path or stack trace. */
function refuse(status: 400 | 401 | 429 | 503, error: AdminSessionError): Response {
  return Response.json({ authenticated: false, error }, { status });
}

function readAccessCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }

  const value = (body as Record<string, unknown>).accessCode;
  if (typeof value !== "string") {
    return null;
  }

  if (value.trim().length === 0 || value.length > MAX_ACCESS_CODE_LENGTH) {
    return null;
  }

  return value;
}

export async function POST(request: Request): Promise<Response> {
  // Both buckets before the body and before any comparison. The global one first and
  // deliberately: `clientAddress` reads caller-written headers, so the per-caller bucket
  // is one an attacker hands itself a fresh copy of by rotating x-forwarded-for. Only
  // the constant-key bucket is a real ceiling - and this is the endpoint where guessing
  // buys the most.
  if (!createGlobalAdminSessionRateLimiter().tryConsume(GLOBAL_SIGN_IN_KEY)) {
    return refuse(429, "too-many-requests");
  }

  if (!createAdminSessionRateLimiter().tryConsume(clientAddress(request))) {
    return refuse(429, "too-many-requests");
  }

  const body = await readBoundedJson(request, MAX_BODY_BYTES);
  const submittedCode = readAccessCode(body);
  if (submittedCode === null) {
    return refuse(400, "invalid-payload");
  }

  const grant = createAdminAccessGate().openSession(submittedCode);

  if (grant.outcome === "unavailable") {
    // No admin code configured. The door stays shut and says so as a fault rather than
    // a refusal, because nobody can get in until somebody fixes the deployment.
    console.error("admin access gate unavailable: no admin access code configured");
    return refuse(503, "gate-unavailable");
  }

  if (grant.outcome === "denied") {
    return refuse(401, "invalid-credentials");
  }

  return Response.json(
    { authenticated: true },
    {
      status: 200,
      headers: {
        "set-cookie": adminSessionSetCookie(grant.session, isHttpsRequest(request)),
        "cache-control": "no-store",
      },
    },
  );
}
