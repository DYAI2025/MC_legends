import { describe, expect, it } from "vitest";
import { HmacFamilyAccessGate } from "@/adapters/access/hmac-family-access-gate";
import { InMemoryRateLimiter } from "@/adapters/access/in-memory-rate-limiter";
import {
  clientAddress,
  guardFamilyRequest,
} from "@/adapters/http/family-request-guard";
import type { RateLimiter } from "@/application/access/rate-limiter";
import { TEST_FAMILY_ACCESS_CODE } from "../support/family-access-code";
import { familySessionCookieHeader } from "../support/family-session-header";

const ENDPOINT = "http://localhost/api/inbox/submissions";

/**
 * No default parameter on purpose. `gate(undefined)` would silently fall back to a
 * default, and the unconfigured case below would then be testing a fully configured
 * gate - which is exactly how this test first passed while proving nothing.
 */
function gate(accessCode: string | undefined) {
  return new HmacFamilyAccessGate({ accessCode });
}

function configuredGate() {
  return gate(TEST_FAMILY_ACCESS_CODE);
}

function unconfiguredGate() {
  return gate(undefined);
}

/** Lets everything through, so a case is only ever about the access decision. */
const permissive: RateLimiter = { tryConsume: () => true };

function request(headers: Record<string, string> = {}): Request {
  return new Request(ENDPOINT, { method: "POST", headers, body: "{}" });
}

describe("guardFamilyRequest", () => {
  it("grants a request carrying a valid family session", () => {
    const signedIn = request({ cookie: familySessionCookieHeader(TEST_FAMILY_ACCESS_CODE) });

    expect(guardFamilyRequest(signedIn, configuredGate(), permissive)).toBe("granted");
  });

  it("refuses an anonymous request", () => {
    expect(guardFamilyRequest(request(), configuredGate(), permissive)).toBe("unauthorized");
  });

  it("refuses a forged or foreign session", () => {
    const forged = request({ cookie: "avaloria_family_session=v1.9999999999.nonce.forged" });
    const foreign = request({ cookie: familySessionCookieHeader("ein-ganz-anderer-code") });

    expect(guardFamilyRequest(forged, configuredGate(), permissive)).toBe("unauthorized");
    expect(guardFamilyRequest(foreign, configuredGate(), permissive)).toBe("unauthorized");
  });

  it("reports unavailable and grants nothing when no access code is configured", () => {
    const signedIn = request({ cookie: familySessionCookieHeader(TEST_FAMILY_ACCESS_CODE) });

    expect(guardFamilyRequest(signedIn, unconfiguredGate(), permissive)).toBe("unavailable");
    expect(guardFamilyRequest(request(), unconfiguredGate(), permissive)).toBe("unavailable");
  });

  it("does not spend an allowance on a request it refuses", () => {
    const limiter = new InMemoryRateLimiter({ limit: 1, windowMs: 60_000 });
    const signedIn = request({ cookie: familySessionCookieHeader(TEST_FAMILY_ACCESS_CODE) });

    // Ten anonymous attempts first. If they consumed the allowance, the valid caller
    // below would be rate limited by traffic that never proved anything.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(guardFamilyRequest(request(), configuredGate(), limiter)).toBe("unauthorized");
    }

    expect(guardFamilyRequest(signedIn, configuredGate(), limiter)).toBe("granted");
  });

  it("rate limits an authenticated caller that asks too often", () => {
    const limiter = new InMemoryRateLimiter({ limit: 2, windowMs: 60_000 });
    const cookie = familySessionCookieHeader(TEST_FAMILY_ACCESS_CODE);
    const address = { "x-forwarded-for": "203.0.113.7" };

    expect(guardFamilyRequest(request({ cookie, ...address }), configuredGate(), limiter)).toBe("granted");
    expect(guardFamilyRequest(request({ cookie, ...address }), configuredGate(), limiter)).toBe("granted");
    expect(guardFamilyRequest(request({ cookie, ...address }), configuredGate(), limiter)).toBe(
      "rate-limited",
    );
  });

  it("keeps two different families apart in the counter", () => {
    const limiter = new InMemoryRateLimiter({ limit: 1, windowMs: 60_000 });
    const first = familySessionCookieHeader(TEST_FAMILY_ACCESS_CODE);
    const second = familySessionCookieHeader(TEST_FAMILY_ACCESS_CODE);

    expect(first).not.toBe(second);
    expect(guardFamilyRequest(request({ cookie: first }), configuredGate(), limiter)).toBe("granted");
    expect(guardFamilyRequest(request({ cookie: second }), configuredGate(), limiter)).toBe("granted");
    expect(guardFamilyRequest(request({ cookie: first }), configuredGate(), limiter)).toBe("rate-limited");
  });
});

describe("clientAddress", () => {
  it("reads the first forwarded hop", () => {
    expect(clientAddress(request({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe(
      "203.0.113.7",
    );
  });

  it("falls back to the real-ip header and then to a shared bucket", () => {
    expect(clientAddress(request({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientAddress(request())).toBe("unknown");
    expect(clientAddress(request({ "x-forwarded-for": "  " }))).toBe("unknown");
  });
});
