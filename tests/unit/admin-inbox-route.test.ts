import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as adminInboxRoute from "@/app/api/admin/inbox/submissions/route";
import { GET } from "@/app/api/admin/inbox/submissions/route";
import { HmacFamilyAccessGate } from "@/adapters/access/hmac-family-access-gate";
import { FileSubmissionInboxStore } from "@/adapters/persistence/file-submission-inbox-store";
import { ADMIN_SESSION_COOKIE } from "@/adapters/http/admin-session-cookie";
import { FAMILY_SESSION_COOKIE } from "@/adapters/http/family-session-cookie";
import type { InboxPage } from "@/application/submissions/submission-inbox-reader";
import { resetRateLimitersForTest } from "@/composition/server";
import { TEST_FAMILY_ACCESS_CODE } from "../support/family-access-code";

const ENDPOINT = "http://localhost/api/admin/inbox/submissions";
const ADMIN_CODE = "ein-eigener-admin-code-nur-fuer-erwachsene";
const SESSION_SECRET = "test-session-secret";


let directory = "";
let adminCookie = "";

function cookieFor(name: string, accessCode: string): string {
  const grant = new HmacFamilyAccessGate({
    accessCode,
    sessionSecret: SESSION_SECRET,
  }).openSession(accessCode);
  if (grant.outcome !== "granted") {
    throw new Error("fixture could not open a session");
  }
  return `${name}=${grant.session.value}`;
}

function get(query = "", headers: Record<string, string> = {}): Request {
  return new Request(`${ENDPOINT}${query}`, {
    method: "GET",
    headers: { cookie: adminCookie, ...headers },
  });
}

/** Deliberately without the cookie the helper above always adds. */
function anonymous(query = ""): Request {
  return new Request(`${ENDPOINT}${query}`, { method: "GET" });
}

async function seed(): Promise<void> {
  const store = new FileSubmissionInboxStore(directory);
  await store.appendIfAbsent({
    kind: "text",
    submissionId: "sub-1",
    questionId: "companion-animal",
    createdAt: "2026-08-13T08:00:00.000Z",
    receivedAt: "2026-08-13T09:00:00.000Z",
    receiptId: "receipt-1",
    originalText: "  ein drache mit  zwei koepfen  ",
  });
  await store.appendIfAbsent({
    kind: "text",
    submissionId: "sub-2",
    questionId: "hidden-door",
    createdAt: "2026-08-13T09:30:00.000Z",
    receivedAt: "2026-08-13T10:00:00.000Z",
    receiptId: "receipt-2",
    originalText: "hinter dem wasserfall",
  });
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "avaloria-admin-inbox-"));
  resetRateLimitersForTest();
  vi.stubEnv("AVALORIA_ADMIN_ACCESS_CODE", ADMIN_CODE);
  vi.stubEnv("AVALORIA_FAMILY_ACCESS_CODE", TEST_FAMILY_ACCESS_CODE);
  vi.stubEnv("AVALORIA_SESSION_SECRET", SESSION_SECRET);
  vi.stubEnv("AVALORIA_INBOX_DIR", directory);
  vi.stubEnv("DATABASE_URL", undefined);
  adminCookie = cookieFor(ADMIN_SESSION_COOKIE, ADMIN_CODE);
  await seed();
});

afterEach(async () => {
  // unstubAllEnvs and nothing else. Reassigning process.env here - the obvious-looking
  // belt-and-braces - swaps the object vitest recorded its stubs against, so the NEXT
  // test's vi.stubEnv(name, undefined) no longer deletes the key it was pointed at. The
  // symptom was a fail-closed test that passed alone and returned 200 in a full run:
  // the one shape of test failure that must never be shrugged off.
  vi.unstubAllEnvs();
  resetRateLimitersForTest();
  await rm(directory, { recursive: true, force: true });
});

describe("GET /api/admin/inbox/submissions", () => {
  it("returns the inbox newest-first to a signed-in admin", async () => {
    const response = await GET(get());

    expect(response.status).toBe(200);
    const page = (await response.json()) as InboxPage;
    expect(page.entries.map((entry) => entry.submissionId)).toEqual(["sub-2", "sub-1"]);
    expect(page.total).toBe(2);
  });

  it("carries the original text unchanged and the receipt alongside it", async () => {
    const page = (await (await GET(get())).json()) as InboxPage;
    const first = page.entries.find((entry) => entry.submissionId === "sub-1");

    expect(first?.originalText).toBe("  ein drache mit  zwei koepfen  ");
    expect(first?.receiptId).toBe("receipt-1");
    expect(first?.status).toBe("RECEIVED");
  });

  it("refuses an anonymous caller - there is no public read", async () => {
    const response = await GET(anonymous());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  /**
   * The boundary, asserted at the route and not only at the guard: a child's write
   * session must not open the admin read, or every child with the family code could
   * read every sibling's answers.
   */
  it("refuses a valid FAMILY session", async () => {
    const asChild = get("", {
      cookie: cookieFor(FAMILY_SESSION_COOKIE, TEST_FAMILY_ACCESS_CODE),
    });

    expect((await GET(asChild)).status).toBe(401);
  });

  it("fails closed when no admin access code is configured", async () => {
    vi.stubEnv("AVALORIA_ADMIN_ACCESS_CODE", undefined);

    const response = await GET(get());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "inbox-unavailable" });
  });

  it("fails closed when the admin access code is blank", async () => {
    vi.stubEnv("AVALORIA_ADMIN_ACCESS_CODE", "   ");

    expect((await GET(get())).status).toBe(503);
  });

  it("filters by question reference", async () => {
    const page = (await (await GET(get("?questionId=hidden-door"))).json()) as InboxPage;

    expect(page.entries.map((entry) => entry.submissionId)).toEqual(["sub-2"]);
    expect(page.total).toBe(1);
  });

  it("filters by status and by kind", async () => {
    expect(
      ((await (await GET(get("?status=RECEIVED"))).json()) as InboxPage).total,
    ).toBe(2);
    expect(((await (await GET(get("?kind=text"))).json()) as InboxPage).total).toBe(2);
  });

  /**
   * Refused, not ignored. A caller who asks for a status this server does not know and
   * is handed everything has been told something false about what they are looking at.
   */
  it("refuses an unknown filter value instead of ignoring it", async () => {
    for (const query of [
      "?status=PROCESSED",
      "?kind=audio",
      "?limit=0",
      "?limit=-1",
      "?limit=1.5",
      "?limit=abc",
      "?limit=5000",
      "?questionId=",
    ]) {
      const response = await GET(get(query));
      expect(response.status, `${query} must be refused`).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid-query" });
    }
  });

  it("never lets the response be stored in a shared cache", async () => {
    expect((await GET(get())).headers.get("cache-control")).toBe("no-store");
  });

  /**
   * "No change to the original through the UI" is held by the mutation verbs not
   * existing on this route at all. Pinned so a later edit cannot add one quietly.
   */
  it("exports no mutating handler", () => {
    expect(adminInboxRoute).not.toHaveProperty("POST");
    expect(adminInboxRoute).not.toHaveProperty("PUT");
    expect(adminInboxRoute).not.toHaveProperty("PATCH");
    expect(adminInboxRoute).not.toHaveProperty("DELETE");
  });

  it("rate-limits a signed-in admin asking too often", async () => {
    vi.stubEnv("AVALORIA_ADMIN_RATE_LIMIT", "1");
    resetRateLimitersForTest();

    expect((await GET(get())).status).toBe(200);
    const throttled = await GET(get());
    expect(throttled.status).toBe(429);
    expect(await throttled.json()).toEqual({ error: "too-many-requests" });
  });

  it("answers refusals with a bare code and no internal detail", async () => {
    const body = await (await GET(anonymous())).text();

    // Exact equality, not a list of things it must not contain. `{"error":"..."}` is
    // the whole response, and asserting the whole thing is the only version of this
    // check that cannot be satisfied by a body that also carries a stack trace.
    expect(body).toBe('{"error":"unauthorized"}');
  });
});
