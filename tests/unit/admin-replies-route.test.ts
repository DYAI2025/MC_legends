import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/admin/inbox/submissions/[submissionId]/replies/route";
import { HmacFamilyAccessGate } from "@/adapters/access/hmac-family-access-gate";
import { FileSubmissionInboxStore } from "@/adapters/persistence/file-submission-inbox-store";
import { ADMIN_SESSION_COOKIE } from "@/adapters/http/admin-session-cookie";
import { FAMILY_SESSION_COOKIE } from "@/adapters/http/family-session-cookie";
import { resetRateLimitersForTest } from "@/composition/server";
import { TEST_FAMILY_ACCESS_CODE } from "../support/family-access-code";

/**
 * MCL-74. Writing a reply, and who may.
 *
 * The case that matters most here is the last one: a refused reply must not travel back
 * in the response body. A blocked name is a real person's name, and echoing it into an
 * HTTP response would put it in the one place the check exists to keep it out of - a
 * proxy log, a browser cache, an error report. The adult who typed it still has it on
 * screen; nobody else needs a copy.
 */

const ADMIN_CODE = "ein-eigener-admin-code-nur-fuer-erwachsene";
const SESSION_SECRET = "test-session-secret";
const BLOCKED_NAME = "Testkind";

let inboxDirectory = "";
let replyDirectory = "";
let adminCookie = "";

function endpoint(submissionId: string): string {
  return `http://localhost/api/admin/inbox/submissions/${submissionId}/replies`;
}

function cookieFor(name: string, accessCode: string): string {
  const grant = new HmacFamilyAccessGate({ accessCode, sessionSecret: SESSION_SECRET }).openSession(
    accessCode,
  );
  if (grant.outcome !== "granted") throw new Error("fixture could not open a session");
  return `${name}=${grant.session.value}`;
}

function params(submissionId: string) {
  return { params: Promise.resolve({ submissionId }) };
}

function post(
  submissionId: string,
  body: unknown,
  cookie: string = adminCookie,
): Request {
  const payload = JSON.stringify(body);
  return new Request(endpoint(submissionId), {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(payload)),
    },
    body: payload,
  });
}

const DRAFT = {
  understood: "Du möchtest einen Wolf, der leuchtet.",
  question: "Welche Farbe soll das Leuchten haben?",
};

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "avaloria-admin-replies-"));
  inboxDirectory = join(root, "inbox");
  replyDirectory = join(root, "replies");
  resetRateLimitersForTest();
  vi.stubEnv("AVALORIA_ADMIN_ACCESS_CODE", ADMIN_CODE);
  vi.stubEnv("AVALORIA_FAMILY_ACCESS_CODE", TEST_FAMILY_ACCESS_CODE);
  vi.stubEnv("AVALORIA_SESSION_SECRET", SESSION_SECRET);
  vi.stubEnv("AVALORIA_INBOX_DIR", inboxDirectory);
  vi.stubEnv("AVALORIA_REPLY_DIR", replyDirectory);
  vi.stubEnv("AVALORIA_REPLY_BLOCKED_NAMES", `${BLOCKED_NAME}, Musterkind`);
  vi.stubEnv("DATABASE_URL", undefined);
  adminCookie = cookieFor(ADMIN_SESSION_COOKIE, ADMIN_CODE);

  await new FileSubmissionInboxStore(inboxDirectory).appendIfAbsent({
    kind: "text",
    submissionId: "sub-1",
    questionId: "companion-animal",
    createdAt: "2026-09-10T08:00:00.000Z",
    receivedAt: "2026-09-10T08:00:01.000Z",
    receiptId: "receipt-1",
    originalText: "Ein Wolf der leuchtet",
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetRateLimitersForTest();
  await rm(join(inboxDirectory, ".."), { recursive: true, force: true });
});

describe("POST .../replies", () => {
  it("stores a well-formed reply and answers with it", async () => {
    const response = await POST(post("sub-1", DRAFT), params("sub-1"));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = (await response.json()) as { reply: { questionId: string; author: string } };
    expect(body.reply.questionId).toBe("reply:sub-1");
    expect(body.reply.author).toBe("human");
  });

  it("refuses a caller with no session before it reads a body", async () => {
    const response = await POST(post("sub-1", DRAFT, ""), params("sub-1"));
    expect(response.status).toBe(401);
  });

  it("refuses a family session: the code the children hold does not write replies", async () => {
    const cookie = cookieFor(FAMILY_SESSION_COOKIE, TEST_FAMILY_ACCESS_CODE);
    const response = await POST(post("sub-1", DRAFT, cookie), params("sub-1"));
    expect(response.status).toBe(401);
  });

  it("refuses a body that is not two strings", async () => {
    expect((await POST(post("sub-1", { understood: 1 }), params("sub-1"))).status).toBe(400);
    expect((await POST(post("sub-1", ["nope"]), params("sub-1"))).status).toBe(400);
  });

  it("names the shape problem so an adult can fix it", async () => {
    const response = await POST(
      post("sub-1", { ...DRAFT, question: "Welche Farbe? Und wie groß?" }),
      params("sub-1"),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid-payload",
      reason: "question-not-single",
    });
  });

  it("answers 404 for a submission the inbox does not hold, not 503", async () => {
    // No retry can make it exist. Reporting it as an outage would invite an adult to
    // keep pressing send.
    const response = await POST(post("sub-nope", DRAFT), params("sub-nope"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "unknown-submission" });
  });

  it("refuses a blocked name and never writes it back into the response", async () => {
    const response = await POST(
      post("sub-1", { ...DRAFT, understood: `${BLOCKED_NAME} hat das gesagt.` }),
      params("sub-1"),
    );

    expect(response.status).toBe(400);
    const raw = await response.text();
    expect(JSON.parse(raw)).toEqual({ error: "invalid-payload", reason: "blocked-name" });
    expect(raw).not.toContain(BLOCKED_NAME);
  });

  it("fails closed when no admin access code is configured", async () => {
    vi.stubEnv("AVALORIA_ADMIN_ACCESS_CODE", undefined);
    const response = await POST(post("sub-1", DRAFT), params("sub-1"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "replies-unavailable" });
  });

  it("treats a blank blocked-name list as no names rather than as no replies", async () => {
    vi.stubEnv("AVALORIA_REPLY_BLOCKED_NAMES", "");
    const response = await POST(post("sub-1", DRAFT), params("sub-1"));
    expect(response.status).toBe(201);
  });
});

describe("GET .../replies", () => {
  it("hands an adult the history of one submission, oldest first", async () => {
    await POST(post("sub-1", DRAFT), params("sub-1"));
    await POST(
      post("sub-1", { ...DRAFT, understood: "So war es gemeint." }),
      params("sub-1"),
    );

    const response = await GET(
      new Request(endpoint("sub-1"), { method: "GET", headers: { cookie: adminCookie } }),
      params("sub-1"),
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as { replies: { understood: string }[] };
    expect(body.replies).toHaveLength(2);
    expect(body.replies[0]?.understood).toBe(DRAFT.understood);
  });

  it("refuses a family session", async () => {
    const response = await GET(
      new Request(endpoint("sub-1"), {
        method: "GET",
        headers: { cookie: cookieFor(FAMILY_SESSION_COOKIE, TEST_FAMILY_ACCESS_CODE) },
      }),
      params("sub-1"),
    );
    expect(response.status).toBe(401);
  });
});
