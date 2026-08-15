import type { FamilySession } from "@/application/access/family-access";
import { isHttpsRequest, readSessionCookie } from "@/adapters/http/family-session-cookie";

/**
 * The admin session cookie (MCL-50).
 *
 * A different name from the family session on purpose, and the difference is not
 * cosmetic. The family access code is what the CHILDREN hold in order to submit. If the
 * protected read accepted that same session, any child with the family code could read
 * every sibling's answers. Two names plus two secrets means a family session presented
 * to an admin endpoint is simply absent, and an admin session presented to the child
 * write path is equally absent.
 *
 * This is an MVP boundary, not a role system. Jira MCL-50 puts the final production
 * role and consent policy explicitly out of scope, so what is built here is the
 * narrowest reversible thing that does not conflate a child with an adult: one extra
 * secret and one extra cookie name, reusing the MCL-34 HMAC mechanism unchanged.
 */
export const ADMIN_SESSION_COOKIE = "avaloria_admin_session";

export function readAdminSessionCookie(cookieHeader: string | null): string | null {
  return readSessionCookie(cookieHeader, ADMIN_SESSION_COOKIE);
}

/**
 * Builds the Set-Cookie value for a granted admin session.
 *
 * Same attributes as the family cookie and for the same reasons: HttpOnly so an XSS bug
 * cannot lift it, SameSite=Strict so a cross-site request carries no session at all,
 * Secure whenever the request arrived over HTTPS.
 *
 * `Path=/` rather than something narrower, which is worth justifying because narrower
 * would be the instinct. The admin surface is two subtrees - `/admin` for the page and
 * `/api/admin` for the data - and they share no prefix except `/`. Scoping to `/admin`
 * would mean the page loads and its own API calls arrive anonymous; scoping to
 * `/api/admin` would mean the page cannot tell whether anyone is signed in. Two cookies
 * would be two things to expire, revoke and get wrong. So the cookie is sent on
 * child-facing requests too, and what keeps that acceptable is HttpOnly plus the fact
 * that no child-facing route reads it - not the Path.
 */
export function adminSessionSetCookie(session: FamilySession, secure: boolean): string {
  const attributes = [
    `${ADMIN_SESSION_COOKIE}=${session.value}`,
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

export { isHttpsRequest };
