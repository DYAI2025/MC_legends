import { fstatSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileSubmissionInboxStore } from "@/adapters/persistence/file-submission-inbox-store";
import type {
  AudioInboxRecord,
  TextInboxRecord,
} from "@/application/submissions/submission-inbox-store";
import { describeSubmissionInboxStoreContract } from "./submission-inbox-store-contract";
import { describeSubmissionInboxReaderContract } from "./submission-inbox-reader-contract";
import { asTextEntry } from "../support/text-submission-shape";

const ORIGINAL_TEXT = "  Der Steinwolf trägt eine Laterne.  ";

function record(overrides: Partial<TextInboxRecord> = {}): TextInboxRecord {
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

/**
 * A stored recording's metadata, as the upload route hands it to this adapter (MCL-49).
 *
 * The five audio fields are exactly what migration 0002 requires an audio row to carry,
 * and the object key here is the one the domain derives from that digest - written out
 * rather than computed, so a change to the derivation shows up as a diff in this file.
 */
function audioRecord(overrides: Partial<AudioInboxRecord> = {}): AudioInboxRecord {
  return {
    kind: "audio",
    receiptId: "receipt-audio-001",
    receivedAt: "2026-08-21T10:00:00.000Z",
    submissionId: "sub-audio-001",
    questionId: "companion-animal",
    createdAt: "2026-08-21T09:00:00.000Z",
    audio: {
      objectKey: "ab/abababababababababababababababababababababababababababababababab.webm",
      mimeType: "audio/webm",
      extension: "webm",
      sizeBytes: 4096,
      sha256: "abababababababababababababababababababababababababababababababab",
    },
    ...overrides,
  };
}

let directory = "";

async function storedRecords(inboxDirectory = directory): Promise<TextInboxRecord[]> {
  const content = await readFile(join(inboxDirectory, "submissions.jsonl"), "utf8");
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TextInboxRecord);
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

    const parsed = lines.map((line) => JSON.parse(line) as TextInboxRecord);
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
    expect((JSON.parse(content.trim()) as TextInboxRecord).originalText).toBe(ORIGINAL_TEXT);
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

  /**
   * The case above holds the FIRST sync and so proves only that *some* fsync is awaited.
   * It stays green if the directory fsync is fired and forgotten, which is the half that
   * protects the file's entry rather than its bytes.
   *
   * This one lets the data-file fsync finish, then holds the SECOND call - identified as
   * the directory by fstat on the handle being synced, not by call order alone - and
   * proves `appendIfAbsent` is still unsettled after the event loop has been drained.
   * Measured 2026-08-18: with `await directory.sync()` reduced to `directory.sync()`,
   * this case fails on `expect(settled).toBe(false)` while the directory fsync is held.
   */
  it("keeps stored unresolved while the directory fsync - the second one - is held", async () => {
    const prototype = await fileHandlePrototype();
    const realSync = prototype.sync;

    let calls = 0;
    let firstCompleted = false;
    let secondWasDirectory: boolean | null = null;

    let markSecondReached = (): void => {};
    const secondReached = new Promise<void>((resolve) => {
      markSecondReached = resolve;
    });
    let releaseSecond = (): void => {};
    const secondHeld = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    const sync = vi.spyOn(prototype, "sync").mockImplementation(async function (
      this: FileHandle,
    ): Promise<void> {
      calls += 1;

      if (calls === 1) {
        // The data-file fsync runs for real and to completion: this test is about what
        // happens after it, so it must not be the thing being waited on.
        await realSync.call(this);
        firstCompleted = true;
        return;
      }

      // Which handle this is, asked of the descriptor rather than assumed from the
      // order, so the case fails loudly if the second sync ever stops being the
      // directory instead of quietly guarding the wrong call. Synchronous on purpose:
      // it runs before this mock yields, so it cannot race a close that a non-awaiting
      // implementation would already have started.
      secondWasDirectory = fstatSync(this.fd).isDirectory();
      markSecondReached();
      await secondHeld;
      // Still the real fsync in the end - the filesystem is never left as a no-op.
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

      await secondReached;

      expect(calls).toBe(2);
      expect(firstCompleted).toBe(true);
      expect(secondWasDirectory).toBe(true);

      // Drain, not sleep: two turns of the macrotask queue give every already-scheduled
      // continuation a chance to run. Nothing here waits for a duration, so the result
      // does not depend on how fast the machine is.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      // The bytes are on disk and their fsync has returned; the answer is still withheld
      // because the entry that makes the file findable is not durable yet.
      expect(settled).toBe(false);

      releaseSecond();
      await expect(pending).resolves.toEqual({ stored: true });
      expect(settled).toBe(true);
      expect(calls).toBe(2);
    } finally {
      releaseSecond();
      sync.mockRestore();
    }
  });
});

/**
 * The rollback path has to hold a recording too (MCL-49).
 *
 * Measured on e3db9c3, before this suite existed: the upload route wrote an audio line to
 * this file and `readInboxRecord` then refused it for its `kind`, so `readAll` skipped it.
 * Every consequence of that was silent - the duplicate check could not see the line, so a
 * retry appended a SECOND line with a SECOND receipt for one submission; the admin list
 * showed neither; and the only trace was a "damaged line" message in the server log.
 *
 * That is not a hypothetical: this adapter is what the app falls back to when DATABASE_URL
 * is removed, which is the one moment somebody is already dealing with a problem.
 */
describe("FileSubmissionInboxStore with recordings", () => {
  it("reads back a stored recording with every media field intact", async () => {
    const store = new FileSubmissionInboxStore(directory);
    await expect(store.appendIfAbsent(audioRecord())).resolves.toEqual({ stored: true });

    const page = await new FileSubmissionInboxStore(directory).list({});

    expect(page.total).toBe(1);
    expect(page.entries[0]).toEqual({
      kind: "audio",
      submissionId: "sub-audio-001",
      questionId: "companion-animal",
      createdAt: "2026-08-21T09:00:00.000Z",
      receivedAt: "2026-08-21T10:00:00.000Z",
      receiptId: "receipt-audio-001",
      status: "RECEIVED",
      audio: audioRecord().audio,
    });
  });

  it("answers a retried recording with the receipt it already has", async () => {
    await new FileSubmissionInboxStore(directory).appendIfAbsent(audioRecord());

    const outcome = await new FileSubmissionInboxStore(directory).appendIfAbsent(
      audioRecord({ receiptId: "receipt-audio-retry" }),
    );

    // stored: false with the FIRST receipt. Before the reader could see an audio line,
    // this appended a second line and minted a second receipt for one submission.
    expect(outcome.stored).toBe(false);
    expect(outcome.stored === false && outcome.existing.receiptId).toBe("receipt-audio-001");
    expect(await storedRecords()).toHaveLength(1);
  });

  it("keeps a recording and a typed answer apart under the kind filter", async () => {
    const store = new FileSubmissionInboxStore(directory);
    await store.appendIfAbsent(record());
    await store.appendIfAbsent(audioRecord());

    await expect(store.list({ kind: "audio" })).resolves.toMatchObject({ total: 1 });
    await expect(store.list({ kind: "text" })).resolves.toMatchObject({ total: 1 });
    await expect(store.list({})).resolves.toMatchObject({ total: 2 });
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
 * The same, for a recording: `audio` replaces the whole media block, anything else
 * replaces one field inside it.
 *
 * Deliberately carries the SAME submissionId as `record()` does not - it carries the
 * audio fixture's - so these lines are checked for the same thing the text ones are: that
 * a line nobody can vouch for never answers a duplicate check.
 */
function audioDamagedLine(overrides: Record<string, unknown>): string {
  const { audio, ...fields } = overrides;
  return JSON.stringify({
    ...audioRecord(),
    submissionId: record().submissionId,
    audio: audio === undefined ? { ...audioRecord().audio, ...fields } : audio,
  });
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
  ["a kind this adapter never wrote", damagedLine({ kind: "video" })],
  // Audio lines are readable now, so the fixtures that used to lean on "kind is not
  // text" have to lean on the media shape instead - a line claiming to be a recording
  // and carrying nothing that locates one is exactly what must never count as stored.
  ["an audio kind with no media metadata at all", damagedLine({ kind: "audio" })],
  ["an audio kind whose media block is a string", audioDamagedLine({ audio: "somewhere" })],
  ["a recording with no objectKey", audioDamagedLine({ objectKey: undefined })],
  ["a recording with an empty objectKey", audioDamagedLine({ objectKey: "" })],
  ["a recording with a mimeType off the allowlist", audioDamagedLine({ mimeType: "audio/x-wav" })],
  ["a recording with no extension", audioDamagedLine({ extension: "" })],
  ["a recording whose size is a string", audioDamagedLine({ sizeBytes: "4096" })],
  ["a recording whose size is zero", audioDamagedLine({ sizeBytes: 0 })],
  ["a recording whose size is not an integer", audioDamagedLine({ sizeBytes: 4096.5 })],
  ["a recording with a sha256 that is not hex", audioDamagedLine({ sha256: "z".repeat(64) })],
  ["a recording with a truncated sha256", audioDamagedLine({ sha256: "ab".repeat(20) })],
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
      expect(asTextEntry(page.entries[0]).originalText).toBe(ORIGINAL_TEXT);
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
