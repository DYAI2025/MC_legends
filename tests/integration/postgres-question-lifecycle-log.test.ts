import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresQuestionLifecycleLog } from "@/adapters/persistence/postgres-question-lifecycle-log";
import { closePostgresPools } from "@/adapters/persistence/postgres-pool";
import {
  closeRequest,
  describeQuestionLifecycleContract,
  reopenRequest,
} from "../unit/question-lifecycle-contract";

/**
 * A real PostgreSQL is the whole point of this file (MCL-35).
 *
 * The two things a mocked pool could never show are exactly the two this table exists
 * for: that `question_lifecycle_revision_unique` lets one of two racing closes through
 * and no more, and that a reopen leaves the close as a second row rather than as an
 * edit. Both are properties of the server.
 *
 * Skipped rather than failed when MCL_TEST_DATABASE_URL is unset, so `npm run test` on a
 * machine without a database still runs - and `npm run check:integration-ran` is what
 * turns that skip back into a failure where it matters.
 *
 * No advisory table lock, unlike the submission_inbox suites: this is the only file that
 * TRUNCATEs question_lifecycle_event, so there is no second owner to serialise against.
 */
const CONNECTION_STRING = process.env.MCL_TEST_DATABASE_URL?.trim() ?? "";
const ENABLED = CONNECTION_STRING.length > 0;

/** Reads the table directly, so assertions do not come from the adapter under test. */
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
  await inspect().query("TRUNCATE question_lifecycle_event");
}

afterAll(async () => {
  if (inspector !== null) {
    // Left as it was found: empty. This is a developer machine, not a temp directory
    // that disappears with the process.
    await emptyTable();
    await inspector.end();
    inspector = null;
  }
  await closePostgresPools();
});

describe.skipIf(!ENABLED)("PostgresQuestionLifecycleLog", () => {
  beforeEach(emptyTable);

  it("writes exactly one event when many callers close the same question at once", async () => {
    const log = new PostgresQuestionLifecycleLog(CONNECTION_STRING);

    // More callers than the pool has connections (max: 10), so the losers genuinely
    // queue behind the winner and take the unique-index wait. Two callers on a warm pool
    // may never overlap at all, which would prove the outcome without ever exercising
    // the mechanism that produces it.
    const CALLERS = 24;

    const outcomes = await Promise.all(
      Array.from({ length: CALLERS }, () => log.append(closeRequest("companion-animal"))),
    );

    expect(outcomes.filter((outcome) => outcome.applied)).toHaveLength(1);

    const { rows } = await inspect().query<{ revision: number }>(
      "SELECT revision FROM question_lifecycle_event WHERE question_id = $1",
      ["companion-animal"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].revision).toBe(0);

    // Every loser was told the state that actually holds, so a board can show the truth
    // instead of only refusing.
    for (const loser of outcomes.filter((outcome) => !outcome.applied)) {
      expect(loser.applied === false && loser.currentState).toBe("closed");
    }
  });

  it("survives a process restart, which is the whole reason the table exists", async () => {
    // A second adapter instance reading what the first one wrote. It is the closest a
    // test in one process can get to a redeploy, and it is the property the JSONL file
    // and this table are both supposed to have and only this one has across instances.
    await new PostgresQuestionLifecycleLog(CONNECTION_STRING).append(
      closeRequest("companion-animal"),
    );

    const afterRestart = await new PostgresQuestionLifecycleLog(CONNECTION_STRING).snapshot();

    expect(afterRestart["companion-animal"]?.state).toBe("closed");
  });

  it("keeps the close row byte for byte when the question is reopened", async () => {
    const log = new PostgresQuestionLifecycleLog(CONNECTION_STRING);
    await log.append(closeRequest("companion-animal"));

    const before = await inspect().query(
      "SELECT sequence, revision, action, previous_state, next_state, occurred_at, recorded_at FROM question_lifecycle_event WHERE question_id = $1 AND revision = 0",
      ["companion-animal"],
    );

    await log.append(reopenRequest("companion-animal"));

    const after = await inspect().query(
      "SELECT sequence, revision, action, previous_state, next_state, occurred_at, recorded_at FROM question_lifecycle_event WHERE question_id = $1 AND revision = 0",
      ["companion-animal"],
    );

    // Not "there are two rows" - that is in the shared contract. This is the stronger
    // claim: the first row was not touched. An implementation that kept a state column
    // up to date next to the history would pass the contract and fail here.
    expect(after.rows).toEqual(before.rows);
    expect(after.rows).toHaveLength(1);
  });

  it("records both the application clock and the database clock", async () => {
    const log = new PostgresQuestionLifecycleLog(CONNECTION_STRING);
    await log.append(closeRequest("companion-animal"));

    const { rows } = await inspect().query<{ occurred_at: Date; recorded_at: Date }>(
      "SELECT occurred_at, recorded_at FROM question_lifecycle_event WHERE question_id = $1",
      ["companion-animal"],
    );

    // Two clocks, because the gap between them is the only way to notice that an
    // application clock is wrong. Neither is ever used for ordering - `sequence` is.
    expect(rows[0].occurred_at).toBeInstanceOf(Date);
    expect(rows[0].recorded_at).toBeInstanceOf(Date);
  });

  it("orders reopened questions behind each other by the sequence the database assigned", async () => {
    const log = new PostgresQuestionLifecycleLog(CONNECTION_STRING);

    await log.append(closeRequest("companion-animal"));
    await log.append(closeRequest("druhen-protection"));
    await log.append(reopenRequest("druhen-protection"));
    await log.append(reopenRequest("companion-animal"));

    const snapshot = await log.snapshot();

    // druhen-protection came back first, so it takes its turn first - even though the
    // dataset lists companion-animal earlier. This is the value the rotation sorts on.
    expect(snapshot["druhen-protection"]?.sequence).toBeLessThan(
      snapshot["companion-animal"]?.sequence ?? 0,
    );
  });
});

// Registered only when a database is configured: the contract helper builds its own
// suite, so there is no describe of ours to hang a skipIf on. The suite above always
// registers, so the file is never empty of tests.
if (ENABLED) {
  describeQuestionLifecycleContract("PostgresQuestionLifecycleLog", async () => {
    await emptyTable();
    return new PostgresQuestionLifecycleLog(CONNECTION_STRING);
  });
}
