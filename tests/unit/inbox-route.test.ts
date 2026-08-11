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

let directory = "";

function postRequest(body: string): Request {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
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

    expect(response.status).toBe(202);

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

    expect(response.status).toBe(202);

    const body = (await response.json()) as { receiptId: string; receivedAt: string };
    expect(body.receiptId).not.toBe(forged.receiptId);
    expect(body.receivedAt).not.toBe(forged.receivedAt);

    const records = await inboxLines();
    expect(records).toHaveLength(1);
    expect(records[0].receiptId).toBe(body.receiptId);
    expect(records[0].receivedAt).toBe(body.receivedAt);
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
