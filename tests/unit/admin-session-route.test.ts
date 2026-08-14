import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as adminSessionRoute from "@/app/api/admin/session/route";
import { POST } from "@/app/api/admin/session/route";
import { HmacFamilyAccessGate } from "@/adapters/access/hmac-family-access-gate";
import {
  ADMIN_SESSION_COOKIE,
  readAdminSessionCookie,
} from "@/adapters/http/admin-session-cookie";
import { FAMILY_SESSION_COOKIE } from "@/adapters/http/family-session-cookie";
import { resetRateLimitersForTest } from "@/composition/server";
import { TEST_FAMILY_ACCESS_CODE } from "../support/family-access-code";

const ENDPOINT = "http://localhost/api/admin/session";
const ADMIN_CODE = "ein-eigener-admin-code-nur-fuer-erwachsene";
const SESSION_SECRET = "test-session-secret";

/** Everything a refusal could carry out of the server and into a browser. */
const INTERNAL_DETAIL =
  /ENOTDIR|ENOENT|EACCES|node:|\/private\/|\/var\/folders\/|at Object|at async|Error:|stack/iu;

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

async function expectRefusal(response: Response, status: number, error: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("set-cookie")).toBeNull();

  const raw = await response.text();
  expect(raw, "a refusal must carry no internal detail").not.toMatch(INTERNAL_DETAIL);
  expect(raw, "a refusal must never echo the admin code").not.toContain(ADMIN_CODE);
  expect(raw, "a refusal must never echo the family code").not.toContain(
    TEST_FAMILY_ACCESS_CODE,
  );
  expect(JSON.parse(raw)).toEqual({ authenticated: false, error });
}

beforeEach(() => {
  vi.stubEnv("AVALORIA_ADMIN_ACCESS_CODE", ADMIN_CODE);
  vi.stubEnv("AVALORIA_FAMILY_ACCESS_CODE", TEST_FAMILY_ACCESS_CODE);
  vi.stubEnv("AVALORIA_SESSION_SECRET", SESSION_SECRET);
  vi.stubEnv("AVALORIA_ADMIN_SESSION_RATE_LIMIT", undefined);
  vi.stubEnv("AVALORIA_ADMIN_SESSION_GLOBAL_RATE_LIMIT", undefined);
  resetRateLimitersForTest();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetRateLimitersForTest();
});

describe("POST /api/admin/session", () => {
  it("grants a verifiable admin session for the configured admin code", async () => {
    const response = await POST(postRequest(JSON.stringify({ accessCode: ADMIN_CODE })));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ authenticated: true });

    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie).toContain(`${ADMIN_SESSION_COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect(
      response.headers.get("cache-control"),
      "a sign-in answer must never be cached",
    ).toBe("no-store");

    // The cookie is one the admin gate itself accepts - not merely a well-shaped string.
    const value = readAdminSessionCookie(setCookie);
    const verified = new HmacFamilyAccessGate({
      accessCode: ADMIN_CODE,
      sessionSecret: SESSION_SECRET,
    }).verifySession(value);
    expect(verified.outcome).toBe("granted");
  });

  it("never mints a family session cookie", async () => {
    const response = await POST(postRequest(JSON.stringify({ accessCode: ADMIN_CODE })));

    // The whole separation would be undone by one wrong cookie name here.
    expect(response.headers.get("set-cookie")).not.toContain(FAMILY_SESSION_COOKIE);
  });

  it("refuses the FAMILY access code, which is what the children hold", async () => {
    // The single most important case in this file: if the family code opened an admin
    // session, every child could read every sibling's answers and the code would look
    // entirely correct.
    const response = await POST(
      postRequest(JSON.stringify({ accessCode: TEST_FAMILY_ACCESS_CODE })),
    );

    await expectRefusal(response, 401, "invalid-credentials");
  });

  it("refuses a wrong admin code", async () => {
    const response = await POST(postRequest(JSON.stringify({ accessCode: "nicht-der-code" })));

    await expectRefusal(response, 401, "invalid-credentials");
  });

  it("fails closed when no admin code is configured", async () => {
    vi.stubEnv("AVALORIA_ADMIN_ACCESS_CODE", undefined);

    const response = await POST(postRequest(JSON.stringify({ accessCode: ADMIN_CODE })));

    await expectRefusal(response, 503, "gate-unavailable");
  });

  it("fails closed when the admin code is configured blank", async () => {
    // A host UI that defines the variable and leaves it empty has not configured a
    // secret. Treating that as configured would open the door to the empty string.
    //
    // The SUBMITTED code has to be a non-blank one, and that is the whole point of this
    // case rather than an incidental detail. `readAccessCode` refuses a whitespace-only
    // submission with 400 before the gate is ever consulted, so a blank submission never
    // reaches the gate and this case would measure the payload validator instead - it
    // answers 400 whether the fail-closed branch is intact or deleted, so it separates
    // nothing. Sending the code that WOULD work if the variable were set reaches the gate
    // and pins the only thing worth pinning: a blank configured secret is not a
    // configured secret.
    vi.stubEnv("AVALORIA_ADMIN_ACCESS_CODE", "   ");

    const response = await POST(postRequest(JSON.stringify({ accessCode: ADMIN_CODE })));

    await expectRefusal(response, 503, "gate-unavailable");
  });

  it("rejects a payload that carries no access code", async () => {
    const response = await POST(postRequest(JSON.stringify({})));

    await expectRefusal(response, 400, "invalid-payload");
  });

  it("rejects a malformed body", async () => {
    const response = await POST(postRequest("{ this is not json"));

    await expectRefusal(response, 400, "invalid-payload");
  });

  it("refuses too many attempts from one caller", async () => {
    vi.stubEnv("AVALORIA_ADMIN_SESSION_RATE_LIMIT", "2");
    resetRateLimitersForTest();

    const wrong = () => POST(postRequest(JSON.stringify({ accessCode: "nein" })));
    expect((await wrong()).status).toBe(401);
    expect((await wrong()).status).toBe(401);

    await expectRefusal(await wrong(), 429, "too-many-requests");
  });

  it("holds a process-wide ceiling a rotated forwarding header cannot reset", async () => {
    vi.stubEnv("AVALORIA_ADMIN_SESSION_RATE_LIMIT", "1000");
    vi.stubEnv("AVALORIA_ADMIN_SESSION_GLOBAL_RATE_LIMIT", "2");
    resetRateLimitersForTest();

    const guess = (address: string) =>
      POST(postRequest(JSON.stringify({ accessCode: "nein" }), { "x-forwarded-for": address }));

    expect((await guess("10.0.0.1")).status).toBe(401);
    expect((await guess("10.0.0.2")).status).toBe(401);

    // A fresh address bought a fresh per-caller allowance, and the global bucket still
    // stopped it. That is the whole point of the second limiter.
    await expectRefusal(await guess("10.0.0.3"), 429, "too-many-requests");
  });

  it("exposes no method beyond POST", () => {
    expect(Object.keys(adminSessionRoute).toSorted()).toEqual(["POST"]);
  });
});
