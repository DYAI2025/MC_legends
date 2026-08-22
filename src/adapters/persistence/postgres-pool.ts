import { Pool } from "pg";
import type { PoolClient, PoolConfig } from "pg";

/**
 * The one place this application opens a connection to PostgreSQL.
 *
 * Extracted when MCL-35 added a second table with a second adapter. A copy of this file
 * per adapter would work on the day it was written and drift afterwards - and the two
 * settings most worth not drifting are invisible in normal operation: the DateStyle pin,
 * whose absence turns every timestamp into `null` at the driver, and the timeouts, whose
 * absence turns a slow database into a request that never answers instead of the 503 the
 * routes already handle.
 *
 * Sharing one pool between the adapters is also the honest resource decision: they talk
 * to the same server with the same credentials, and two pools would mean twice the
 * backends for no isolation anybody asked for.
 */

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
 * This is awaited, and a failure here fails the acquisition - which the routes already
 * report as 503, the honest answer for a database that cannot be configured.
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

export function postgresPool(connectionString: string): Pool {
  const existing = pools.get(connectionString);
  if (existing !== undefined) {
    return existing;
  }

  /**
   * Every timeout here exists to convert an invisible hang into the 503 the routes
   * already handle. Without them a database that is *down* refuses in milliseconds and
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
    // Neither adapter opens an explicit transaction. The setting is for the day
    // something does, so a half-finished one cannot keep a connection out of the pool
    // for good.
    idle_in_transaction_session_timeout: 10_000,
    onConnect: pinSession,
  };

  const pool = new Pool(config);

  // A pool emits 'error' for a client that fails while idle - a server restart, a proxy
  // closing the connection, a failover. Without a listener that is an unhandled 'error'
  // event, and node ends the process for it: the whole app dies because one idle socket
  // was dropped. The pool itself discards the client and carries on.
  pool.on("error", (cause) => {
    console.error("postgres pool error", cause);
  });

  pools.set(connectionString, pool);
  return pool;
}

/**
 * SQLSTATE classes that only the bound values can cause.
 *
 * Class 22 is "data exception": a NUL in a text parameter (22021), a timestamp out of
 * range (22008), a malformed datetime literal (22007). 23514 is a check violation - the
 * lengths and the value lists the migrations spell out. Each is permanent for that
 * payload, so calling it an outage means a caller retrying an unchanged request against
 * a wall forever.
 *
 * Deliberately narrow, because the cost of being wrong is asymmetric. 23505 is NOT
 * here: a unique violation means two writers collided, which each adapter has to answer
 * in its own way - the inbox reads back the row that won, the lifecycle log reports a
 * stale caller. Neither is 42P01 (missing table), 53300 (too many connections) or any
 * connection failure - those are outages, and 503 is honest.
 */
export function isPostgresPayloadFault(cause: unknown): boolean {
  const code = postgresErrorCode(cause);
  if (code === null) {
    return false;
  }
  return code.startsWith("22") || code === "23514";
}

/** The driver's SQLSTATE, or null for anything that is not a PostgreSQL error. */
export function postgresErrorCode(cause: unknown): string | null {
  const code = (cause as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && code.length === 5 ? code : null;
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
export async function closePostgresPools(): Promise<void> {
  const open = [...pools.values()];
  pools.clear();
  await Promise.all(open.map((pool) => pool.end()));
}
