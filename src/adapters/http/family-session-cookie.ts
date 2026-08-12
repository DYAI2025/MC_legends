import type { FamilySession } from "@/application/access/family-access";

export const FAMILY_SESSION_COOKIE = "avaloria_family_session";

/**
 * Reads the family session out of a Cookie header.
 *
 * Parsed here rather than with a framework helper so the same function serves the API
 * routes and any later caller, and so the behaviour is pinned by tests rather than by
 * whatever a helper happens to do with a duplicated or malformed pair.
 */
export function readFamilySessionCookie(cookieHeader: string | null): string | null {
  if (cookieHeader === null) {
    return null;
  }

  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) {
      continue;
    }

    if (pair.slice(0, separator).trim() !== FAMILY_SESSION_COOKIE) {
      continue;
    }

    const value = pair.slice(separator + 1).trim();
    return value.length === 0 ? null : value;
  }

  return null;
}

/**
 * Whether this request reached the app over HTTPS.
 *
 * The forwarded header is consulted first because the deployment terminates TLS in
 * front of the app, so the request URL the app sees is plain http even when the
 * browser used https. Local dev and the browser tests run on http://127.0.0.1 and
 * correctly get `false` - marking the cookie Secure there would mean the browser
 * silently dropped it and every test failed for the wrong reason.
 */
export function isHttpsRequest(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded !== null) {
    return forwarded.split(",")[0].trim().toLowerCase() === "https";
  }

  return new URL(request.url).protocol === "https:";
}

/**
 * Builds the Set-Cookie value for a granted session.
 *
 * HttpOnly: no script may read it, so an XSS bug cannot lift the session.
 * SameSite=Strict: a cross-site request carries no session at all, which is what
 * makes the protected POST safe against a form on another page.
 * Secure: set whenever the request arrived over HTTPS, so a real deployment never
 * sends this cookie in the clear.
 */
export function familySessionSetCookie(session: FamilySession, secure: boolean): string {
  const attributes = [
    `${FAMILY_SESSION_COOKIE}=${session.value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${session.maxAgeSeconds}`,
  ];

  if (secure) {
    attributes.push("Secure");
  }

  return attributes.join("; ");
}
