import { createHash } from "node:crypto";
import type {
  FamilyAccessGate,
  ProtectedRequestOutcome,
} from "@/application/access/family-access";
import type { RateLimiter } from "@/application/access/rate-limiter";
import { readFamilySessionCookie } from "@/adapters/http/family-session-cookie";

/**
 * The single server-side gate every protected family endpoint goes through.
 *
 * Written as one function taking its two collaborators so the protected read/admin
 * flow of MCL-50 can reuse it unchanged instead of writing a second, subtly different
 * check. It decides from headers alone: no body is read, so an unauthorised caller
 * costs this server nothing but a cookie parse.
 */
export function guardFamilyRequest(
  request: Request,
  gate: FamilyAccessGate,
  rateLimiter: RateLimiter,
): ProtectedRequestOutcome {
  const sessionValue = readFamilySessionCookie(request.headers.get("cookie"));
  const check = gate.verifySession(sessionValue);

  if (check.outcome === "unavailable") {
    return "unavailable";
  }

  if (check.outcome === "denied") {
    return "unauthorized";
  }

  // Keyed by session *and* client address. Session alone would let a caller reset its
  // own allowance by signing in again; address alone would put a whole household
  // behind one counter. Signing in again is itself rate limited by address.
  if (!rateLimiter.tryConsume(`${clientAddress(request)}|${fingerprint(sessionValue)}`)) {
    return "rate-limited";
  }

  return "granted";
}

/**
 * Rate-limit key for a caller that has no session yet, used by the sign-in endpoint.
 *
 * `x-forwarded-for` is client-controlled and can be spoofed; this is an MVP brake, not
 * an identity. It is documented as such rather than dressed up.
 */
export function clientAddress(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded !== null) {
    const first = forwarded.split(",")[0].trim();
    if (first.length > 0) {
      return first;
    }
  }

  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

/** Never the session value itself: rate-limit keys end up in memory and in dumps. */
function fingerprint(sessionValue: string | null): string {
  return sessionValue === null
    ? "none"
    : createHash("sha256").update(sessionValue, "utf8").digest("base64url").slice(0, 22);
}
