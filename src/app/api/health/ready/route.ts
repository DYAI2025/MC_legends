import { Client } from "pg";
import { databaseUrl } from "@/composition/server";

/**
 * The complete vocabulary of this endpoint's `database` field.
 *
 * A closed union rather than a string, because the response body is the whole contract:
 * an operator, a load balancer and a deploy script all branch on these three words, and
 * nothing else may ever appear beside them.
 */
type DatabaseState = "ok" | "unavailable" | "not-configured";

/**
 * Probes with a short-lived client rather than the adapter's pool.
 *
 * A pooled connection answers "a connection opened at some point and has not been
 * noticed to fail since", which is not the question. Readiness has to exercise the real
 * connection path now - the socket, the role, the pg_hba line - because those are
 * exactly what breaks between a working local run and a deployed container.
 *
 * Both timeouts are load-bearing. Without connectionTimeoutMillis a black-holed packet
 * leaves the probe hanging with no answer at all, which is worse than 503: the caller
 * cannot tell a slow database from a wedged app. query_timeout covers the other half,
 * a server that accepts the connection and then never answers.
 */
async function probeDatabase(connectionString: string): Promise<DatabaseState> {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 2_000,
    query_timeout: 2_000,
  });

  try {
    await client.connect();
    await client.query("SELECT 1");
    return "ok";
  } catch (cause) {
    // Server-side only, and deliberately the whole cause: an operator needs the driver's
    // message to fix this. It must never reach the response - the driver names the host,
    // and a connection string in an error would publish the password on a URL that
    // requires no authentication to read.
    console.error("readiness probe failed", cause);
    return "unavailable";
  } finally {
    // Including on the failure path. A client whose connect() timed out still owns a
    // socket, and a probe called once a second by a health checker would otherwise leak
    // one per call until the process runs out of descriptors.
    await client.end().catch((cause: unknown) => {
      console.error("readiness probe could not close its client", cause);
    });
  }
}

/**
 * Readiness, deliberately a second endpoint rather than a change to /api/health.
 *
 * /api/health answers "is this process serving?" and must keep answering that when the
 * database is down. If it reported the database too, a DB outage would look identical
 * to a crashed app and an operator would learn nothing from either. MCL-48 requires the
 * application and PostgreSQL to be checkable separately; this is that second check.
 *
 * `not-configured` is 200 on purpose. No DATABASE_URL means the file store, which is a
 * legitimate configuration - it is the rollback path - and calling it a fault would page
 * somebody about an app that is working exactly as deployed.
 *
 * The body is public: this route is unauthenticated, and nothing here is derived from
 * the connection string.
 */
export async function GET(): Promise<Response> {
  const url = databaseUrl();
  const database: DatabaseState = url === null ? "not-configured" : await probeDatabase(url);

  return Response.json(
    { app: "ok", database },
    { status: database === "unavailable" ? 503 : 200 },
  );
}

/**
 * Never prerendered. A readiness answer baked at build time is not a readiness answer -
 * it would report the state of a database that was reachable on a build machine, which
 * is the one thing this endpoint exists to avoid asserting.
 */
export const dynamic = "force-dynamic";
