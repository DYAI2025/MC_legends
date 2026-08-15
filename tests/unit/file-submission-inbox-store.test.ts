import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileSubmissionInboxStore } from "@/adapters/persistence/file-submission-inbox-store";
import type { InboxRecord } from "@/application/submissions/submission-inbox-store";
import { describeSubmissionInboxStoreContract } from "./submission-inbox-store-contract";
import { describeSubmissionInboxReaderContract } from "./submission-inbox-reader-contract";

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

async function storedRecords(inboxDirectory = directory): Promise<InboxRecord[]> {
  const content = await readFile(join(inboxDirectory, "submissions.jsonl"), "utf8");
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as InboxRecord);
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "avaloria-inbox-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("FileSubmissionInboxStore", () => {
  it("appends one JSON line per record and keeps the original text byte-identical", async () => {
    const store = new FileSubmissionInboxStore(directory);

    await expect(store.appendIfAbsent(record())).resolves.toEqual({ stored: true });
    await expect(
      store.appendIfAbsent(record({ receiptId: "receipt-002", submissionId: "sub-002" })),
    ).resolves.toEqual({ stored: true });

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

    await store.appendIfAbsent(record());

    expect((await stat(missing)).isDirectory()).toBe(true);
    const content = await readFile(join(missing, "submissions.jsonl"), "utf8");
    expect((JSON.parse(content.trim()) as InboxRecord).originalText).toBe(ORIGINAL_TEXT);
  });

  it("refuses to store a submissionId it already holds and returns the kept record", async () => {
    const store = new FileSubmissionInboxStore(directory);
    await store.appendIfAbsent(record());

    const outcome = await store.appendIfAbsent(
      record({ receiptId: "receipt-999", receivedAt: "2027-01-01T00:00:00.000Z" }),
    );

    expect(outcome.stored).toBe(false);
    expect(outcome.stored === false && outcome.existing).toEqual(record());
    expect(await storedRecords()).toEqual([record()]);
  });

  it("never rewrites a stored original text on a repeated delivery", async () => {
    const store = new FileSubmissionInboxStore(directory);
    await store.appendIfAbsent(record());

    await store.appendIfAbsent(record({ originalText: "Ein ganz anderer Satz." }));

    expect((await storedRecords())[0].originalText).toBe(ORIGINAL_TEXT);
  });

  it("stores one line when the same submissionId is appended concurrently", async () => {
    // Two store instances, as the route builds one per request. Serialising per
    // instance would let both of these through.
    const outcomes = await Promise.all([
      new FileSubmissionInboxStore(directory).appendIfAbsent(record()),
      new FileSubmissionInboxStore(directory).appendIfAbsent(record({ receiptId: "receipt-002" })),
      new FileSubmissionInboxStore(directory).appendIfAbsent(record({ receiptId: "receipt-003" })),
    ]);

    expect(await storedRecords()).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.stored)).toHaveLength(1);
  });

  it("keeps working after a failed append", async () => {
    const blocked = join(directory, "blocker", "inbox");
    await writeFile(join(directory, "blocker"), "not a directory", "utf8");

    await expect(new FileSubmissionInboxStore(blocked).appendIfAbsent(record())).rejects.toThrow();

    // The shared queue must not be left holding a rejected promise that stalls or
    // rejects everything appended after it.
    await expect(new FileSubmissionInboxStore(directory).appendIfAbsent(record())).resolves.toEqual({
      stored: true,
    });
  });

  it("ignores a damaged line rather than letting it block later submissions", async () => {
    await mkdir(directory, { recursive: true });
    await appendFile(join(directory, "submissions.jsonl"), "{ not json at all\n", "utf8");

    await expect(
      new FileSubmissionInboxStore(directory).appendIfAbsent(record()),
    ).resolves.toEqual({ stored: true });

    // Read raw: the damaged line is still on disk by design - it is skipped when
    // scanning, not repaired or removed - so storedRecords() cannot parse this file.
    const lines = (await readFile(join(directory, "submissions.jsonl"), "utf8"))
      .split("\n")
      .filter((line) => line.length > 0);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("{ not json at all");
    expect(JSON.parse(lines[1])).toEqual(record());
  });

  it("reports a store it cannot read instead of treating the submission as new", async () => {
    // A directory where the JSONL file should be: reading it fails with something
    // other than "not found". Swallowing that would silently duplicate every record.
    await mkdir(join(directory, "submissions.jsonl"), { recursive: true });

    await expect(new FileSubmissionInboxStore(directory).appendIfAbsent(record())).rejects.toThrow();
  });
});

// The contract's "empty store per call" requirement is met by the file-level beforeEach:
// it mkdtemp's a fresh `directory` before every test in this file, including these, and
// the afterEach removes it. Reusing that hook rather than making a second temp directory
// keeps one way of getting a scratch inbox in this file - and one way of cleaning it up.
describeSubmissionInboxStoreContract(
  "FileSubmissionInboxStore",
  async () => new FileSubmissionInboxStore(directory),
);

// The file store is MCL-48's documented rollback path, so it has to satisfy the MCL-50
// read contract too. If it could not, taking DATABASE_URL out of app.env - the rollback -
// would silently take the admin inbox down with it, and the one moment somebody performs
// a rollback is the worst moment to discover that.
describeSubmissionInboxReaderContract("FileSubmissionInboxStore", async (seed) => {
  const store = new FileSubmissionInboxStore(directory);
  for (const entry of seed) {
    await store.appendIfAbsent(entry);
  }
  return store;
});
