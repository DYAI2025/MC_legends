import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/family/replies/route";
import { HmacFamilyAccessGate } from "@/adapters/access/hmac-family-access-gate";
import { FileSubmissionInboxStore } from "@/adapters/persistence/file-submission-inbox-store";
import { FileSubmissionReplyLog } from "@/adapters/persistence/file-submission-reply-log";
import { ADMIN_SESSION_COOKIE } from "@/adapters/http/admin-session-cookie";
import { FAMILY_SESSION_COOKIE } from "@/adapters/http/family-session-cookie";
import { resetRateLimitersForTest } from "@/composition/server";
import { TEST_FAMILY_ACCESS_CODE } from "../support/family-access-code";
import { expectChildSafe } from "../support/child-safe";

/**
 * MCL-74. What a child's browser is allowed to learn from this route.
 *
 * The snapshot of the key set is the load-bearing case here, and it is not a style test.
 * The reply view grows on the adult side - a status, an author, an internal id - and the
 * one way that reaches a child is somebody spreading the view into the response because
 * it was shorter. This pins the exact keys, so that release fails here instead of in a
 * browser.
 */

const ENDPOINT = "http://localhost/api/family/replies";
const ADMIN_CODE = "ein-eigener-admin-code-nur-fuer-erwachsene";
const SESSION_SECRET = "test-session-secret";

let inboxDirectory = "";
let replyDirectory = "";
let familyCookie = "";

function cookieFor(name: string, accessCode: string): string {
  const grant = new HmacFamilyAccessGate({ accessCode, sessionSecret: SESSION_SECRET }).openSession(
    accessCode,
  );
  if (grant.outcome !== "granted") throw new Error("fixture could not open a session");
  return `${name}=${grant.session.value}`;
}

function get(query = "", cookie: string = familyCookie): Request {
  return new Request(`${ENDPOINT}${query}`, { method: "GET", headers: { cookie } });
}

async function seed(): Promise<void> {
  const store = new FileSubmissionInboxStore(inboxDirectory);
  await store.appendIfAbsent({
    kind: "text",
    submissionId: "sub-1",
    questionId: "companion-animal",
    createdAt: "2026-09-10T08:00:00.000Z",
    receivedAt: "2026-09-10T08:00:01.000Z",
    receiptId: "receipt-1",
    originalText: "Ein Wolf der leuchtet",
  });

  const log = new FileSubmissionReplyLog(replyDirectory, store);
  await log.append({
    replyId: "r-1",
    submissionId: "sub-1",
    understood: "Du möchtest einen Wolf, der leuchtet.",
    question: "Welche Farbe soll das Leuchten haben?",
    questionId: "reply:sub-1",
    author: "human",
    status: "ready",
    createdAt: "2026-09-12T18:00:00.000Z",
  });
}

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "avaloria-family-replies-"));
  inboxDirectory = join(root, "inbox");
  replyDirectory = join(root, "replies");
  resetRateLimitersForTest();
  vi.stubEnv("AVALORIA_FAMILY_ACCESS_CODE", TEST_FAMILY_ACCESS_CODE);
  vi.stubEnv("AVALORIA_ADMIN_ACCESS_CODE", ADMIN_CODE);
  vi.stubEnv("AVALORIA_SESSION_SECRET", SESSION_SECRET);
  vi.stubEnv("AVALORIA_INBOX_DIR", inboxDirectory);
  vi.stubEnv("AVALORIA_REPLY_DIR", replyDirectory);
  vi.stubEnv("DATABASE_URL", undefined);
  familyCookie = cookieFor(FAMILY_SESSION_COOKIE, TEST_FAMILY_ACCESS_CODE);
  await seed();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetRateLimitersForTest();
  await rm(join(inboxDirectory, ".."), { recursive: true, force: true });
});

describe("GET /api/family/replies", () => {
  it("answers a family session with the household's replies", async () => {
    const response = await GET(get());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = (await response.json()) as { replies: unknown[] };
    expect(body.replies).toHaveLength(1);
  });

  it("ships exactly the fields a child's page needs and no others", async () => {
    const response = await GET(get());
    const body = (await response.json()) as {
      replies: { reply: Record<string, unknown>; submission: Record<string, unknown> }[];
    };
    const entry = body.replies[0];
    if (entry === undefined) throw new Error("expected one reply");

    expect(Object.keys(entry).toSorted()).toEqual(["reply", "submission"]);
    expect(Object.keys(entry.reply).toSorted()).toEqual([
      "author",
      "createdAt",
      "understood",
      "question",
      "questionId",
      "replyId",
      "submissionId",
    ].toSorted());
    expect(Object.keys(entry.submission).toSorted()).toEqual([
      "createdAt",
      "kind",
      "originalTextExcerpt",
      "questionId",
      "submissionId",
    ]);
    // An adult's word for an adult's problem. A child's page has no use for it, and the
    // day a fallback exists it must not be the thing that tells a child it is one.
    expect(entry.reply).not.toHaveProperty("status");
  });

  it("keeps every string it hands a child free of project jargon", async () => {
    const response = await GET(get());
    const body = (await response.json()) as {
      replies: { reply: { understood: string; question: string } }[];
    };
    for (const entry of body.replies) {
      expectChildSafe(`${entry.reply.understood} ${entry.reply.question}`, "family reply payload");
    }
  });

  it("refuses a browser with no family session, and says nothing about the replies", async () => {
    const response = await GET(new Request(ENDPOINT, { method: "GET" }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("refuses an admin session: this is the child's route, not the adult's", async () => {
    const response = await GET(get("", cookieFor(ADMIN_SESSION_COOKIE, ADMIN_CODE)));
    expect(response.status).toBe(401);
  });

  it("refuses a since it cannot read instead of quietly answering with everything", async () => {
    const response = await GET(get("?since=gestern"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid-request" });
  });

  it("answers a since filter with what came after it", async () => {
    const before = await GET(get("?since=2026-09-11T00:00:00.000Z"));
    expect(((await before.json()) as { replies: unknown[] }).replies).toHaveLength(1);

    const after = await GET(get("?since=2026-09-13T00:00:00.000Z"));
    expect(((await after.json()) as { replies: unknown[] }).replies).toHaveLength(0);
  });

  it("refuses an out-of-range limit rather than clamping it behind the caller's back", async () => {
    expect((await GET(get("?limit=0"))).status).toBe(400);
    expect((await GET(get("?limit=101"))).status).toBe(400);
    expect((await GET(get("?limit=zwei"))).status).toBe(400);
    expect((await GET(get("?limit=1"))).status).toBe(200);
  });

  it("fails closed when no family access code is configured", async () => {
    vi.stubEnv("AVALORIA_FAMILY_ACCESS_CODE", undefined);
    const response = await GET(get());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "replies-unavailable" });
  });

  it("reports an unreadable store as unavailable and never as an empty list", async () => {
    // An empty list is a claim: "nothing came back for you". A store that could not be
    // read has made no such claim, and telling a child it did is the failure this whole
    // codebase keeps out of its status badges - so a damaged log must reach this route
    // as 503, not as a quiet 200 with zero replies.
    await writeFile(join(replyDirectory, "replies.jsonl"), "{not json\n", "utf8");

    const response = await GET(get());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "replies-unavailable" });
  });
});
