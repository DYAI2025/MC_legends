import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as inboxRoute from "@/app/api/inbox/submissions/route";
import { POST } from "@/app/api/inbox/submissions/route";
import type { InboxRecord } from "@/application/submissions/submission-inbox-store";

const ENDPOINT = "http://localhost/api/inbox/submissions";
const ORIGINAL_TEXT = "  Der Steinwolf trägt eine Laterne.  ";
const INBOX_FILE = "submissions.jsonl";

const originalInboxDirectory = process.env.AVALORIA_INBOX_DIR;
const originalWorkingDirectory = process.cwd();

let directory = "";

const MAX_BODY_BYTES = 16 * 1024;

/**
 * A Request built in-process carries no content-length - only a real HTTP client sets
 * one - so every test that wants the normal path has to declare it explicitly.
 */
function postRequest(
  body: string,
  headers: Record<string, string> = {},
): Request {
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

async function inboxLines(inboxDirectory = directory): Promise<InboxRecord[]> {
  const content = await readFile(join(inboxDirectory, INBOX_FILE), "utf8");
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as InboxRecord);
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "avaloria-inbox-route-"));
  process.env.AVALORIA_INBOX_DIR = directory;
});

afterEach(async () => {
  process.chdir(originalWorkingDirectory);

  if (originalInboxDirectory === undefined) {
    delete process.env.AVALORIA_INBOX_DIR;
  } else {
    process.env.AVALORIA_INBOX_DIR = originalInboxDirectory;
  }
  await rm(directory, { recursive: true, force: true });
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
      receiptId: body.receiptId,
      receivedAt: body.receivedAt,
      submissionId: "sub-001",
      questionId: "companion-animal",
      createdAt: "2026-08-11T00:00:00.000Z",
      originalText: ORIGINAL_TEXT,
    });
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

  it("refuses a body it is told is oversized without reading it at all", async () => {
    const request = postRequest(validPayload(), {
      "content-length": String(MAX_BODY_BYTES + 1),
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ acknowledged: false, error: "invalid-payload" });
    // The point of the guard: the body was never consumed, so its size never
    // mattered to this instance's memory.
    expect(request.bodyUsed).toBe(false);
    await expect(inboxLines()).rejects.toThrow();
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
        headers: { "content-type": "application/json" },
        body: oversized,
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ acknowledged: false, error: "invalid-payload" });
    await expect(inboxLines()).rejects.toThrow();
  });

  it("rejects a body that is not declared as JSON", async () => {
    const response = await POST(postRequest(validPayload(), { "content-type": "text/plain" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ acknowledged: false, error: "invalid-payload" });
    await expect(inboxLines()).rejects.toThrow();
  });

  it("rejects a createdAt that is not a real instant", async () => {
    const response = await POST(postRequest(validPayload({ createdAt: "hello" })));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ acknowledged: false, error: "invalid-payload" });
    await expect(inboxLines()).rejects.toThrow();
  });

  it("rejects a whitespace-only answer without acknowledging it", async () => {
    const response = await POST(postRequest(validPayload({ originalText: "   " })));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ acknowledged: false, error: "invalid-payload" });
    await expect(inboxLines()).rejects.toThrow();
  });

  it("rejects a malformed request body without acknowledging it", async () => {
    const response = await POST(postRequest("{ this is not json"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ acknowledged: false, error: "invalid-payload" });
    await expect(inboxLines()).rejects.toThrow();
  });

  it("rejects an oversized answer without acknowledging it", async () => {
    const response = await POST(postRequest(validPayload({ originalText: "a".repeat(4001) })));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ acknowledged: false, error: "invalid-payload" });
    await expect(inboxLines()).rejects.toThrow();
  });

  it("still stores submissions when the inbox directory is configured but empty", async () => {
    // A host UI that defines the variable and leaves it blank must fall back to the
    // default, not hand mkdir an empty path and 503 on every single submission.
    process.chdir(directory);
    process.env.AVALORIA_INBOX_DIR = "   ";

    const response = await POST(postRequest(validPayload()));

    expect(response.status).toBe(201);
    const records = await inboxLines(join(directory, ".data", "inbox"));
    expect(records).toHaveLength(1);
    expect(records[0].originalText).toBe(ORIGINAL_TEXT);
  });

  it("reports an unavailable inbox with a stable code and no internal detail", async () => {
    const blocker = join(directory, "blocker");
    await writeFile(blocker, "not a directory", "utf8");
    process.env.AVALORIA_INBOX_DIR = join(blocker, "inbox");

    const response = await POST(postRequest(validPayload()));

    expect(response.status).toBe(503);

    const body = await response.json();
    expect(body).toEqual({ acknowledged: false, error: "inbox-unavailable" });
    expect(JSON.stringify(body)).not.toMatch(/ENOTDIR|node:|\/private\/|at Object|Error:/);
  });

  it("exposes no read or mutation method beyond POST", () => {
    expect(Object.keys(inboxRoute).toSorted()).toEqual(["POST"]);
  });
});
