import { Pool } from "pg";
import type {
  AppendOutcome,
  InboxRecord,
  SubmissionInboxStore,
} from "@/application/submissions/submission-inbox-store";

/** The columns this adapter writes and reads back. Defaults own status and inserted_at. */
type InboxRow = {
  submission_id: string;
  kind: string;
  question_id: string;
  created_at: Date;
  received_at: Date;
  receipt_id: string;
  original_text: string;
};

const COLUMNS =
  "submission_id, kind, question_id, created_at, received_at, receipt_id, original_text";

/**
 * The insert is a single statement so the conflict is resolved by the primary key and
 * not by anything this process believes about what is already stored.
 *
 * RETURNING yields no row on conflict, which is exactly the signal the caller needs -
 * and exactly why a second statement has to fetch the record that won.
 */
const INSERT = `
  INSERT INTO submission_inbox (${COLUMNS})
  VALUES ($1, $2, $3, $4, $5, $6, $7)
  ON CONFLICT (submission_id) DO NOTHING
  RETURNING submission_id
`;

const SELECT = `SELECT ${COLUMNS} FROM submission_inbox WHERE submission_id = $1`;

/**
 * One pool per connection string, shared by every store instance in this process.
 *
 * The composition root builds a store per request - right for a file that holds no
 * connection, fatal for a database, where it would mean a new pool and a new TCP
 * connection per submission. Keyed by connection string rather than global so a test
 * pointing at a second database does not silently reuse the first one's pool.
 */
const pools = new Map<string, Pool>();

function poolFor(connectionString: string): Pool {
  const existing = pools.get(connectionString);
  if (existing !== undefined) {
    return existing;
  }

  const pool = new Pool({ connectionString });

  // A pool emits 'error' for a client that fails while idle - a server restart, a proxy
  // closing the connection, a failover. Without a listener that is an unhandled 'error'
  // event, and node ends the process for it: the whole app dies because one idle socket
  // was dropped. The pool itself discards the client and carries on.
  pool.on("error", (cause) => {
    console.error("submission inbox pool error", cause);
  });

  // Per connection, not per query: pg hands a new client to the waiting caller only
  // after this listener has run, and a client executes its queries in order, so this
  // is the first statement on every connection. Belt and braces behind the
  // normalisation below - the instants are already unambiguous when they are bound, so
  // a failure here cannot change what is stored, only what a raw SELECT prints.
  pool.on("connect", (client) => {
    client.query("SET TIME ZONE 'UTC'").catch((cause: unknown) => {
      console.error("submission inbox session timezone not set", cause);
    });
  });

  pools.set(connectionString, pool);
  return pool;
}

/**
 * Every timestamp this adapter binds, pinned to one instant and one spelling.
 *
 * The route validates createdAt with Date.parse and nothing else, and Date.parse is
 * wider than timestamptz: "2026" and "2026-08" are values the route accepts and
 * PostgreSQL refuses outright, and "2026-08-14" is a date the two read as different
 * instants unless the server's timezone happens to be UTC. Binding the raw string would
 * turn all three into a thrown INSERT, which the route reports as 503 inbox-unavailable
 * - a validation problem told to a child as an outage, and one that repeats on every
 * retry because the payload never changes.
 *
 * So the stored createdAt is the same *instant* the client sent, possibly a different
 * *string*. Nothing observes the difference today - the ACK carries only receiptId and
 * receivedAt - but it is a decision, not a side effect of the column type. receivedAt
 * is minted by the route as an ISO string already, so for it this is a no-op that keeps
 * the ACK byte-identical.
 */
function instant(value: string): string {
  return new Date(value).toISOString();
}

function toRecord(row: InboxRow): InboxRecord {
  return {
    // The kind CHECK constraint in 0001_submission_inbox.sql is what makes this true.
    // Widening the union (audio, MCL-30) means widening that constraint in the same
    // change, and the compiler will not remind anyone here.
    kind: row.kind as InboxRecord["kind"],
    receiptId: row.receipt_id,
    receivedAt: row.received_at.toISOString(),
    submissionId: row.submission_id,
    questionId: row.question_id,
    createdAt: row.created_at.toISOString(),
    originalText: row.original_text,
  };
}

/**
 * Durable store for the family project inbox (MCL-48).
 *
 * Idempotency lives in the primary key on submission_id rather than in this process, so
 * unlike the file adapter it holds across concurrent requests, across app instances and
 * across a crash between the check and the write.
 */
export class PostgresSubmissionInboxStore implements SubmissionInboxStore {
  constructor(private readonly connectionString: string) {}

  async appendIfAbsent(record: InboxRecord): Promise<AppendOutcome> {
    const pool = poolFor(this.connectionString);

    const inserted = await pool.query(INSERT, [
      record.submissionId,
      record.kind,
      record.questionId,
      instant(record.createdAt),
      instant(record.receivedAt),
      record.receiptId,
      record.originalText,
    ]);

    if (inserted.rowCount === 1) {
      return { stored: true };
    }

    // Deliberately outside any explicit transaction, and the isolation level is left at
    // READ COMMITTED. That is what makes this pair correct: the losing INSERT waits for
    // the winner to commit, and this SELECT then takes a fresh snapshot that sees the
    // winner's row. Under REPEATABLE READ it would reuse the older snapshot and find
    // nothing - the one case below.
    const existing = await pool.query<InboxRow>(SELECT, [record.submissionId]);
    const row = existing.rows[0];

    if (row === undefined) {
      // Nothing inserted and nothing found. Answering `stored: true` here would hand a
      // child a receipt for a submission the database does not hold - worse than an
      // outage, because an outage is visible and this is not.
      throw new Error(
        `submission ${record.submissionId} was neither inserted nor found in submission_inbox`,
      );
    }

    return { stored: false, existing: toRecord(row) };
  }
}

/**
 * Closes every pool this module opened. For tests, which must not leave a worker with
 * an open socket, and for any future graceful shutdown. Nothing in the request path
 * calls it - a pool is meant to outlive the request that first needed it.
 */
export async function closePostgresSubmissionInboxPools(): Promise<void> {
  const open = [...pools.values()];
  pools.clear();
  await Promise.all(open.map((pool) => pool.end()));
}
