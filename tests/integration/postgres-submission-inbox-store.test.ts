import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closePostgresSubmissionInboxPools,
  PostgresSubmissionInboxStore,
} from "@/adapters/persistence/postgres-submission-inbox-store";
import {
  SubmissionPayloadError,
  type SubmissionInboxStore,
} from "@/application/submissions/submission-inbox-store";
import {
  describeSubmissionInboxStoreContract,
  inboxRecord,
} from "../unit/submission-inbox-store-contract";
import { describeSubmissionInboxReaderContract } from "../unit/submission-inbox-reader-contract";
import {
  lockSubmissionInboxTable,
  unlockSubmissionInboxTable,
} from "../support/submission-inbox-table-lock";
import { asTextRecord } from "../support/text-submission-shape";
import type { AudioInboxRecord } from "@/application/submissions/submission-inbox-store";

/**
 * A real PostgreSQL is the whole point of this file. `ON CONFLICT` holding under two
 * concurrent inserts, and a timestamptz accepting what the route accepted, are
 * properties of the server - a mocked pool would only prove that this adapter calls
 * pg, which nobody doubts.
 *
 * Skipped rather than failed when MCL_TEST_DATABASE_URL is unset, so `npm run test` on
 * a machine without a database still runs. That is a real gap while it lasts: these
 * cases prove nothing until the variable is set, which is why the CI slice sets it.
 */
const CONNECTION_STRING = process.env.MCL_TEST_DATABASE_URL?.trim() ?? "";
const ENABLED = CONNECTION_STRING.length > 0;

/**
 * Reads the table directly, so what a case asserts about stored rows does not come
 * from the adapter it is testing. Built on first use, never at collection time: the
 * skipped file must not open a connection.
 */
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

/** The contract's "empty store per call": one table, emptied before each handout. */
async function createStore(): Promise<SubmissionInboxStore> {
  await emptyTable();
  return new PostgresSubmissionInboxStore(CONNECTION_STRING);
}

// The table is shared with tests/integration/import-inbox-jsonl.test.ts, which also
// TRUNCATEs it. Vitest runs files in parallel, so both take the same advisory lock.
beforeAll(async () => {
  if (ENABLED) {
    await lockSubmissionInboxTable(CONNECTION_STRING);
  }
});

afterAll(async () => {
  if (inspector !== null) {
    // The table is shared state on a developer's machine, not a temp directory that
    // disappears with the process. It is left as it was found: empty.
    await emptyTable();
    await inspector.end();
    inspector = null;
  }
  await closePostgresSubmissionInboxPools();
  await unlockSubmissionInboxTable();
});

describe.skipIf(!ENABLED)("PostgresSubmissionInboxStore", () => {
  beforeEach(emptyTable);

  it("stores exactly one row when the same submissionId is appended concurrently", async () => {
    const store = new PostgresSubmissionInboxStore(CONNECTION_STRING);

    // More callers than the pool has connections (max: 10), so the losers genuinely
    // queue behind the winner's INSERT and take the lock-wait path. Two callers on a
    // warm pool may never overlap at all, which proves the outcome without ever
    // exercising the mechanism that produces it.
    const CALLERS = 24;

    // A receipt each, because the route mints a fresh one per request: every loser is a
    // genuinely different record that must still not be written.
    const outcomes = await Promise.all(
      Array.from({ length: CALLERS }, (_ignored, index) =>
        store.appendIfAbsent(
          inboxRecord({ submissionId: "sub-race", receiptId: `receipt-race-${index}` }),
        ),
      ),
    );

    expect(outcomes.filter((outcome) => outcome.stored)).toHaveLength(1);

    const { rows } = await inspect().query<{ receipt_id: string }>(
      "SELECT receipt_id FROM submission_inbox WHERE submission_id = $1",
      ["sub-race"],
    );
    expect(rows).toHaveLength(1);

    // And every loser was handed the receipt that is actually in the table, not its own.
    const losers = outcomes.filter((outcome) => !outcome.stored);
    expect(losers).toHaveLength(CALLERS - 1);
    for (const loser of losers) {
      expect(loser.stored === false && loser.existing.receiptId).toBe(rows[0].receipt_id);
    }
  });

  it("shares one pool across store instances built from the same connection string", async () => {
    // Its own application_name, so this case gets its own pool key and its own
    // countable backends: the pools the rest of the file uses are keyed by the plain
    // connection string and stay out of the count.
    const applicationName = "mcl48-pool-ownership";
    const separator = CONNECTION_STRING.includes("?") ? "&" : "?";
    const connectionString = `${CONNECTION_STRING}${separator}application_name=${applicationName}`;

    // The composition root builds a store per request, which is exactly the shape this
    // has to survive.
    for (const index of [0, 1, 2]) {
      const store = new PostgresSubmissionInboxStore(connectionString);
      await store.appendIfAbsent(
        inboxRecord({ submissionId: `sub-pool-${index}`, receiptId: `receipt-pool-${index}` }),
      );
    }

    const { rows } = await inspect().query<{ backends: string }>(
      `SELECT count(*)::text AS backends
         FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = $1`,
      [applicationName],
    );

    // One, not three. Without the cache every submission opens a TCP connection and an
    // auth handshake of its own - and orphans the pool before it, each holding its
    // socket until idleTimeoutMillis. Nothing notices until max_connections does.
    expect(rows[0].backends).toBe("1");
  });

  it("rejects rather than acknowledging a row that was neither inserted nor found", async () => {
    const store = new PostgresSubmissionInboxStore(CONNECTION_STRING);

    // A BEFORE INSERT trigger returning NULL suppresses the row without raising: the
    // INSERT affects 0 rows with no conflict, so the follow-up SELECT finds nothing
    // either. That is the one state in which answering `stored: true` would hand a child
    // a receipt for a submission the database does not hold - worse than an outage,
    // because an outage is visible and this is not.
    await inspect().query(`
      CREATE OR REPLACE FUNCTION suppress_ins() RETURNS trigger
        AS $fn$ BEGIN RETURN NULL; END $fn$ LANGUAGE plpgsql;
    `);
    await inspect().query(`
      CREATE TRIGGER suppress_ins_t BEFORE INSERT ON submission_inbox
        FOR EACH ROW EXECUTE FUNCTION suppress_ins();
    `);

    try {
      await expect(
        store.appendIfAbsent(inboxRecord({ submissionId: "sub-vanished" })),
      ).rejects.toThrow(/sub-vanished/);

      const { rows } = await inspect().query(
        "SELECT 1 FROM submission_inbox WHERE submission_id = $1",
        ["sub-vanished"],
      );
      expect(rows).toHaveLength(0);
    } finally {
      await inspect().query("DROP TRIGGER IF EXISTS suppress_ins_t ON submission_inbox");
      await inspect().query("DROP FUNCTION IF EXISTS suppress_ins()");
    }
  });

  it("reports a check violation as a payload error rather than an outage", async () => {
    const store = new PostgresSubmissionInboxStore(CONNECTION_STRING);

    // Past submission_inbox_original_text_length. The route caps this too, but the
    // route is not the only writer this table will ever have, and the point is the
    // class rather than this one payload: anything the database refuses for what it
    // *is* must reach the caller as "unstorable", never as "unavailable", or the child
    // retries an unchanged submission against a permanent 503.
    await expect(
      store.appendIfAbsent(
        inboxRecord({ submissionId: "sub-too-long", originalText: "a".repeat(4001) }),
      ),
    ).rejects.toBeInstanceOf(SubmissionPayloadError);
  });

  it("reports a data exception as a payload error rather than an outage", async () => {
    const store = new PostgresSubmissionInboxStore(CONNECTION_STRING);

    // 22021: PostgreSQL's UTF8 encoding cannot hold a NUL. The route now refuses this
    // before it can ever get here; this pins what happens the day something else does
    // not.
    await expect(
      store.appendIfAbsent(
        inboxRecord({ submissionId: "sub-nul", originalText: "drache\u0000ende" }),
      ),
    ).rejects.toBeInstanceOf(SubmissionPayloadError);
  });

  it("rejects when the database cannot be reached instead of resolving", async () => {
    // Port 1 refuses. A store that resolved here would let the route answer 201 for a
    // submission no database ever saw.
    const store = new PostgresSubmissionInboxStore("postgresql://nobody@127.0.0.1:1/nothing");

    await expect(
      store.appendIfAbsent(inboxRecord({ submissionId: "sub-unreachable" })),
    ).rejects.toThrow();

    // And not as a payload error. An unreachable database is an outage the route must
    // keep answering 503 for; classifying too widely would tell a child their answer is
    // invalid every time the database blinks, and no retry would ever fix it.
    await expect(
      store.appendIfAbsent(inboxRecord({ submissionId: "sub-unreachable" })),
    ).rejects.not.toBeInstanceOf(SubmissionPayloadError);
  });

  /**
   * The route validates createdAt with Date.parse alone, and Date.parse accepts three
   * shapes timestamptz does not read the same way: "2026" and "2026-08" are a syntax
   * error to PostgreSQL, and "2026-08-14" is a different instant under a non-UTC server
   * timezone. Without normalisation in the adapter the INSERT throws, the route catches
   * it, and a child is told the inbox is down - forever, on every retry.
   *
   * The retry assertion is what pins the second half: the stored value is the same
   * instant JavaScript read, whatever string the client sent.
   */
  it.each(["2026", "2026-08", "2026-08-14"])(
    "stores a createdAt of %s, which the route accepts and timestamptz would not",
    async (createdAt) => {
      const store = new PostgresSubmissionInboxStore(CONNECTION_STRING);
      const submissionId = `sub-${createdAt}`;

      await expect(
        store.appendIfAbsent(
          inboxRecord({ submissionId, createdAt, receiptId: `receipt-${createdAt}` }),
        ),
      ).resolves.toEqual({ stored: true });

      const outcome = await store.appendIfAbsent(
        inboxRecord({ submissionId, createdAt, receiptId: `receipt-${createdAt}-retry` }),
      );
      expect(outcome.stored === false && outcome.existing.createdAt).toBe(
        new Date(createdAt).toISOString(),
      );
    },
  );

  it("hands back the stored receivedAt byte for byte on a retry", async () => {
    const store = new PostgresSubmissionInboxStore(CONNECTION_STRING);
    // The shape the route mints: new Date().toISOString(). The ACK a child already
    // holds is this exact string, so a round trip through timestamptz that changed one
    // character would make the receipt they were given unmatchable.
    const receivedAt = "2026-08-13T09:00:01.000Z";

    await store.appendIfAbsent(
      inboxRecord({ submissionId: "sub-receipt", receivedAt, receiptId: "receipt-first" }),
    );

    const outcome = await store.appendIfAbsent(
      inboxRecord({
        submissionId: "sub-receipt",
        receivedAt: "2026-08-13T10:00:00.000Z",
        receiptId: "receipt-second",
      }),
    );

    expect(outcome.stored).toBe(false);
    expect(outcome.stored === false && outcome.existing.receivedAt).toBe(receivedAt);
    expect(outcome.stored === false && outcome.existing.receiptId).toBe("receipt-first");
  });

  it("stores the original text unchanged, including surrounding space and non-ASCII", async () => {
    const store = new PostgresSubmissionInboxStore(CONNECTION_STRING);
    const originalText = "  ein Drache mit zwei Köpfen  ";

    await store.appendIfAbsent(inboxRecord({ submissionId: "sub-text", originalText }));

    const { rows } = await inspect().query<{ original_text: string }>(
      "SELECT original_text FROM submission_inbox WHERE submission_id = $1",
      ["sub-text"],
    );
    expect(rows[0].original_text).toBe(originalText);

    const outcome = await store.appendIfAbsent(
      inboxRecord({
        submissionId: "sub-text",
        originalText: "Ein ganz anderer Satz.",
        receiptId: "receipt-text-retry",
      }),
    );
    expect(outcome.stored).toBe(false);
    expect(asTextRecord(outcome.stored === false ? outcome.existing : undefined).originalText).toBe(
      originalText,
    );
  });
});

/**
 * Migration 0002 and the audio half of the adapter (MCL-49).
 *
 * These pin the three ways an audio row can be wrong in a way no unit test can see,
 * because all three are enforced by PostgreSQL and not by TypeScript:
 *
 * 1. `submission_inbox_kind_shape` - an audio row whose media columns are missing, or a
 *    text row that smuggled some in. Without the constraint, "kind='audio' with a NULL
 *    object key" is storable, and that row is a child told their recording arrived while
 *    it points at nothing.
 * 2. The size ceiling and the hash shape, which are the two values a second writer could
 *    otherwise widen without touching the application.
 * 3. bigint round-tripping. `media_size_bytes` leaves the driver as a string; a
 *    `Number()` that rounds would put a byte count in the database that disagrees with
 *    the file on disk.
 */
describe.skipIf(!ENABLED)("PostgresSubmissionInboxStore, audio submissions", () => {
  const SHA = "b".repeat(64);

  function audioRecord(overrides: Partial<AudioInboxRecord> = {}): AudioInboxRecord {
    return {
      kind: "audio",
      submissionId: "sub-audio-1",
      questionId: "companion-animal",
      createdAt: "2026-08-21T09:00:00.000Z",
      receivedAt: "2026-08-21T09:00:01.000Z",
      receiptId: "receipt-audio-1",
      audio: {
        objectKey: `bb/${SHA}.webm`,
        mimeType: "audio/webm",
        extension: "webm",
        sizeBytes: 128_000,
        sha256: SHA,
      },
      ...overrides,
    };
  }

  beforeEach(emptyTable);

  it("round-trips every audio field the acceptance criteria name", async () => {
    const store = await createStore();
    const record = audioRecord();

    await expect(store.appendIfAbsent(record)).resolves.toEqual({ stored: true });

    const outcome = await store.appendIfAbsent(audioRecord({ receiptId: "receipt-audio-retry" }));
    expect(outcome.stored).toBe(false);

    const kept = outcome.stored === false ? outcome.existing : undefined;
    expect(kept?.kind).toBe("audio");
    if (kept === undefined || kept.kind !== "audio") throw new Error("expected an audio record");

    // Every field, not a spot check: each one is a separate MCL-49 acceptance criterion.
    expect(kept.audio).toEqual(record.audio);
    // And the receipt the FIRST delivery minted, not the retry's - the same rule the text
    // path follows, so one submissionId can never carry two receipts.
    expect(kept.receiptId).toBe("receipt-audio-1");
  });

  it("keeps the byte count exact rather than rounding it through a JS number", async () => {
    const store = await createStore();
    // 8 MiB exactly: the documented ceiling, which must be accepted rather than refused
    // by an off-by-one in the CHECK.
    await store.appendIfAbsent(
      audioRecord({ audio: { ...audioRecord().audio, sizeBytes: 8_388_608 } }),
    );

    const { rows } = await inspect().query<{ media_size_bytes: string }>(
      "SELECT media_size_bytes FROM submission_inbox WHERE submission_id = $1",
      ["sub-audio-1"],
    );
    expect(rows[0].media_size_bytes).toBe("8388608");
  });

  it("refuses an audio row whose media columns are missing", async () => {
    await expect(
      inspect().query(
        `INSERT INTO submission_inbox
           (submission_id, kind, question_id, created_at, received_at, receipt_id, original_text)
         VALUES ('sub-broken', 'audio', 'q', now(), now(), 'r-broken', NULL)`,
      ),
    ).rejects.toThrow(/submission_inbox_kind_shape/);
  });

  it("refuses a text row that carries media columns", async () => {
    await expect(
      inspect().query(
        `INSERT INTO submission_inbox
           (submission_id, kind, question_id, created_at, received_at, receipt_id,
            original_text, media_object_key, media_mime_type, media_extension,
            media_size_bytes, media_sha256)
         VALUES ('sub-mixed', 'text', 'q', now(), now(), 'r-mixed', 'hallo',
                 $1, 'audio/webm', 'webm', 10, $2)`,
        [`bb/${SHA}.webm`, SHA],
      ),
    ).rejects.toThrow(/submission_inbox_kind_shape/);
  });

  it("refuses a MIME type, a hash and a size the application would never produce", async () => {
    const insert = (mime: string, sha: string, size: number) =>
      inspect().query(
        `INSERT INTO submission_inbox
           (submission_id, kind, question_id, created_at, received_at, receipt_id,
            original_text, media_object_key, media_mime_type, media_extension,
            media_size_bytes, media_sha256)
         VALUES ('sub-bad', 'audio', 'q', now(), now(), 'r-bad', NULL,
                 $1, $2, 'webm', $3, $4)`,
        [`bb/${SHA}.webm`, mime, size, sha],
      );

    // Not on the allowlist - the case where a second writer widens the formats without
    // touching the application.
    await expect(insert("application/x-msdownload", SHA, 10)).rejects.toThrow(
      /submission_inbox_media_mime_known/,
    );
    // Uppercase hex: parses as a hash everywhere except in the object key the application
    // derives from it, which would then name a file that does not exist.
    await expect(insert("audio/webm", "B".repeat(64), 10)).rejects.toThrow(
      /submission_inbox_media_sha256_shape/,
    );
    // One byte over the documented 8 MiB ceiling.
    await expect(insert("audio/webm", SHA, 8_388_609)).rejects.toThrow(
      /submission_inbox_media_size_bounded/,
    );
  });

  it("stores two different submissions that share one recording", async () => {
    // Content addressing means identical bytes produce an identical object key. Two
    // children forwarding the same voice memo is a legitimate pair of answers, and an
    // over-eager UNIQUE constraint on media_object_key would refuse the second one - so
    // this test exists to keep anybody from adding it.
    const store = await createStore();

    await expect(store.appendIfAbsent(audioRecord())).resolves.toEqual({ stored: true });
    await expect(
      store.appendIfAbsent(
        audioRecord({ submissionId: "sub-audio-2", receiptId: "receipt-audio-2" }),
      ),
    ).resolves.toEqual({ stored: true });

    const { rows } = await inspect().query<{ total: string }>(
      "SELECT count(*)::text AS total FROM submission_inbox WHERE media_object_key = $1",
      [`bb/${SHA}.webm`],
    );
    expect(rows[0].total).toBe("2");
  });

  it("shows an audio answer on the protected read side without leaking a path", async () => {
    // The adapter directly, not createStore(): that helper empties the table on every
    // call and hands back the write port alone, so reading through it would report an
    // inbox it had just cleared.
    const store = new PostgresSubmissionInboxStore(CONNECTION_STRING);
    await store.appendIfAbsent(audioRecord());

    const page = await store.list({ kind: "audio" });
    expect(page.total).toBe(1);

    const entry = page.entries[0];
    expect(entry.kind).toBe("audio");
    if (entry.kind !== "audio") throw new Error("expected an audio entry");

    expect(entry.audio.sha256).toBe(SHA);
    expect(entry.audio.mimeType).toBe("audio/webm");
    expect(entry.status).toBe("RECEIVED");
    // The filter is exact: asking for text must not return the recording.
    expect((await store.list({ kind: "text" })).total).toBe(0);
  });
});

// Registered only when a database is configured: the contract helper builds its own
// suite, so there is no describe of ours to hang a skipIf on. The suite above always
// registers, so the file is never empty of tests.
if (ENABLED) {
  describeSubmissionInboxStoreContract("PostgresSubmissionInboxStore", createStore);

  // The same read contract the file adapter satisfies, against the real database. The
  // ordering, the exact-match filtering and the uncapped total are the three things a
  // SQL implementation can get wrong in ways an in-memory one cannot - a missing
  // tiebreaker, a LIKE where an `=` belongs, a count that inherits the LIMIT.
  describeSubmissionInboxReaderContract("PostgresSubmissionInboxStore", async (seed) => {
    await emptyTable();
    const store = new PostgresSubmissionInboxStore(CONNECTION_STRING);
    for (const entry of seed) {
      await store.appendIfAbsent(entry);
    }
    return store;
  });
}
