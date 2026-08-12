import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as sessionRoute from "@/app/api/family/session/route";
import { POST } from "@/app/api/family/session/route";
import { HmacFamilyAccessGate } from "@/adapters/access/hmac-family-access-gate";
import { FAMILY_SESSION_COOKIE, readFamilySessionCookie } from "@/adapters/http/family-session-cookie";
import { resetRateLimitersForTest } from "@/composition/server";
import { TEST_FAMILY_ACCESS_CODE } from "../support/family-access-code";

const ENDPOINT = "http://localhost/api/family/session";

/** Everything a refusal could carry out of the server and into a browser. */
const INTERNAL_DETAIL = /ENOTDIR|ENOENT|EACCES|node:|\/private\/|\/var\/folders\/|at Object|at async|Error:|stack/iu;

const environment = { ...process.env };

function postRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body, "utf8")),
      ...headers,
    },
    body,
  });
}

/**
 * Pins a refusal end to end: the status, the absence of a session cookie, and that the
 * raw bytes sent carry neither internal detail nor the configured access code.
 */
async function expectRefusal(response: Response, status: number, error: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("set-cookie")).toBeNull();

  const raw = await response.text();
  expect(raw, "a refusal must carry no internal detail").not.toMatch(INTERNAL_DETAIL);
  expect(raw, "a refusal must never echo the configured code").not.toContain(
    TEST_FAMILY_ACCESS_CODE,
  );
  expect(JSON.parse(raw)).toEqual({ authenticated: false, error });
}

beforeEach(() => {
  process.env.AVALORIA_FAMILY_ACCESS_CODE = TEST_FAMILY_ACCESS_CODE;
  delete process.env.AVALORIA_SESSION_SECRET;
  delete process.env.AVALORIA_SESSION_RATE_LIMIT;
  delete process.env.AVALORIA_SESSION_RATE_WINDOW_MS;
  resetRateLimitersForTest();
});

afterEach(() => {
  process.env = { ...environment };
  resetRateLimitersForTest();
});

describe("POST /api/family/session", () => {
  it("grants a verifiable session for the configured access code", async () => {
    const response = await POST(postRequest(JSON.stringify({ accessCode: TEST_FAMILY_ACCESS_CODE })));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ authenticated: true });

    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");

    // Not merely present: the value has to be one this server accepts back.
    const value = readFamilySessionCookie((setCookie as string).split(";")[0]);
    const gate = new HmacFamilyAccessGate({ accessCode: TEST_FAMILY_ACCESS_CODE });
    expect(gate.verifySession(value).outcome).toBe("granted");
  });

  it("never sends the configured access code back to the browser", async () => {
    const response = await POST(postRequest(JSON.stringify({ accessCode: TEST_FAMILY_ACCESS_CODE })));

    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).not.toContain(TEST_FAMILY_ACCESS_CODE);
    expect(await response.text()).not.toContain(TEST_FAMILY_ACCESS_CODE);
  });

  it("marks the cookie Secure behind an HTTPS proxy and leaves it unmarked on plain http", async () => {
    const behindProxy = await POST(
      postRequest(JSON.stringify({ accessCode: TEST_FAMILY_ACCESS_CODE }), {
        "x-forwarded-proto": "https",
      }),
    );
    expect(behindProxy.headers.get("set-cookie")).toContain("Secure");

    resetRateLimitersForTest();
    const local = await POST(postRequest(JSON.stringify({ accessCode: TEST_FAMILY_ACCESS_CODE })));
    expect(local.headers.get("set-cookie")).not.toContain("Secure");
  });

  it("refuses a wrong access code without a session", async () => {
    const response = await POST(postRequest(JSON.stringify({ accessCode: "falscher-code" })));

    await expectRefusal(response, 401, "invalid-credentials");
  });

  it("refuses a payload that carries no usable access code", async () => {
    for (const body of ["{}", JSON.stringify({ accessCode: "   " }), JSON.stringify({ accessCode: 42 }), JSON.stringify(["x"]), "{ not json"]) {
      resetRateLimitersForTest();
      await expectRefusal(await POST(postRequest(body)), 400, "invalid-payload");
    }
  });

  it("refuses a body that is not declared as JSON", async () => {
    const response = await POST(
      postRequest(JSON.stringify({ accessCode: TEST_FAMILY_ACCESS_CODE }), {
        "content-type": "text/plain",
      }),
    );

    await expectRefusal(response, 400, "invalid-payload");
  });

  it("refuses an oversized body without reading it", async () => {
    const body = JSON.stringify({ accessCode: TEST_FAMILY_ACCESS_CODE });
    const request = postRequest(body, { "content-length": "2048" });

    await expectRefusal(await POST(request), 400, "invalid-payload");
    expect(request.bodyUsed).toBe(false);
  });

  it("refuses an oversized body that declares no length at all", async () => {
    const response = await POST(
      new Request(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessCode: TEST_FAMILY_ACCESS_CODE, padding: "a".repeat(4096) }),
      }),
    );

    await expectRefusal(response, 400, "invalid-payload");
  });

  it("refuses an access code longer than the field allows", async () => {
    const response = await POST(postRequest(JSON.stringify({ accessCode: "a".repeat(201) })));

    await expectRefusal(response, 400, "invalid-payload");
  });

  it("fails closed with a fault when no access code is configured", async () => {
    delete process.env.AVALORIA_FAMILY_ACCESS_CODE;

    const response = await POST(postRequest(JSON.stringify({ accessCode: "irgendwas" })));

    // A server nobody can sign into, rather than a server anybody can sign into.
    await expectRefusal(response, 503, "gate-unavailable");
  });

  it("refuses further attempts from one caller once the limit is reached", async () => {
    process.env.AVALORIA_SESSION_RATE_LIMIT = "3";
    resetRateLimitersForTest();

    const attempt = () =>
      POST(
        postRequest(JSON.stringify({ accessCode: "raten-raten-raten" }), {
          "x-forwarded-for": "203.0.113.5",
        }),
      );

    for (let guess = 0; guess < 3; guess += 1) {
      expect((await attempt()).status).toBe(401);
    }

    await expectRefusal(await attempt(), 429, "too-many-requests");

    // And the correct code does not buy a way past the brake either.
    const withRightCode = await POST(
      postRequest(JSON.stringify({ accessCode: TEST_FAMILY_ACCESS_CODE }), {
        "x-forwarded-for": "203.0.113.5",
      }),
    );
    await expectRefusal(withRightCode, 429, "too-many-requests");
  });

  it("counts brute-force attempts per caller", async () => {
    process.env.AVALORIA_SESSION_RATE_LIMIT = "1";
    resetRateLimitersForTest();

    const guessFrom = (address: string) =>
      POST(
        postRequest(JSON.stringify({ accessCode: "falsch" }), { "x-forwarded-for": address }),
      );

    expect((await guessFrom("203.0.113.5")).status).toBe(401);
    expect((await guessFrom("203.0.113.5")).status).toBe(429);
    expect((await guessFrom("203.0.113.6")).status).toBe(401);
  });

  it("exposes no method beyond POST", () => {
    expect(Object.keys(sessionRoute).toSorted()).toEqual(["POST"]);
  });

  it("names the session cookie exactly once, where the adapter says", () => {
    expect(FAMILY_SESSION_COOKIE).toBe("avaloria_family_session");
  });
});
