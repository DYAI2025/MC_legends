import { cookies } from "next/headers";
import { ADMIN_SESSION_COOKIE } from "@/adapters/http/admin-session-cookie";
import { AdminAccessGate } from "@/app/components/admin-access-gate";
import { AdminInboxView } from "@/app/components/admin-inbox-view";
import { createAdminAccessGate } from "@/composition/server";

/**
 * Never prerendered, never cached.
 *
 * What this page renders is a function of one visitor's cookie, so a cached copy is one
 * visitor's answer served to the next: a static build would have no cookie at all and
 * would ship the sign-in panel to everybody, and a cached dynamic render would ship the
 * first signed-in adult's inbox shell to an anonymous visitor. `cookies()` already opts
 * this route out of static rendering in Next.js, which makes this line redundant today -
 * it is here so that the guarantee does not depend on that implementation detail
 * surviving a refactor or a framework upgrade.
 *
 * It does not weaken the boundary either way: the data behind the shell comes from
 * `GET /api/admin/inbox/submissions`, which re-checks the session on every request.
 */
export const dynamic = "force-dynamic";

/**
 * The protected admin surface (MCL-50).
 *
 * A server component, so the admin session is verified where the secret lives. The
 * browser is told only whether it may read - never how that was decided, and never with
 * anything it could forge, because the answer is re-derived on the server for every
 * request.
 *
 * This is a rendering decision, not the access boundary. `GET /api/admin/inbox/submissions`
 * checks the same session itself, so a client that lied about this would render a view
 * whose every request is refused with 401 and which therefore shows nothing.
 */
export default async function AdminPage() {
  const sessionValue = (await cookies()).get(ADMIN_SESSION_COOKIE)?.value ?? null;
  const check = createAdminAccessGate().verifySession(sessionValue);

  // Only an explicit grant opens the inbox. An unavailable gate - no admin code
  // configured - shows the sign-in panel like any other refusal, so a misconfigured
  // server never presents submission data.
  const signedIn = check.outcome === "granted";

  return (
    <main className="page">
      <h1>Projekt-Postfach</h1>
      {signedIn ? <AdminInboxView /> : <AdminAccessGate />}
    </main>
  );
}
