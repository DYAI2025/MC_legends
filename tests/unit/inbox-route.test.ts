import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as inboxRoute from "@/app/api/inbox/submissions/route";
import { POST } from "@/app/api/inbox/submissions/route";
import type { InboxRecord } from "@/application/submissions/submission-inbox-store";
import { resetRateLimitersForTest } from "@/composition/server";
import { TEST_FAMILY_ACCESS_CODE } from "../support/family-access-code";
import { familySessionCookieHeader } from "../support/family-session-header";

const ENDPOINT = "http://localhost/api/inbox/submissions";
const ORIGINAL_TEXT = "  Der Steinwolf trägt eine Laterne.  ";
const INBOX_FILE = "submissions.jsonl";

const originalWorkingDirectory = process.cwd();

let directory = "";
let sessionCookie = "";

const MAX_BODY_BYTES = 16 * 1024;

/**
 * A Request built in-process carries no content-length - only a real HTTP client sets
 * one - so every test that wants the normal path has to declare it explicitly.
 *
 * The session cookie is part of the normal path now: every case that is not about
 * access control sends a real one, so those cases keep testing what they always did.
 */
function postRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body, "utf8")),
      cookie: sessionCookie,
      ...headers,
    },
    body,
  });
}

/** Deliberately without the cookie the helper above always adds. */
function anonymousRequest(body: string, headers: Record<string, string> = {}): Request {
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

function validPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    submissionId: "sub-001",
    questionId: "companion-animal",
    createdAt: "2026-08-11T00:00:00.000Z",
    originalText: ORIGINAL_TEXT,
    ...overrides,
  });
}

/**
 * Filesystem errors, host paths and stack frames - anything a refusal could carry out
 * of the server and into a child's browser.
 */
const INTERNAL_DETAIL = /ENOTDIR|ENOENT|EACCES|node:|\/private\/|\/var\/folders\/|at Object|at async|Error:|stack/iu;

/**
 * Pins a refusal end to end. The leak check runs over the raw bytes the route actually
 * sent, before anything fixes the shape: run after a toEqual has already pinned the
 * body, its input is a constant and it cannot fail no matter what the route leaks.
 */
async function expectRefusal(response: Response, status: number, error: string): Promise<void> {
  expect(response.status).toBe(status);

  const raw = await response.text();
  expect(raw, "a refusal must carry no internal detail").not.toMatch(INTERNAL_DETAIL);
  expect(raw, "a refusal must never echo the access code").not.toContain(TEST_FAMILY_ACCESS_CODE);
  expect(JSON.parse(raw)).toEqual({ acknowledged: false, error });
}

async function inboxLines(inboxDirectory = directory): Promise<InboxRecord[]> {
  const content = await readFile(join(inboxDirectory, INBOX_FILE), "utf8");
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as InboxRecord);
}

async function expectNothingStored(): Promise<void> {
  await expect(inboxLines()).rejects.toThrow();
}

beforeEach(async () => {
  // Every case below asserts against the JSONL file store, so the store choice must not
  // depend on the shell that started the run. `createSubmissionInboxStore()` selects
  // PostgreSQL whenever DATABASE_URL is set and non-blank - and a developer working on
  // MCL-48 has it exported. Blank, not deleted, on purpose: the composition root uses
  // `||` rather than `??` precisely so that a defined-but-empty value means "no database
  // configured", and stubbing the blank exercises that documented fallback rather than
  // routing around it.
  vi.stubEnv("DATABASE_URL", "");

  directory = await mkdtemp(join(tmpdir(), "avaloria-inbox-route-"));
  vi.stubEnv("AVALORIA_INBOX_DIR", directory);
  vi.stubEnv("AVALORIA_FAMILY_ACCESS_CODE", TEST_FAMILY_ACCESS_CODE);
  vi.stubEnv("AVALORIA_SESSION_SECRET", undefined);
  vi.stubEnv("AVALORIA_INBOX_RATE_LIMIT", undefined);
  vi.stubEnv("AVALORIA_INBOX_RATE_WINDOW_MS", undefined);
  resetRateLimitersForTest();
  sessionCookie = familySessionCookieHeader(TEST_FAMILY_ACCESS_CODE);
});

afterEach(async () => {
  // chdir first: one case moves the working directory, and the temp dir below is the
  // one it moved into.
  process.chdir(originalWorkingDirectory);
  vi.unstubAllEnvs();
  resetRateLimitersForTest();
  await rm(directory, { recursive: true, force: true });
});

describe("POST /api/inbox/submissions access", () => {
  it("refuses an anonymous submission and stores nothing", async () => {
    const request = anonymousRequest(validPayload());

    const response = await POST(request);

    await expectRefusal(response, 401, "unauthorized");
    // The point of checking access first: an unauthorised caller never gets this
    // server to read, decode or parse a single byte of its body.
    expect(request.bodyUsed).toBe(false);
    await expectNothingStored();
  });

  it("refuses a forged session and stores nothing", async () => {
    const response = await POST(
      anonymousRequest(validPayload(), {
        cookie: "avaloria_family_session=v1.9999999999.nonce.forged-signature",
      }),
    );

    await expectRefusal(response, 401, "unauthorized");
    await expectNothingStored();
  });

  it("refuses a session minted under a different access code and stores nothing", async () => {
    const response = await POST(
      anonymousRequest(validPayload(), {
        cookie: familySessionCookieHeader("ein-ganz-anderer-familien-code"),
      }),
    );

    await expectRefusal(response, 401, "unauthorized");
    await expectNothingStored();
  });

  it("fails closed and stores nothing when no access code is configured", async () => {
    vi.stubEnv("AVALORIA_FAMILY_ACCESS_CODE", undefined);

    // Even the session that was valid a moment ago must not get in: a gate that cannot
    // decide has to refuse everyone, not wave through whoever already holds a cookie.
    const response = await POST(postRequest(validPayload()));

    await expectRefusal(response, 503, "inbox-unavailable");
    await expectNothingStored();
  });

  it("refuses a signed-in caller that submits too often, without acknowledging", async () => {
    vi.stubEnv("AVALORIA_INBOX_RATE_LIMIT", "2");
    resetRateLimitersForTest();

    expect((await POST(postRequest(validPayload({ submissionId: "sub-a" })))).status).toBe(201);
    expect((await POST(postRequest(validPayload({ submissionId: "sub-b" })))).status).toBe(201);

    const refused = await POST(postRequest(validPayload({ submissionId: "sub-c" })));

    await expectRefusal(refused, 429, "too-many-requests");
    const records = await inboxLines();
    expect(records.map((entry) => entry.submissionId)).toEqual(["sub-a", "sub-b"]);
  });
});

describe("POST /api/inbox/submissions", () => {
  it("acknowledges a valid submission and stores the original text byte-identical", async () => {
    const response = await POST(postRequest(validPayload()));

    expect(response.status).toBe(201);

    const body = (await response.json()) as {
      acknowledged: boolean;
      receiptId: string;
      receivedAt: string;
    };
    expect(body.acknowledged).toBe(true);
    expect(body.receiptId.trim().length).toBeGreaterThan(0);
    expect(body.receivedAt.trim().length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(body.receivedAt))).toBe(false);

    const records = await inboxLines();
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      kind: "text",
      receiptId: body.receiptId,
      receivedAt: body.receivedAt,
      submissionId: "sub-001",
      questionId: "companion-animal",
      createdAt: "2026-08-11T00:00:00.000Z",
      originalText: ORIGINAL_TEXT,
    });
  });

  it("mints receivedAt in the one canonical ISO shape", async () => {
    const response = await POST(postRequest(validPayload()));

    const body = (await response.json()) as { receivedAt: string };
    // Not decoration: a retry is answered with the receivedAt the store handed back,
    // and the PostgreSQL store of MCL-48 reads it out of a timestamptz as
    // Date.toISOString(). The two match only while this route mints exactly that shape,
    // and that invariant otherwise spans two files with nothing connecting them - so a
    // change here to, say, a value with an offset would break the ACK a child already
    // holds, silently and only on the retry path.
    expect(body.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("issues its own receipt and ignores one the client tried to dictate", async () => {
    const forged = { receiptId: "forged-receipt", receivedAt: "1999-01-01T00:00:00.000Z" };

    const response = await POST(postRequest(validPayload(forged)));

    expect(response.status).toBe(201);

    const body = (await response.json()) as { receiptId: string; receivedAt: string };
    expect(body.receiptId).not.toBe(forged.receiptId);
    expect(body.receivedAt).not.toBe(forged.receivedAt);

    const records = await inboxLines();
    expect(records).toHaveLength(1);
    expect(records[0].receiptId).toBe(body.receiptId);
    expect(records[0].receivedAt).toBe(body.receivedAt);
  });

  it("answers a retried submissionId with the receipt it already has, and stores no duplicate", async () => {
    const first = await POST(postRequest(validPayload()));
    expect(first.status).toBe(201);
    const firstReceipt = (await first.json()) as { receiptId: string; receivedAt: string };

    const retry = await POST(postRequest(validPayload()));

    // 200, not 201: this call created nothing.
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toEqual({
      acknowledged: true,
      receiptId: firstReceipt.receiptId,
      receivedAt: firstReceipt.receivedAt,
    });

    const records = await inboxLines();
    expect(records).toHaveLength(1);
    expect(records[0].receiptId).toBe(firstReceipt.receiptId);
  });

  it("keeps the stored original text when a retry arrives with different text", async () => {
    const first = await POST(postRequest(validPayload()));
    const firstReceipt = (await first.json()) as { receiptId: string };

    // Same id, different text: the stored original artifact must not be rewritten by a
    // later delivery, whatever that delivery claims.
    const retry = await POST(
      postRequest(validPayload({ originalText: "Ein ganz anderer Satz." })),
    );

    expect(retry.status).toBe(200);
    const records = await inboxLines();
    expect(records).toHaveLength(1);
    expect(records[0].originalText).toBe(ORIGINAL_TEXT);
    expect(records[0].receiptId).toBe(firstReceipt.receiptId);
  });

  it("keeps two different submissionIds apart", async () => {
    await POST(postRequest(validPayload({ submissionId: "sub-001" })));
    await POST(postRequest(validPayload({ submissionId: "sub-002" })));

    const records = await inboxLines();
    expect(records.map((entry) => entry.submissionId)).toEqual(["sub-001", "sub-002"]);
    expect(new Set(records.map((entry) => entry.receiptId)).size).toBe(2);
  });

  it("stores one line when the same submissionId arrives concurrently", async () => {
    const responses = await Promise.all([
      POST(postRequest(validPayload())),
      POST(postRequest(validPayload())),
      POST(postRequest(validPayload())),
    ]);

    const records = await inboxLines();
    expect(records).toHaveLength(1);

    const bodies = await Promise.all(
      responses.map((response) => response.json() as Promise<{ receiptId: string }>),
    );
    // Every caller was told the same receipt - the one that is actually on disk.
    expect(new Set(bodies.map((body) => body.receiptId))).toEqual(
      new Set([records[0].receiptId]),
    );
  });

  it("refuses a body it is told is oversized without reading it at all", async () => {
    const request = postRequest(validPayload(), {
      "content-length": String(MAX_BODY_BYTES + 1),
    });

    const response = await POST(request);

    await expectRefusal(response, 400, "invalid-payload");
    // The point of the guard: the body was never consumed, so its size never
    // mattered to this instance's memory.
    expect(request.bodyUsed).toBe(false);
    await expectNothingStored();
  });

  it("refuses an oversized body that declares no length at all", async () => {
    // Valid in every other respect and padded with an ignored field, so without the
    // byte cap this request is accepted and answered 201.
    const oversized = JSON.stringify({
      submissionId: "sub-001",
      questionId: "companion-animal",
      createdAt: "2026-08-11T00:00:00.000Z",
      originalText: ORIGINAL_TEXT,
      padding: "a".repeat(1024 * 1024),
    });

    const response = await POST(
      new Request(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: sessionCookie },
        body: oversized,
      }),
    );

    await expectRefusal(response, 400, "invalid-payload");
    await expectNothingStored();
  });

  it("rejects a body that is not declared as JSON", async () => {
    const response = await POST(postRequest(validPayload(), { "content-type": "text/plain" }));

    await expectRefusal(response, 400, "invalid-payload");
    await expectNothingStored();
  });

  it("rejects a body whose bytes are not valid UTF-8", async () => {
    // A lone continuation byte: strict decoding must refuse it rather than replace it,
    // because the submitted text has to survive byte for byte or not at all.
    const invalid = new Uint8Array([0x7b, 0x22, 0x80, 0x22, 0x7d]);

    const response = await POST(
      new Request(ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(invalid.byteLength),
          cookie: sessionCookie,
        },
        body: invalid,
      }),
    );

    await expectRefusal(response, 400, "invalid-payload");
    await expectNothingStored();
  });

  it("rejects a createdAt that is not a real instant", async () => {
    const response = await POST(postRequest(validPayload({ createdAt: "hello" })));

    await expectRefusal(response, 400, "invalid-payload");
    await expectNothingStored();
  });

  it("rejects a createdAt in a year the store cannot hold", async () => {
    // Not exotic: an uninitialised field or a buggy date picker produces it. Date.parse
    // reads it happily, and PostgreSQL refuses it forever because it has no year zero -
    // so without this guard the child is told the inbox is down, on every retry of a
    // payload that never changes.
    const response = await POST(postRequest(validPayload({ createdAt: "0000-01-01" })));

    await expectRefusal(response, 400, "invalid-payload");
    await expectNothingStored();
  });

  it("still accepts every createdAt spelling the year range must not swallow", async () => {
    // The guard above is a range check bolted onto Date.parse, and the cheapest way to
    // get it wrong is to over-reject. These four are what the store's own cases already
    // rely on being accepted.
    for (const createdAt of ["2026", "2026-08", "2026-08-14", "2026-08-14T09:00:00.000Z"]) {
      const response = await POST(
        postRequest(validPayload({ createdAt, submissionId: `sub-${createdAt}` })),
      );

      expect(response.status, `createdAt ${createdAt} must still be accepted`).toBe(201);
    }
  });

  it("rejects a NUL in the answer without acknowledging it", async () => {
    // Legal JSON as an escape, so it survives the strict UTF-8 decode; not whitespace,
    // so it survives trim(); one character, so it is under every cap. PostgreSQL then
    // refuses it permanently (22021).
    const response = await POST(
      postRequest(validPayload({ originalText: "drache\u0000ende" })),
    );

    await expectRefusal(response, 400, "invalid-payload");
    await expectNothingStored();
  });

  it("rejects a lone surrogate in the answer instead of storing a repaired version", async () => {
    // node-postgres encodes parameters with Buffer.from(str, "utf8"), which rewrites an
    // unpaired surrogate to U+FFFD - so accepting this would store text that is not the
    // text the child sent. Refused, never repaired: the original has to survive byte
    // for byte or not at all.
    const response = await POST(
      postRequest(validPayload({ originalText: "drache\ud83dende" })),
    );

    await expectRefusal(response, 400, "invalid-payload");
    await expectNothingStored();
  });

  it("rejects a whitespace-only answer without acknowledging it", async () => {
    const response = await POST(postRequest(validPayload({ originalText: "   " })));

    await expectRefusal(response, 400, "invalid-payload");
    await expectNothingStored();
  });

  it("rejects a malformed request body without acknowledging it", async () => {
    const response = await POST(postRequest("{ this is not json"));

    await expectRefusal(response, 400, "invalid-payload");
    await expectNothingStored();
  });

  it("rejects an oversized answer without acknowledging it", async () => {
    const response = await POST(postRequest(validPayload({ originalText: "a".repeat(4001) })));

    await expectRefusal(response, 400, "invalid-payload");
    await expectNothingStored();
  });

  it("still stores submissions when the inbox directory is configured but empty", async () => {
    // A host UI that defines the variable and leaves it blank must fall back to the
    // default, not hand mkdir an empty path and 503 on every single submission.
    process.chdir(directory);
    vi.stubEnv("AVALORIA_INBOX_DIR", "   ");

    const response = await POST(postRequest(validPayload()));

    expect(response.status).toBe(201);
    const records = await inboxLines(join(directory, ".data", "inbox"));
    expect(records).toHaveLength(1);
    expect(records[0].originalText).toBe(ORIGINAL_TEXT);
  });

  it("reports an unavailable inbox with a stable code and no internal detail", async () => {
    const blocker = join(directory, "blocker");
    await writeFile(blocker, "not a directory", "utf8");
    vi.stubEnv("AVALORIA_INBOX_DIR", join(blocker, "inbox"));

    const response = await POST(postRequest(validPayload()));

    await expectRefusal(response, 503, "inbox-unavailable");
  });

  it("exposes no read or mutation method beyond POST", () => {
    expect(Object.keys(inboxRoute).toSorted()).toEqual(["POST"]);
  });
});
