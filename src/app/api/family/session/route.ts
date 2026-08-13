import { readBoundedJson } from "@/adapters/http/bounded-json-body";
import { clientAddress } from "@/adapters/http/family-request-guard";
import {
  familySessionSetCookie,
  isHttpsRequest,
} from "@/adapters/http/family-session-cookie";
import {
  createFamilyAccessGate,
  createFamilySessionRateLimiter,
  createGlobalFamilySessionRateLimiter,
} from "@/composition/server";

/**
 * Sign-in for the private family MVP (MCL-34).
 *
 * The family sends the shared access code once; the server compares it against a
 * server-only secret and answers with an HttpOnly session cookie. The secret itself
 * never appears in a response, in the cookie, or in anything the browser can read -
 * what the cookie carries is an expiry and an HMAC over it.
 *
 * POST only, and no method that reads anything back: there is nothing here to read.
 */

/** A code and nothing else. Far below the inbox limit, because far less is expected. */
const MAX_BODY_BYTES = 1024;
const MAX_ACCESS_CODE_LENGTH = 200;

/** One constant key: the whole process shares this bucket, by design. */
const GLOBAL_SIGN_IN_KEY = "family-session";

type SessionError = "invalid-payload" | "invalid-credentials" | "too-many-requests" | "gate-unavailable";

/** Machine-readable codes only - never an exception message, path or stack trace. */
function refuse(status: 400 | 401 | 429 | 503, error: SessionError): Response {
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
  // Before the body, and before any comparison: a brute-force attempt must be cheap to
  // refuse, and guessing a shared code is exactly what this endpoint invites.
  //
  // The process-wide bucket is consumed first and deliberately: `clientAddress` reads
  // caller-written headers, so the per-caller bucket below is one an attacker can hand
  // itself a fresh copy of by rotating `x-forwarded-for`. The global bucket has a single
  // constant key and cannot be reset that way, which is what makes the ceiling real.
  // The per-caller bucket stays because it is what keeps one noisy caller from spending
  // the whole household's allowance.
  if (!createGlobalFamilySessionRateLimiter().tryConsume(GLOBAL_SIGN_IN_KEY)) {
    return refuse(429, "too-many-requests");
  }

  if (!createFamilySessionRateLimiter().tryConsume(clientAddress(request))) {
    return refuse(429, "too-many-requests");
  }

  const body = await readBoundedJson(request, MAX_BODY_BYTES);
  const submittedCode = readAccessCode(body);
  if (submittedCode === null) {
    return refuse(400, "invalid-payload");
  }

  const grant = createFamilyAccessGate().openSession(submittedCode);

  if (grant.outcome === "unavailable") {
    // No access code is configured server-side. The door stays shut - and says so as a
    // fault rather than as a refusal, because nobody can get in until it is fixed.
    console.error("family access gate unavailable: no access code configured");
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
        "set-cookie": familySessionSetCookie(grant.session, isHttpsRequest(request)),
        // A sign-in answer must never be reused from a cache by anyone.
        "cache-control": "no-store",
      },
    },
  );
}
