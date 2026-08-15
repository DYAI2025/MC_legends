import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guardAdminRequest } from "@/adapters/http/admin-request-guard";
import { ADMIN_SESSION_COOKIE } from "@/adapters/http/admin-session-cookie";
import { POST as adminSignIn } from "@/app/api/admin/session/route";
import { POST as familySignIn } from "@/app/api/family/session/route";
import type { RateLimiter } from "@/application/access/rate-limiter";
import {
  createAdminAccessGate,
  createFamilyAccessGate,
  resetRateLimitersForTest,
} from "@/composition/server";

/**
 * What happens when a deployment sets the admin code to the family code (MCL-50).
 *
 * Both gates are the same HMAC construction over the same SESSION_KEY_LABEL and the same
 * shared AVALORIA_SESSION_SECRET, so the ONLY thing separating an adult's token family
 * from a child's is that the two access codes differ. Set them equal and the two token
 * families become interchangeable: a session minted by the family gate verifies against
 * the admin gate. That is precisely the outcome MCL-50 exists to prevent - a child
 * holding the family code reading every sibling's answers - and nothing in the code, the
 * tests or .env.example noticed it.
 *
 * Measured before the fix, with both variables set to the same value:
 *   admin gate verifying a family-minted token -> granted
 * With distinct codes:
 *   admin gate verifying a family-minted token -> denied
 *
 * The structurally stronger fix is a per-audience domain label in the token derivation,
 * but that changes MCL-34's derivation and would invalidate every live family session,
 * so it is out of scope for this slice. Instead the composition root refuses to build a
 * usable admin gate in that configuration, and the admin surface fails closed.
 */

const SHARED_CODE = "der-gleiche-code-in-beiden-variablen";
const SESSION_SECRET = "test-session-secret";
const ADMIN_ENDPOINT = "http://localhost/api/admin/session";
const FAMILY_ENDPOINT = "http://localhost/api/family/session";

/** Lets everything through, so a case is only ever about the access decision. */
const permissive: RateLimiter = { tryConsume: () => true };

function signInRequest(endpoint: string, accessCode: string): Request {
  const body = JSON.stringify({ accessCode });
  return new Request(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body, "utf8")),
    },
    body,
  });
}

/** A token the FAMILY gate minted, which is what a child's browser would be carrying. */
function familyMintedToken(): string {
  const grant = createFamilyAccessGate().openSession(SHARED_CODE);
  if (grant.outcome !== "granted") {
    throw new Error(
      "fixture could not open a family session - the family gate must stay usable here",
    );
  }
  return grant.session.value;
}

beforeEach(() => {
  // The misconfiguration under test: one value in both variables.
  vi.stubEnv("AVALORIA_ADMIN_ACCESS_CODE", SHARED_CODE);
  vi.stubEnv("AVALORIA_FAMILY_ACCESS_CODE", SHARED_CODE);
  vi.stubEnv("AVALORIA_SESSION_SECRET", SESSION_SECRET);
  vi.stubEnv("AVALORIA_ADMIN_SESSION_RATE_LIMIT", undefined);
  vi.stubEnv("AVALORIA_ADMIN_SESSION_GLOBAL_RATE_LIMIT", undefined);
  vi.stubEnv("AVALORIA_SESSION_RATE_LIMIT", undefined);
  vi.stubEnv("AVALORIA_SESSION_GLOBAL_RATE_LIMIT", undefined);
  resetRateLimitersForTest();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetRateLimitersForTest();
});

describe("admin credentials shared with the family code", () => {
  it("makes the admin gate unavailable rather than usable", async () => {
    const gate = createAdminAccessGate();

    // Not "denied": denied would mean the gate is working and the code was wrong. The
    // configuration itself is broken, and the only safe answer is that there is no admin
    // gate to ask.
    expect(gate.openSession(SHARED_CODE).outcome).toBe("unavailable");
    expect(gate.verifySession(familyMintedToken()).outcome).toBe("unavailable");
  });

  it("refuses a family-minted token presented to the admin guard", () => {
    // The whole vulnerability in one case: this token was minted by the CHILD gate and
    // is being presented as an admin session. Before the fix the admin gate verified it
    // and this returned "granted".
    const asAdmin = new Request("http://localhost/api/admin/inbox/submissions", {
      method: "GET",
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${familyMintedToken()}` },
    });

    const outcome = guardAdminRequest(asAdmin, createAdminAccessGate(), permissive);

    expect(outcome).not.toBe("granted");
    expect(outcome).toBe("unavailable");
  });

  it("answers 503 at the admin sign-in even for the correct admin code", async () => {
    const response = await adminSignIn(signInRequest(ADMIN_ENDPOINT, SHARED_CODE));

    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
    await expect(response.json()).resolves.toEqual({
      authenticated: false,
      error: "gate-unavailable",
    });
  });

  it("still lets a child sign in, so only the admin side closed", async () => {
    // The point of the fix is to shut the ADMIN door, not to take the family site down.
    // A misconfigured admin code must never stop the children from submitting.
    const response = await familySignIn(signInRequest(FAMILY_ENDPOINT, SHARED_CODE));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ authenticated: true });
  });

  it("treats codes differing only by surrounding whitespace as identical", async () => {
    // HmacFamilyAccessGate trims what it is handed, so these two values ARE the same
    // secret as far as token derivation is concerned. A comparison that missed this
    // would leave the whole hole open to one stray space in a host UI.
    vi.stubEnv("AVALORIA_ADMIN_ACCESS_CODE", `  ${SHARED_CODE}  `);
    vi.stubEnv("AVALORIA_FAMILY_ACCESS_CODE", SHARED_CODE);

    expect(createAdminAccessGate().openSession(SHARED_CODE).outcome).toBe("unavailable");

    const response = await adminSignIn(signInRequest(ADMIN_ENDPOINT, SHARED_CODE));
    expect(response.status).toBe(503);
  });

  it("leaves the admin gate fully usable when the two codes differ", async () => {
    // The guard against overreach: the check must close the door ONLY on the collision.
    vi.stubEnv("AVALORIA_ADMIN_ACCESS_CODE", "ein-eigener-admin-code-nur-fuer-erwachsene");
    resetRateLimitersForTest();

    const response = await adminSignIn(
      signInRequest(ADMIN_ENDPOINT, "ein-eigener-admin-code-nur-fuer-erwachsene"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(`${ADMIN_SESSION_COOKIE}=`);
  });
});
