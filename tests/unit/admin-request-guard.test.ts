import { describe, expect, it } from "vitest";
import { HmacFamilyAccessGate } from "@/adapters/access/hmac-family-access-gate";
import { InMemoryRateLimiter } from "@/adapters/access/in-memory-rate-limiter";
import { guardAdminRequest } from "@/adapters/http/admin-request-guard";
import { ADMIN_SESSION_COOKIE } from "@/adapters/http/admin-session-cookie";
import { FAMILY_SESSION_COOKIE } from "@/adapters/http/family-session-cookie";
import type { RateLimiter } from "@/application/access/rate-limiter";
import { TEST_FAMILY_ACCESS_CODE } from "../support/family-access-code";

const ENDPOINT = "http://localhost/api/admin/inbox/submissions";

const TEST_ADMIN_ACCESS_CODE = "ein-eigener-admin-code-nur-fuer-erwachsene";

/**
 * No default parameter, for the same reason the family guard's test has none: a default
 * would let the unconfigured case below run against a configured gate and pass while
 * proving nothing.
 */
function gate(accessCode: string | undefined) {
  return new HmacFamilyAccessGate({ accessCode });
}

/** Lets everything through, so a case is only ever about the access decision. */
const permissive: RateLimiter = { tryConsume: () => true };

function request(headers: Record<string, string> = {}): Request {
  return new Request(ENDPOINT, { method: "GET", headers });
}

/** A session value the given gate would accept, as a cookie under the given name. */
function sessionCookie(name: string, accessCode: string): string {
  const grant = gate(accessCode).openSession(accessCode);
  if (grant.outcome !== "granted") {
    throw new Error("fixture could not open a session - the gate refused its own code");
  }
  return `${name}=${grant.session.value}`;
}

describe("guardAdminRequest", () => {
  it("grants a request carrying a valid admin session", () => {
    const signedIn = request({
      cookie: sessionCookie(ADMIN_SESSION_COOKIE, TEST_ADMIN_ACCESS_CODE),
    });

    expect(guardAdminRequest(signedIn, gate(TEST_ADMIN_ACCESS_CODE), permissive)).toBe(
      "granted",
    );
  });

  it("refuses an anonymous request", () => {
    expect(guardAdminRequest(request(), gate(TEST_ADMIN_ACCESS_CODE), permissive)).toBe(
      "unauthorized",
    );
  });

  /**
   * The case this whole guard exists for.
   *
   * The family access code is the code the CHILDREN use to submit. If the admin read
   * accepted the family session, every child holding that code could read every other
   * child's answers - and nothing in the code would look wrong, because it would be the
   * same gate, the same mechanism and the same cookie shape. The boundary is only real
   * if a family session is rejected here, so that is asserted directly rather than left
   * to follow from the cookie names.
   */
  it("refuses a valid FAMILY session - a child's write session is not an admin identity", () => {
    const asChild = request({
      cookie: sessionCookie(FAMILY_SESSION_COOKIE, TEST_FAMILY_ACCESS_CODE),
    });

    expect(guardAdminRequest(asChild, gate(TEST_ADMIN_ACCESS_CODE), permissive)).toBe(
      "unauthorized",
    );
  });

  /**
   * The other half of that boundary: not just the wrong cookie name, but the family
   * secret itself presented under the admin cookie name. If both gates were built from
   * the same access code, this would pass - and the separation would be cosmetic.
   */
  it("refuses the family code even when it arrives under the admin cookie name", () => {
    const smuggled = request({
      cookie: sessionCookie(ADMIN_SESSION_COOKIE, TEST_FAMILY_ACCESS_CODE),
    });

    expect(guardAdminRequest(smuggled, gate(TEST_ADMIN_ACCESS_CODE), permissive)).toBe(
      "unauthorized",
    );
  });

  it("refuses a forged session", () => {
    const forged = request({
      cookie: `${ADMIN_SESSION_COOKIE}=v1.9999999999.nonce.forged`,
    });

    expect(guardAdminRequest(forged, gate(TEST_ADMIN_ACCESS_CODE), permissive)).toBe(
      "unauthorized",
    );
  });

  /**
   * Fail closed. An unset admin code must never mean "no gate configured, so let
   * everyone in" - it is the exact mistake MCL-34 already forbids for the family code,
   * and it must not be reintroduced by a second gate.
   */
  it("answers unavailable rather than granting when no admin access code is configured", () => {
    const signedIn = request({
      cookie: sessionCookie(ADMIN_SESSION_COOKIE, TEST_ADMIN_ACCESS_CODE),
    });

    expect(guardAdminRequest(signedIn, gate(undefined), permissive)).toBe("unavailable");
    expect(guardAdminRequest(signedIn, gate("   "), permissive)).toBe("unavailable");
  });

  it("rate-limits a valid caller asking too often", () => {
    const limiter = new InMemoryRateLimiter({ limit: 1, windowMs: 60_000 });
    // ONE session, reused - which is what a caller repeating a request actually does.
    const cookie = sessionCookie(ADMIN_SESSION_COOKIE, TEST_ADMIN_ACCESS_CODE);

    expect(guardAdminRequest(request({ cookie }), gate(TEST_ADMIN_ACCESS_CODE), limiter)).toBe(
      "granted",
    );
    expect(guardAdminRequest(request({ cookie }), gate(TEST_ADMIN_ACCESS_CODE), limiter)).toBe(
      "rate-limited",
    );
  });

  /**
   * The limiter's honest boundary, pinned so nobody reads more protection into it than
   * it has: the key includes a fingerprint of the session, so a caller who signs in
   * again gets a fresh allowance. That is inherited from the MCL-34 guard and is not a
   * bug here - what bounds it is that signing in is itself rate limited, per address and
   * by a process-wide ceiling. Written down because the alternative is somebody later
   * treating this limiter as a defence it is not.
   */
  it("gives a NEW session its own allowance - the brake is on sign-in, not here", () => {
    const limiter = new InMemoryRateLimiter({ limit: 1, windowMs: 60_000 });
    const first = sessionCookie(ADMIN_SESSION_COOKIE, TEST_ADMIN_ACCESS_CODE);

    expect(
      guardAdminRequest(request({ cookie: first }), gate(TEST_ADMIN_ACCESS_CODE), limiter),
    ).toBe("granted");
    expect(
      guardAdminRequest(request({ cookie: first }), gate(TEST_ADMIN_ACCESS_CODE), limiter),
    ).toBe("rate-limited");

    const second = sessionCookie(ADMIN_SESSION_COOKIE, TEST_ADMIN_ACCESS_CODE);
    expect(second).not.toBe(first);
    expect(
      guardAdminRequest(request({ cookie: second }), gate(TEST_ADMIN_ACCESS_CODE), limiter),
    ).toBe("granted");
  });

  /**
   * The decision must not depend on the body, so an unauthorised caller cannot make this
   * server read, decode or parse a single byte of one.
   */
  it("decides from headers alone without consuming the request body", async () => {
    const withBody = new Request(ENDPOINT, { method: "POST", body: "{}" });

    expect(guardAdminRequest(withBody, gate(TEST_ADMIN_ACCESS_CODE), permissive)).toBe(
      "unauthorized",
    );
    expect(withBody.bodyUsed).toBe(false);
  });
});
