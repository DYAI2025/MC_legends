import { Pool } from "pg";
import type { PoolClient, PoolConfig, QueryResult, QueryResultRow } from "pg";
import {
  SubmissionPayloadError,
  type AppendOutcome,
  type InboxRecord,
  type TextInboxRecord,
  type SubmissionInboxStore,
} from "@/application/submissions/submission-inbox-store";
import {
  MAX_INBOX_PAGE_SIZE,
  type InboxEntry,
  type InboxEntryStatus,
  type InboxPage,
  type InboxQuery,
  type SubmissionInboxReader,
} from "@/application/submissions/submission-inbox-reader";

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

/** The same row plus the column only the read side selects. */
type InboxEntryRow = InboxRow & { status: string };

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
 * The read side's columns: everything the write side round-trips, plus `status`, which
 * no writer supplies and the schema defaults.
 */
const ENTRY_COLUMNS = `${COLUMNS}, status`;

/**
 * Newest-first, with submission_id as the tiebreaker.
 *
 * received_at is not unique - two answers can land in the same millisecond - and without
 * the second key their relative order is whatever the planner happened to produce, which
 * can differ between two runs of the same query. An inbox whose "latest" is unstable is
 * an inbox somebody will page through twice and see different things.
 *
 * submission_inbox_received_at_idx and submission_inbox_question_recent_idx were created
 * by migration 0001 for exactly this query and this filter.
 */
const ORDER = " ORDER BY received_at DESC, submission_id DESC";

/**
 * pg-pool 8.16.3 accepts an `onConnect` hook that is awaited before the new client is
 * handed to the caller, and fails the acquisition when it rejects. @types/pg 8.15.6
 * does not declare it yet, so the option is declared here rather than by widening the
 * project's types or casting the whole config away.
 */
type PoolConfigWithOnConnect = PoolConfig & {
  onConnect?: (client: PoolClient) => Promise<void>;
};

/**
 * The session settings every connection in this pool starts with.
 *
 * TIME ZONE is cosmetic - the instants are already unambiguous when they are bound, so
 * it only changes what a raw SELECT prints. DateStyle is not: under anything other than
 * ISO output pg's timestamptz parser hands back `null` instead of a Date, and
 * toISOString() then throws a TypeError naming neither the column nor the cause. A
 * per-database `ALTER ... SET datestyle`, a PGDATESTYLE in the environment or an
 * `?options=-c datestyle=...` in a managed connection string is enough to cause it.
 *
 * Run from `onConnect` rather than a `connect` listener on purpose: the listener's
 * rejection could only be logged, and the client would be handed out unpinned anyway.
 * This is awaited, and a failure here fails the acquisition - which the route already
 * reports as 503, the honest answer for a database that cannot be configured.
 */
async function pinSession(client: PoolClient): Promise<void> {
  await client.query("SET TIME ZONE 'UTC'");
  await client.query("SET DateStyle = 'ISO, YMD'");
}

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

  /**
   * Every timeout here exists to convert an invisible hang into the 503 the route
   * already handles. Without them a database that is *down* refuses in milliseconds and
   * produces a clean refusal, while one that is slow, pool-exhausted or black-holing
   * packets never answers at all - and a child watches a spinner instead of being told
   * the letterbox cannot be reached, which is the worse of the two outcomes.
   */
  const config: PoolConfigWithOnConnect = {
    connectionString,
    // The pg-pool default. Named because the number is now load-bearing: it is the
    // ceiling the connectionTimeoutMillis below applies to.
    max: 10,
    // Not a default - unset, pg-pool queues a caller waiting for a slot with no timer
    // at all (pg-pool/index.js:206-208), so a saturated pool is an unbounded wait.
    connectionTimeoutMillis: 5_000,
    // Server-side: a statement still running when the client has given up is cancelled
    // there instead of holding its connection and its locks to the end.
    statement_timeout: 10_000,
    // Client-side backstop for the case where the server never answers at all.
    query_timeout: 10_000,
    // This adapter opens no explicit transaction. The setting is for the day something
    // does, so a half-finished one cannot keep a connection out of the pool for good.
    idle_in_transaction_session_timeout: 10_000,
    onConnect: pinSession,
  };

  const pool = new Pool(config);

  // A pool emits 'error' for a client that fails while idle - a server restart, a proxy
  // closing the connection, a failover. Without a listener that is an unhandled 'error'
  // event, and node ends the process for it: the whole app dies because one idle socket
  // was dropped. The pool itself discards the client and carries on.
  pool.on("error", (cause) => {
    console.error("submission inbox pool error", cause);
  });

  pools.set(connectionString, pool);
  return pool;
}

/**
 * SQLSTATE classes that only the bound values can cause.
 *
 * Class 22 is "data exception": a NUL in a text parameter (22021), a timestamp out of
 * range (22008), a malformed datetime literal (22007). 23514 is a check violation - the
 * lengths and the kind list in 0001_submission_inbox.sql. Each is permanent for that
 * payload, so calling it an outage means a child retrying an unchanged submission
 * against a wall forever.
 *
 * Deliberately narrow, because the cost of being wrong is asymmetric. 23505 is NOT
 * here: a unique violation on this table means this server minted a receipt twice,
 * which is its fault and not the caller's. Neither is 42P01 (missing table), 53300 (too
 * many connections) or any connection failure - those are outages, and 503 is honest.
 */
function isPayloadFault(cause: unknown): boolean {
  const code = (cause as { code?: unknown } | null | undefined)?.code;
  if (typeof code !== "string" || code.length !== 5) {
    return false;
  }
  return code.startsWith("22") || code === "23514";
}

/**
 * Every statement this adapter runs, with the payload faults separated from the
 * outages.
 *
 * Fixing the three payloads found so far in the route closes those three. This closes
 * the class: without it the adapter cannot tell the route "this was your payload, not
 * my database", so every future tightening of the schema becomes a new permanent 503
 * that nobody predicted.
 */
async function run<Row extends QueryResultRow>(
  pool: Pool,
  text: string,
  values: unknown[],
): Promise<QueryResult<Row>> {
  try {
    return await pool.query<Row>(text, values);
  } catch (cause) {
    if (isPayloadFault(cause)) {
      // The driver's message names the column and often the offending byte. It is kept
      // as `cause` for the server log and left out of the thrown message, because the
      // route logs what it catches and must never echo it to a child's browser.
      throw new SubmissionPayloadError(
        "submission_inbox refused the submitted values",
        { cause },
      );
    }
    throw cause;
  }
}

/**
 * Every timestamp this adapter binds, pinned to one instant and one spelling.
 *
 * Date.parse is wider than timestamptz: "2026" and "2026-08" are values the route
 * accepts and PostgreSQL refuses outright, and "2026-08-14" is a date the two read as
 * different instants unless the server's timezone happens to be UTC. Binding the raw
 * string would turn all three into a thrown INSERT and a 503 that repeats on every
 * retry because the payload never changes.
 *
 * What this does NOT do is make every Date.parse-able string storable, and the comment
 * that once claimed otherwise was wrong. toISOString() spells a year outside 1..9999
 * with the expanded ±YYYYYY form, which timestamptz reads as a time zone displacement
 * and refuses (22009), and PostgreSQL has no year zero at all (22008). That range check
 * lives in the route with the other payload guards, where refusing a payload belongs; a
 * store handed one anyway now says so with SubmissionPayloadError rather than looking
 * like an outage.
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

/**
 * The timestamp columns, checked rather than believed.
 *
 * InboxRow declares them as Date, so TypeScript sanctions whatever pg actually returns.
 * Under a session DateStyle other than ISO output pg's parser returns null, and the
 * bare `.toISOString()` this replaces threw a TypeError naming neither the column nor
 * the cause. The shape of that failure is the reason it is worth two lines: the
 * `stored: true` path never reads a row back, so first submissions would keep
 * succeeding while only retries turned into permanent 503s.
 */
function isoFrom(row: InboxRow, column: "created_at" | "received_at"): string {
  const value = row[column];

  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(
      `submission_inbox.${column} did not come back as a timestamp - check the session DateStyle, which must be 'ISO, YMD'`,
    );
  }

  return value.toISOString();
}

/**
 * The kind CHECK constraint in 0001_submission_inbox.sql is what makes this narrowing
 * true today. Checked instead of cast, so widening the union (audio, MCL-30) without
 * widening the constraint and this function fails loudly on the row it cannot type,
 * rather than handing the caller a record whose declared kind is a lie.
 */
function kindFrom(value: string): "text" {
  if (value === "text") {
    return value;
  }

  throw new Error(`submission_inbox.kind holds a value this adapter cannot type: ${value}`);
}

function toRecord(row: InboxRow): TextInboxRecord {
  return {
    kind: kindFrom(row.kind),
    receiptId: row.receipt_id,
    receivedAt: isoFrom(row, "received_at"),
    submissionId: row.submission_id,
    questionId: row.question_id,
    createdAt: isoFrom(row, "created_at"),
    originalText: row.original_text,
  };
}

/**
 * Same narrowing argument as kindFrom: the `submission_inbox_status_known` CHECK is what
 * makes this true, and a status the constraint allows but this function does not know
 * must fail on the row rather than reach the admin view as an untyped string.
 */
function statusFrom(value: string): InboxEntryStatus {
  if (value === "RECEIVED") {
    return value;
  }

  throw new Error(`submission_inbox.status holds a value this adapter cannot type: ${value}`);
}

function toEntry(row: InboxEntryRow): InboxEntry {
  return {
    ...toRecord(row),
    status: statusFrom(row.status),
  };
}

/**
 * Builds the WHERE clause and its bound values together, so a filter can never be added
 * to one without the other.
 *
 * Every value is a placeholder. Not one filter is interpolated into the SQL text - and
 * `questionId` uses `=` rather than LIKE on purpose: LIKE would make "companion" match
 * "companion-animal", which widens silently and looks like more answers rather than a
 * bug.
 */
function whereFrom(query: InboxQuery): { sql: string; values: unknown[] } {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (query.questionId !== undefined) {
    values.push(query.questionId);
    clauses.push(`question_id = $${values.length}`);
  }

  if (query.kind !== undefined) {
    values.push(query.kind);
    clauses.push(`kind = $${values.length}`);
  }

  if (query.status !== undefined) {
    values.push(query.status);
    clauses.push(`status = $${values.length}`);
  }

  return {
    sql: clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`,
    values,
  };
}

/**
 * A caller-supplied limit, clamped. Anything that is not a positive integer falls back
 * to the maximum rather than to nothing: a malformed limit must not render an empty
 * inbox that reads as "no answers yet".
 */
function pageSize(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit <= 0) {
    return MAX_INBOX_PAGE_SIZE;
  }

  return Math.min(limit, MAX_INBOX_PAGE_SIZE);
}

/**
 * Durable store for the family project inbox (MCL-48).
 *
 * Idempotency lives in the primary key on submission_id rather than in this process, so
 * unlike the file adapter it holds across concurrent requests, across app instances and
 * across a crash between the check and the write.
 */
export class PostgresSubmissionInboxStore
  implements SubmissionInboxStore, SubmissionInboxReader
{
  constructor(private readonly connectionString: string) {}

  /**
   * MCL-50's protected read.
   *
   * The count runs under the same WHERE as the page but without its LIMIT, so a capped
   * page still reports how much exists. Two statements rather than a window function
   * because the alternative - `count(*) OVER ()` - returns no count at all when the page
   * is empty, which is precisely the case where "how many are there" still has a useful
   * answer.
   *
   * Not in a transaction: an entry arriving between the two statements can make the
   * total one higher than the page explains. For an append-only family inbox that is a
   * fresher number, not an inconsistent one, and it is not worth holding a snapshot
   * open on the request path.
   */
  async list(query: InboxQuery): Promise<InboxPage> {
    const pool = poolFor(this.connectionString);
    const where = whereFrom(query);
    const limit = pageSize(query.limit);

    const page = await run<InboxEntryRow>(
      pool,
      `SELECT ${ENTRY_COLUMNS} FROM submission_inbox${where.sql}${ORDER} LIMIT $${where.values.length + 1}`,
      [...where.values, limit],
    );

    const counted = await run<{ total: string }>(
      pool,
      `SELECT count(*)::text AS total FROM submission_inbox${where.sql}`,
      where.values,
    );

    return {
      entries: page.rows.map(toEntry),
      // count(*) is bigint, which pg hands back as a string so a value beyond
      // Number.MAX_SAFE_INTEGER cannot be silently mangled. Cast in SQL and parsed here
      // rather than trusting whatever the driver decided a bigint should become.
      total: Number(counted.rows[0]?.total ?? "0"),
    };
  }

  async appendIfAbsent(record: InboxRecord): Promise<AppendOutcome> {
    if (record.kind !== "text") {
      // Migration 0001's `submission_inbox_kind_known` CHECK allows only 'text', so this
      // schema physically cannot hold the record. Refused here, before any INSERT, so the
      // failure names the cause instead of surfacing as a constraint violation nobody can
      // read.
      //
      // NOT a SubmissionPayloadError: the payload is fine, the schema is behind. That
      // distinction is what the route branches on, and calling this a payload problem would
      // tell a child their recording is invalid when the truth is that migration 0002 has
      // not been applied yet - exactly the window the deploy runbook documents in section
      // 6.2, where an un-migrated database must answer 503 rather than 400.
      throw new Error(
        `submission_inbox cannot hold a '${record.kind}' submission until migration 0002 is applied`,
      );
    }

    const pool = poolFor(this.connectionString);

    const inserted = await run(pool, INSERT, [
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
    const existing = await run<InboxRow>(pool, SELECT, [record.submissionId]);
    const row = existing.rows[0];

    if (row === undefined) {
      // Nothing inserted and nothing found. Answering `stored: true` here would hand a
      // child a receipt for a submission the database does not hold - worse than an
      // outage, because an outage is visible and this is not.
      throw new Error(
        `submission ${record.submissionId} was neither inserted nor found in submission_inbox`,
      );
    }

    const kept = toRecord(row);

    if (kept.originalText !== record.originalText) {
      // Correct per the port's contract - the stored original is never rewritten by a
      // later delivery - but silent until now, which would leave MCL-50's admin view
      // showing an answer nobody can explain. The submissionId only: the two texts are
      // a child's own words and do not belong in a log.
      console.warn(
        `submission ${record.submissionId} was re-delivered with different originalText; the stored text is kept`,
      );
    }

    return { stored: false, existing: kept };
  }
}

/**
 * Closes every pool this module opened. Test-only: a vitest worker must not be left
 * holding an open socket. Nothing in the request path calls it - a pool is meant to
 * outlive the request that first needed it.
 *
 * It does NOT drain, and must not be mistaken for a graceful shutdown. pg-pool returns
 * from `_pulseQueue` without serving the pending queue once `ending` is set, so a call
 * already waiting for a client never settles at all - no result, no rejection, no row.
 * Wired to SIGTERM this would turn every in-flight submission during a deploy into a
 * request that simply never returns, which is strictly worse than the 503 a killed
 * process gives. A real shutdown needs a drain that does not exist yet.
 */
export async function closePostgresSubmissionInboxPools(): Promise<void> {
  const open = [...pools.values()];
  pools.clear();
  await Promise.all(open.map((pool) => pool.end()));
}
