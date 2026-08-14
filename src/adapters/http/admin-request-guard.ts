import { createHash } from "node:crypto";
import type {
  FamilyAccessGate,
  ProtectedRequestOutcome,
} from "@/application/access/family-access";
import type { RateLimiter } from "@/application/access/rate-limiter";
import { readAdminSessionCookie } from "@/adapters/http/admin-session-cookie";
import { clientAddress } from "@/adapters/http/family-request-guard";

/**
 * The server-side gate every protected ADMIN endpoint goes through (MCL-50).
 *
 * Deliberately a sibling of guardFamilyRequest rather than a parameter on it. The two
 * differ only in which cookie they read and which gate they are handed - but that is
 * exactly the difference that must not be possible to get wrong by passing the wrong
 * argument at one call site. A caller cannot accidentally admit a child here, because
 * there is no argument that would make it.
 *
 * It decides from headers alone: no body is read, so an unauthorised caller costs this
 * server nothing but a cookie parse.
 *
 * The gate implementation is shared with MCL-34 (the same HMAC construction), and that
 * sharing is the point - it is the *identity* that is separate, not the mechanism.
 */
export function guardAdminRequest(
  request: Request,
  gate: FamilyAccessGate,
  rateLimiter: RateLimiter,
): ProtectedRequestOutcome {
  const sessionValue = readAdminSessionCookie(request.headers.get("cookie"));
  const check = gate.verifySession(sessionValue);

  if (check.outcome === "unavailable") {
    // No admin access code configured. Fail closed, always. An unset secret must shut
    // the door rather than open it - the same rule MCL-34 already holds the family gate
    // to, restated here because a second gate is a second chance to get it wrong.
    return "unavailable";
  }

  if (check.outcome === "denied") {
    return "unauthorized";
  }

  // Keyed by session *and* client address, as on the family path: session alone would
  // let a caller reset its own allowance by signing in again, address alone would put a
  // whole household behind one counter.
  if (!rateLimiter.tryConsume(`admin|${clientAddress(request)}|${fingerprint(sessionValue)}`)) {
    return "rate-limited";
  }

  return "granted";
}

/** Never the session value itself: rate-limit keys end up in memory and in dumps. */
function fingerprint(sessionValue: string | null): string {
  return sessionValue === null
    ? "none"
    : createHash("sha256").update(sessionValue, "utf8").digest("base64url").slice(0, 22);
}
