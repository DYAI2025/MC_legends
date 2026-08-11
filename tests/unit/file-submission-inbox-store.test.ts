import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileSubmissionInboxStore } from "@/adapters/persistence/file-submission-inbox-store";
import type { InboxRecord } from "@/application/submissions/submission-inbox-store";

const ORIGINAL_TEXT = "  Der Steinwolf trägt eine Laterne.  ";

function record(overrides: Partial<InboxRecord> = {}): InboxRecord {
  return {
    kind: "text",
    receiptId: "receipt-001",
    receivedAt: "2026-08-11T10:00:00.000Z",
    submissionId: "sub-001",
    questionId: "companion-animal",
    createdAt: "2026-08-11T00:00:00.000Z",
    originalText: ORIGINAL_TEXT,
    ...overrides,
  };
}

let directory = "";

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "avaloria-inbox-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("FileSubmissionInboxStore", () => {
  it("appends one JSON line per record and keeps the original text byte-identical", async () => {
    const store = new FileSubmissionInboxStore(directory);

    await store.append(record());
    await store.append(record({ receiptId: "receipt-002", submissionId: "sub-002" }));

    const content = await readFile(join(directory, "submissions.jsonl"), "utf8");
    const lines = content.split("\n").filter((line) => line.length > 0);

    expect(lines).toHaveLength(2);
    expect(content.endsWith("\n")).toBe(true);

    const parsed = lines.map((line) => JSON.parse(line) as InboxRecord);
    expect(parsed[0]).toEqual(record());
    expect(parsed[0].originalText).toBe(ORIGINAL_TEXT);
    expect(parsed[1].receiptId).toBe("receipt-002");
    expect(parsed[1].originalText).toBe(ORIGINAL_TEXT);
  });

  it("creates the inbox directory when it does not exist yet", async () => {
    const missing = join(directory, "nested", "inbox");
    const store = new FileSubmissionInboxStore(missing);

    await store.append(record());

    expect((await stat(missing)).isDirectory()).toBe(true);
    const content = await readFile(join(missing, "submissions.jsonl"), "utf8");
    expect((JSON.parse(content.trim()) as InboxRecord).originalText).toBe(ORIGINAL_TEXT);
  });
});
