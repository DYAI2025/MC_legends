import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  AudioInboxRecord,
  TextInboxRecord,
} from "@/application/submissions/submission-inbox-store";
import {
  lockSubmissionInboxTable,
  unlockSubmissionInboxTable,
} from "../support/submission-inbox-table-lock";

/**
 * Pins what `scripts/import-inbox-jsonl.mjs` means by "already present".
 *
 * The importer inserts with `ON CONFLICT (submission_id) DO NOTHING` and used to read
 * `rowCount === 0` as "this record is already stored". It is not: it says only that
 * *some* row holds that submission_id. A cutover re-run over a table whose row had
 * diverged from the file - a different receipt, a different instant, a different text -
 * reported a clean idempotent import and told nobody. This suite fails unless the
 * stored row is read back and proven equivalent, and unless a divergence rolls the whole
 * run back.
 *
 * The real script is spawned, not imported: the operator runs
 * `node scripts/import-inbox-jsonl.mjs <file>` and reads its exit code and its stderr,
 * so that is what is asserted. The table is read through a pool of this suite's own, so
 * no assertion about stored rows comes from the code under test.
 */
const CONNECTION_STRING = process.env.MCL_TEST_DATABASE_URL?.trim() ?? "";
const ENABLED = CONNECTION_STRING.length > 0;

let inspector: Pool | null = null;

function inspect(): Pool {
  if (inspector === null) {
    inspector = new Pool({ connectionString: CONNECTION_STRING });
    inspector.on("error", (cause) => {
      console.error("inspector pool error", cause);
    });
  }
  return inspector;
}

async function emptyTable(): Promise<void> {
  await inspect().query("TRUNCATE submission_inbox");
}

function sourceRecord(overrides: Partial<TextInboxRecord> = {}): TextInboxRecord {
  return {
    kind: "text",
    submissionId: "sub-import-1",
    questionId: "companion-animal",
    createdAt: "2026-08-13T09:00:00.000Z",
    receivedAt: "2026-08-13T09:00:01.000Z",
    receiptId: "receipt-import-1",
    originalText: "  ein drache mit  zwei koepfen  ",
    ...overrides,
  };
}

/**
 * One spoken answer as the file adapter writes it (MCL-49).
 *
 * Every value satisfies migration 0002's CHECK constraints, so a failure in these cases
 * is the importer's and not the fixture's.
 */
function sourceRecording(overrides: Partial<AudioInboxRecord> = {}): AudioInboxRecord {
  return {
    kind: "audio",
    submissionId: "sub-import-audio",
    questionId: "companion-animal",
    createdAt: "2026-08-21T09:00:00.000Z",
    receivedAt: "2026-08-21T09:00:01.000Z",
    receiptId: "receipt-import-audio",
    audio: {
      objectKey: "cd/cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd.webm",
      mimeType: "audio/webm",
      extension: "webm",
      sizeBytes: 128_000,
      sha256: "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
    },
    ...overrides,
  };
}

let workspace = "";
let fileCounter = 0;

/** One JSONL file per call, so a case can compare two different versions of a record. */
async function jsonlFile(records: readonly unknown[]): Promise<string> {
  fileCounter += 1;
  const path = join(workspace, `submissions-${fileCounter}.jsonl`);
  await writeFile(path, records.map((record) => `${JSON.stringify(record)}\n`).join(""), "utf8");
  return path;
}

type ImportRun = Readonly<{ status: number | null; stdout: string; stderr: string }>;

function runImport(path: string): ImportRun {
  const run = spawnSync(process.execPath, ["scripts/import-inbox-jsonl.mjs", path], {
    // DATABASE_URL is what the script reads, and it is scoped to this child alone: an
    // exported one would flip the whole composition root to PostgreSQL.
    env: { ...process.env, DATABASE_URL: CONNECTION_STRING },
    encoding: "utf8",
  });

  return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

async function storedIds(): Promise<string[]> {
  const { rows } = await inspect().query<{ submission_id: string }>(
    "SELECT submission_id FROM submission_inbox ORDER BY submission_id",
  );
  return rows.map((row) => row.submission_id);
}

async function storedRow(submissionId: string): Promise<Record<string, unknown> | undefined> {
  const { rows } = await inspect().query(
    "SELECT submission_id, kind, question_id, created_at, received_at, receipt_id, original_text, inserted_at FROM submission_inbox WHERE submission_id = $1",
    [submissionId],
  );
  return rows[0];
}

/** The five media columns, which only a recording's row may carry (MCL-49). */
async function storedMedia(submissionId: string): Promise<Record<string, unknown> | undefined> {
  const { rows } = await inspect().query(
    "SELECT media_object_key, media_mime_type, media_extension, media_size_bytes, media_sha256, original_text FROM submission_inbox WHERE submission_id = $1",
    [submissionId],
  );
  return rows[0];
}

// This file TRUNCATEs a table another integration file also owns, so it takes the
// table lock for its whole run rather than racing that file's TRUNCATE.
beforeAll(async () => {
  if (ENABLED) {
    await lockSubmissionInboxTable(CONNECTION_STRING);
  }
});

afterAll(async () => {
  if (inspector !== null) {
    await emptyTable();
    await inspector.end();
    inspector = null;
  }
  await unlockSubmissionInboxTable();
});

describe.skipIf(!ENABLED)("import-inbox-jsonl", () => {
  beforeEach(async () => {
    await emptyTable();
    workspace = await mkdtemp(join(tmpdir(), "avaloria-import-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("imports every line of a file the table has never seen", async () => {
    const path = await jsonlFile([
      sourceRecord(),
      sourceRecord({
        submissionId: "sub-import-2",
        receiptId: "receipt-import-2",
        originalText: "eine laterne die den weg kennt",
      }),
    ]);

    const run = runImport(path);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("imported 2, already present 0, of 2 record(s)");
    expect(await storedIds()).toEqual(["sub-import-1", "sub-import-2"]);

    const row = await storedRow("sub-import-1");
    // Byte for byte, surrounding whitespace included: the import is a move, not an edit.
    expect(row?.original_text).toBe("  ein drache mit  zwei koepfen  ");
    expect(row?.receipt_id).toBe("receipt-import-1");
  });

  it("counts an identical row as already present and does not rewrite it", async () => {
    const path = await jsonlFile([sourceRecord()]);
    expect(runImport(path).status).toBe(0);
    const before = await storedRow("sub-import-1");

    const rerun = runImport(path);

    expect(rerun.status).toBe(0);
    expect(rerun.stdout).toContain("imported 0, already present 1, of 1 record(s)");
    // inserted_at is set by a column default, so an UPDATE or a delete-and-reinsert
    // would move it. It is the cheapest proof that the stored row was not touched.
    expect(await storedRow("sub-import-1")).toEqual(before);
  });

  it("accepts a timestamp spelled differently but denoting the same instant", async () => {
    expect(runImport(await jsonlFile([sourceRecord()])).status).toBe(0);

    // The importer normalises both sides with toISOString() before comparing, the same
    // way the adapter normalises before binding. "…09:00:00Z" and "…09:00:00.000Z" are
    // one instant, and an import that failed here would refuse a file it had itself
    // written the equivalent of.
    const rerun = runImport(
      await jsonlFile([sourceRecord({ createdAt: "2026-08-13T09:00:00Z" })]),
    );

    expect(rerun.status).toBe(0);
    expect(rerun.stdout).toContain("imported 0, already present 1, of 1 record(s)");
  });

  it("fails the import when the stored row holds a different original text", async () => {
    expect(runImport(await jsonlFile([sourceRecord()])).status).toBe(0);
    const before = await storedRow("sub-import-1");

    const run = runImport(
      await jsonlFile([sourceRecord({ originalText: "ein ganz anderer satz" })]),
    );

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("conflicting record already in submission_inbox");
    expect(run.stderr).toContain("line 1");
    expect(run.stderr).toContain("originalText");
    // The field name, never the two texts: a child's words do not go into an operator's
    // terminal or their ticket.
    expect(run.stderr).not.toContain("ein ganz anderer satz");
    expect(run.stderr).not.toContain("ein drache mit");
    expect(await storedRow("sub-import-1")).toEqual(before);
  });

  it("fails the import when the stored row holds a different receipt", async () => {
    expect(runImport(await jsonlFile([sourceRecord()])).status).toBe(0);
    const before = await storedRow("sub-import-1");

    const run = runImport(await jsonlFile([sourceRecord({ receiptId: "receipt-other" })]));

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("receiptId");
    expect(await storedRow("sub-import-1")).toEqual(before);
  });

  it("fails the import when an instant diverges after normalisation", async () => {
    expect(runImport(await jsonlFile([sourceRecord()])).status).toBe(0);
    const before = await storedRow("sub-import-1");

    // One second apart. Both are storable instants and both normalise cleanly - they
    // are simply not the same moment, which is exactly the divergence a re-run must
    // notice rather than absorb.
    const run = runImport(
      await jsonlFile([sourceRecord({ receivedAt: "2026-08-13T09:00:02.000Z" })]),
    );

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("receivedAt");
    expect(await storedRow("sub-import-1")).toEqual(before);
  });

  it("rolls back the rows it inserted before it reached the conflicting line", async () => {
    expect(runImport(await jsonlFile([sourceRecord()])).status).toBe(0);

    const run = runImport(
      await jsonlFile([
        // Genuinely new, and it must not survive the run.
        sourceRecord({
          submissionId: "sub-import-fresh",
          receiptId: "receipt-import-fresh",
          originalText: "hinter dem wasserfall",
        }),
        sourceRecord({ originalText: "ein ganz anderer satz" }),
      ]),
    );

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("line 2");
    expect(run.stderr).toContain("nothing was imported");
    // The whole run, one transaction: the fresh row of line 1 is gone with the refusal
    // of line 2, so the operator never has to work out how far the import got.
    expect(await storedIds()).toEqual(["sub-import-1"]);
  });

  it("imports a file holding both a typed answer and a recording", async () => {
    // The cutover file after MCL-49 is mixed. The importer bound seven columns and refused
    // anything that was not kind text, so this whole file failed - loudly, but it failed:
    // an operator moving a real inbox to PostgreSQL could not complete the move at all.
    const path = await jsonlFile([sourceRecord(), sourceRecording()]);

    const run = runImport(path);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("imported 2, already present 0, of 2 record(s)");
    expect(await storedIds()).toEqual(["sub-import-1", "sub-import-audio"]);

    const media = await storedMedia("sub-import-audio");
    expect(media).toEqual({
      media_object_key:
        "cd/cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd.webm",
      media_mime_type: "audio/webm",
      media_extension: "webm",
      // bigint comes back as text: node-postgres refuses to lose precision silently.
      media_size_bytes: "128000",
      media_sha256: "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
    // NULL, not an empty string. A spoken answer's original IS the recording, and a
    // zero-length text here would be indistinguishable from a child who wrote nothing -
    // which is also what submission_inbox_kind_shape refuses.
      original_text: null,
    });

    // And the typed answer beside it is untouched by the widening.
    expect((await storedRow("sub-import-1"))?.original_text).toBe(
      "  ein drache mit  zwei koepfen  ",
    );
  });

  it("counts a re-run of the mixed file as already present, both kinds", async () => {
    const path = await jsonlFile([sourceRecord(), sourceRecording()]);
    expect(runImport(path).status).toBe(0);
    const before = await storedRow("sub-import-audio");

    const rerun = runImport(path);

    expect(rerun.status).toBe(0);
    expect(rerun.stdout).toContain("imported 0, already present 2, of 2 record(s)");
    // inserted_at is a column default, so an UPDATE or a delete-and-reinsert would move
    // it. The recording's row was compared, not rewritten.
    expect(await storedRow("sub-import-audio")).toEqual(before);
  });

  it("fails the import when a stored recording's digest differs from the file's", async () => {
    // The media columns are immutable too. Without them in the comparison a re-run over a
    // row whose object key or digest had diverged would report a clean idempotent import,
    // which is the exact failure this suite was written for on the text side.
    expect(runImport(await jsonlFile([sourceRecording()])).status).toBe(0);
    const before = await storedRow("sub-import-audio");

    const run = runImport(
      await jsonlFile([
        sourceRecording({
          audio: {
            ...sourceRecording().audio,
            objectKey:
              "ef/efefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef.webm",
            sha256: "efefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef",
          },
        }),
      ]),
    );

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("conflicting record already in submission_inbox");
    expect(run.stderr).toContain("audioObjectKey");
    expect(run.stderr).toContain("audioSha256");
    expect(await storedRow("sub-import-audio")).toEqual(before);
  });

  it("still refuses a kind no submission has ever had, and writes nothing", async () => {
    const run = runImport(
      await jsonlFile([sourceRecord(), { ...sourceRecord(), submissionId: "sub-x", kind: "video" }]),
    );

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("malformed submissions.jsonl");
    expect(run.stderr).toContain("line 2");
    // Refused before anything is inserted - the file is validated in full first - so the
    // operator never has to work out how far a half-import got.
    expect(await storedIds()).toEqual([]);
  });

  it("refuses a recording whose media block cannot be read", async () => {
    const run = runImport(
      await jsonlFile([
        { ...sourceRecording(), audio: { ...sourceRecording().audio, sha256: "not-a-digest" } },
      ]),
    );

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("line 1");
    expect(await storedIds()).toEqual([]);
  });

  it("refuses a file whose own two lines claim one submission with different text", async () => {
    const run = runImport(
      await jsonlFile([
        sourceRecord(),
        sourceRecord({ receiptId: "receipt-import-dup", originalText: "eine zweite fassung" }),
      ]),
    );

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("line 2");
    // The comparison runs inside the run's own transaction, so a row inserted a moment
    // ago is compared exactly like a row from an earlier import.
    expect(await storedIds()).toEqual([]);
  });
});
