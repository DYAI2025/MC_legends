import { Client } from "pg";

/**
 * Serialises the integration files that own `submission_inbox` as a whole.
 *
 * Vitest runs test FILES in parallel. Both files that touch this table `TRUNCATE` it to
 * get a known starting point, so in parallel each one empties the other's rows mid-test:
 * measured 2026-08-18, adding a second such file turned six passing cases into failures
 * that had nothing to do with the code under test ("expected [ { stored: true }, {
 * stored: true } ] to have a length of 1").
 *
 * A PostgreSQL session-level advisory lock rather than `fileParallelism: false`: the
 * constraint is "one owner of this table at a time", not "no parallelism", and the unit
 * suite has no reason to pay for it. The lock is released when the session ends, so a
 * crashed worker cannot leave the next run blocked.
 *
 * Not a mechanism for production code. Nothing in `src` takes this lock, and nothing
 * should - the table's real concurrency guarantee is the primary key on submission_id.
 */
const TABLE_LOCK_KEY = 4820481048;

let holder: Client | null = null;

/** Blocks until this file is the only one working on the table. */
export async function lockSubmissionInboxTable(connectionString: string): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  await client.query("SELECT pg_advisory_lock($1)", [TABLE_LOCK_KEY]);
  holder = client;
}

/** Releases the lock, if this file ever took it. Safe to call unconditionally. */
export async function unlockSubmissionInboxTable(): Promise<void> {
  const client = holder;
  if (client === null) {
    return;
  }

  holder = null;
  await client.query("SELECT pg_advisory_unlock($1)", [TABLE_LOCK_KEY]);
  await client.end();
}
