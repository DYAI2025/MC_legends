import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  closePostgresSubmissionInboxPools,
  PostgresSubmissionInboxStore,
} from "@/adapters/persistence/postgres-submission-inbox-store";
import type { SubmissionInboxStore } from "@/application/submissions/submission-inbox-store";
import {
  describeSubmissionInboxStoreContract,
  inboxRecord,
} from "../unit/submission-inbox-store-contract";

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

afterAll(async () => {
  if (inspector !== null) {
    // The table is shared state on a developer's machine, not a temp directory that
    // disappears with the process. It is left as it was found: empty.
    await emptyTable();
    await inspector.end();
    inspector = null;
  }
  await closePostgresSubmissionInboxPools();
});

describe.skipIf(!ENABLED)("PostgresSubmissionInboxStore", () => {
  beforeEach(emptyTable);

  it("stores exactly one row when the same submissionId is appended concurrently", async () => {
    const store = new PostgresSubmissionInboxStore(CONNECTION_STRING);

    // Two receipts, because the route mints a fresh one per request: the loser is a
    // genuinely different record that must still not be written.
    const outcomes = await Promise.all([
      store.appendIfAbsent(inboxRecord({ submissionId: "sub-race", receiptId: "receipt-race-1" })),
      store.appendIfAbsent(inboxRecord({ submissionId: "sub-race", receiptId: "receipt-race-2" })),
    ]);

    expect(outcomes.filter((outcome) => outcome.stored)).toHaveLength(1);

    const { rows } = await inspect().query<{ receipt_id: string }>(
      "SELECT receipt_id FROM submission_inbox WHERE submission_id = $1",
      ["sub-race"],
    );
    expect(rows).toHaveLength(1);

    // And the loser was handed the receipt that is actually in the table, not its own.
    const loser = outcomes.find((outcome) => !outcome.stored);
    expect(loser?.stored === false && loser.existing.receiptId).toBe(rows[0].receipt_id);
  });

  it("rejects when the database cannot be reached instead of resolving", async () => {
    // Port 1 refuses. A store that resolved here would let the route answer 201 for a
    // submission no database ever saw.
    const store = new PostgresSubmissionInboxStore("postgresql://nobody@127.0.0.1:1/nothing");

    await expect(
      store.appendIfAbsent(inboxRecord({ submissionId: "sub-unreachable" })),
    ).rejects.toThrow();
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
    expect(outcome.stored === false && outcome.existing.originalText).toBe(originalText);
  });
});

// Registered only when a database is configured: the contract helper builds its own
// suite, so there is no describe of ours to hang a skipIf on. The suite above always
// registers, so the file is never empty of tests.
if (ENABLED) {
  describeSubmissionInboxStoreContract("PostgresSubmissionInboxStore", createStore);
}
