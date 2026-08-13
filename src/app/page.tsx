import { cookies } from "next/headers";
import { FamilyExperience } from "@/app/family-experience";
import { FAMILY_SESSION_COOKIE } from "@/adapters/http/family-session-cookie";
import { createFamilyAccessGate } from "@/composition/server";

/**
 * The page is a server component so the family session is verified where the secret
 * lives. The browser is told only whether it may write - never how that was decided,
 * and never with anything it could forge, because the answer is re-derived on the
 * server for every request.
 *
 * This is a rendering decision, not the access boundary. The protected route checks
 * the same session itself, so a client that lies about this flag gains nothing: it
 * would render a form whose every submission is refused with 401.
 */
export default async function HomePage() {
  const sessionValue = (await cookies()).get(FAMILY_SESSION_COOKIE)?.value ?? null;
  const check = createFamilyAccessGate().verifySession(sessionValue);

  // Only an explicit grant opens the form. An unavailable gate - no access code
  // configured - shows the sign-in panel like any other refusal, so a misconfigured
  // server never presents a writable surface.
  return <FamilyExperience familySessionActive={check.outcome === "granted"} />;
}
