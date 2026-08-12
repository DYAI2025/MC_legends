import { HmacFamilyAccessGate } from "@/adapters/access/hmac-family-access-gate";
import { FAMILY_SESSION_COOKIE } from "@/adapters/http/family-session-cookie";

/**
 * A Cookie header carrying a genuine family session.
 *
 * Minted through the real gate rather than hand-written, so a test cannot pass with a
 * token the production code would reject - and so a change to the token shape breaks
 * here loudly instead of leaving these tests exercising a format nobody issues.
 */
export function familySessionCookieHeader(accessCode: string): string {
  const grant = new HmacFamilyAccessGate({ accessCode }).openSession(accessCode);

  if (grant.outcome !== "granted") {
    throw new Error(`expected the gate to grant a session, got ${grant.outcome}`);
  }

  return `${FAMILY_SESSION_COOKIE}=${grant.session.value}`;
}
