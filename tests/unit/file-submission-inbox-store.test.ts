import { appendFile, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/**
 * Pins the durability half of the 201 the POST route answers with: "the record is
 * durably appended before this answer is sent". `appendFile` resolved once the bytes
 * were in the page cache, so that sentence was not true of the file adapter - which is
 * the path the app falls back to when DATABASE_URL is removed.
 *
 * What these two cases prove: fsync is REQUESTED on the data file and on its directory,
 * and `appendIfAbsent` does not resolve until it has come back. What they do NOT prove:
 * that the data survives a power cut. No unit test can pull the plug, and on macOS
 * fsync does not imply F_FULLFSYNC, so the drive's own write cache is outside what any
 * of this can promise. The guard exists so that removing the sync is a red test rather
 * than a silent regression.
 */
describe("FileSubmissionInboxStore durability", () => {
  /**
   * The prototype every FileHandle shares, reached from a real handle. Spying there
   * rather than mocking `node:fs/promises` keeps the test on the real filesystem: it
   * watches the sync happen instead of replacing the thing that would have done it.
   */
  async function fileHandlePrototype(): Promise<FileHandle> {
    const probe = await open(join(directory, "sync-probe"), "w");
    const prototype = Object.getPrototypeOf(probe) as FileHandle;
    await probe.close();
    await rm(join(directory, "sync-probe"), { force: true });
    return prototype;
  }

  it("fsyncs the appended line and its directory, and nothing on a duplicate", async () => {
    const sync = vi.spyOn(await fileHandlePrototype(), "sync");

    try {
      await expect(
        new FileSubmissionInboxStore(directory).appendIfAbsent(record()),
      ).resolves.toEqual({ stored: true });

      // Two: the JSONL file, so the line survives, and the directory holding it, without
      // which a crash after the first append loses the file's entry and with it every
      // line in it.
      expect(sync).toHaveBeenCalledTimes(2);

      sync.mockClear();

      // A duplicate writes nothing, so it must sync nothing: an fsync here would mean
      // the retry path had opened the file for writing after all.
      await new FileSubmissionInboxStore(directory).appendIfAbsent(record());
      expect(sync).not.toHaveBeenCalled();
    } finally {
      sync.mockRestore();
    }
  });

  it("does not answer stored until the fsync it started has resolved", async () => {
    const prototype = await fileHandlePrototype();
    const realSync = prototype.sync;

    let releaseSync = (): void => {};
    const held = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    let markReached = (): void => {};
    const reached = new Promise<void>((resolve) => {
      markReached = resolve;
    });

    const sync = vi.spyOn(prototype, "sync").mockImplementation(async function (
      this: FileHandle,
    ): Promise<void> {
      markReached();
      await held;
      await realSync.call(this);
    });

    try {
      let settled = false;
      const pending = new FileSubmissionInboxStore(directory)
        .appendIfAbsent(record())
        .then((outcome) => {
          settled = true;
          return outcome;
        });

      // Deterministic, not a timer: the mock signals the moment the adapter asks for the
      // sync, and the append cannot get past it until this test lets go.
      await reached;
      expect(settled).toBe(false);

      releaseSync();
      await expect(pending).resolves.toEqual({ stored: true });
    } finally {
      sync.mockRestore();
    }
  });
});

/** Two characters that survive JSON.parse and that PostgreSQL cannot store unchanged. */
const NUL = String.fromCharCode(0);
const LONE_SURROGATE = String.fromCharCode(0xd800);

/** One JSONL line built from a valid record with fields replaced; undefined removes one. */
function damagedLine(overrides: Record<string, unknown>): string {
  return JSON.stringify({ ...record(), ...overrides });
}

/**
 * Every fixture below is valid JSON, and all but the first five carry the SAME
 * submissionId a retry would carry - which is the point. Before the runtime check,
 * `JSON.parse(line) as InboxRecord` made each of them a record, so a retry of sub-001
 * was answered `stored: false` with whatever the damaged line held in `receiptId`:
 * a positive acknowledgement, and a receipt that is not a receipt.
 */
const MALFORMED_LINES: ReadonlyArray<readonly [string, string]> = [
  ["an empty object", "{}"],
  ["a JSON array", "[]"],
  ["a JSON null", "null"],
  ["a bare string", '"eine Antwort"'],
  ["a bare number", "42"],
  ["a missing receiptId", damagedLine({ receiptId: undefined })],
  ["an empty receiptId", damagedLine({ receiptId: "" })],
  ["a missing submissionId", damagedLine({ submissionId: undefined })],
  ["a kind this adapter never wrote", damagedLine({ kind: "audio" })],
  ["a questionId that is not a string", damagedLine({ questionId: 7 })],
  ["an originalText that is not a string", damagedLine({ originalText: null })],
  ["a createdAt that is not a timestamp", damagedLine({ createdAt: "irgendwann" })],
  ["a createdAt outside the storable year range", damagedLine({ createdAt: "+275760-09-13T00:00:00.000Z" })],
  ["a receivedAt that is a number", damagedLine({ receivedAt: 1_760_000_000_000 })],
  ["an originalText carrying a NUL", damagedLine({ originalText: `drache${NUL}ende` })],
  ["an originalText carrying a lone surrogate", damagedLine({ originalText: `drache${LONE_SURROGATE}` })],
];

describe("FileSubmissionInboxStore corruption", () => {
  let errors: string[] = [];

  beforeEach(() => {
    errors = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function writeLine(line: string): Promise<void> {
    await mkdir(directory, { recursive: true });
    await appendFile(join(directory, "submissions.jsonl"), `${line}\n`, "utf8");
  }

  it.each(MALFORMED_LINES)(
    "never lets %s count as a stored submission",
    async (_name, line) => {
      await writeLine(line);

      // Not a record on the read side: the admin inbox must not display a line nobody
      // can vouch for as if it were a child's answer.
      await expect(new FileSubmissionInboxStore(directory).list({})).resolves.toEqual({
        entries: [],
        total: 0,
      });

      // And not a record on the write side. `stored: true` here is the assertion that
      // matters: `stored: false` would mean the route answering 200 with a receipt read
      // out of corruption, for a submission that is not in the file.
      await expect(
        new FileSubmissionInboxStore(directory).appendIfAbsent(record()),
      ).resolves.toEqual({ stored: true });

      const page = await new FileSubmissionInboxStore(directory).list({});
      expect(page.entries.map((entry) => entry.receiptId)).toEqual(["receipt-001"]);
      expect(page.entries[0].originalText).toBe(ORIGINAL_TEXT);
    },
  );

  it("keeps answering a retry from the intact line that follows a damaged one", async () => {
    await writeLine(damagedLine({ receiptId: undefined }));
    await new FileSubmissionInboxStore(directory).appendIfAbsent(record());

    const outcome = await new FileSubmissionInboxStore(directory).appendIfAbsent(
      record({ receiptId: "receipt-retry" }),
    );

    expect(outcome.stored).toBe(false);
    expect(outcome.stored === false && outcome.existing.receiptId).toBe("receipt-001");
  });

  it("names the unreadable line and why, without echoing what the line held", async () => {
    await writeLine(damagedLine({ receiptId: undefined }));

    await new FileSubmissionInboxStore(directory).list({});

    // One message per read, not one per line, and reason keys rather than content: a
    // damaged line can still hold a child's own words, and a log is not where those go.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("1: receiptId");
    expect(errors[0]).not.toContain(ORIGINAL_TEXT.trim());
  });

  it("skips a line of invalid JSON with the same policy and the same signal", async () => {
    // The adapter already skipped these. Pinned next to the schema cases so the shared
    // policy is visible: valid-JSON-of-the-wrong-shape and invalid-JSON are the same
    // kind of damage, and this adapter - MCL-48's rollback path - must not let either
    // one block a child's next answer.
    await writeLine("{ not json at all");

    await expect(
      new FileSubmissionInboxStore(directory).appendIfAbsent(record()),
    ).resolves.toEqual({ stored: true });
    expect(errors.join(" ")).toContain("1: not-json");
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
