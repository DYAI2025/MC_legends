/**
 * MCL-63. `pg`, as the Cloudflare Worker build sees it.
 *
 * `src/app/api/health/ready/route.ts` imports `Client` from `pg` directly - it probes
 * the database with a short-lived client rather than the adapter's pool - so aliasing
 * the persistence adapters alone still left `pg` in the Cloudflare module graph, and
 * with it the `pg-cloudflare` resolution that fails the Worker bundle. Measured
 * 2026-08-20: with only the adapter alias in place the build still failed at
 * `.open-next/server-functions/default/node_modules/pg/lib/stream.js:41`, and the sole
 * remaining trace root was that route.
 *
 * `next.config.ts` resolves `pg` to this module when MCL_CLOUDFLARE_BUILD=1. The normal
 * Node/VPS build never sees it and keeps the real driver.
 *
 * Why `connect()` rejects instead of the constructor throwing: `probeDatabase` builds
 * its client *outside* its try/catch and awaits `connect()` inside it. A constructor
 * throw would escape as an unhandled 500; a rejected connect is caught, logged and
 * reported as `{"app":"ok","database":"unavailable"}` with status 503 - which is the
 * honest answer for a runtime that cannot reach the database, and is exactly what the
 * route already does for a real outage. Fail closed, and in the shape the caller
 * already understands.
 *
 * Only the surface `src` actually uses is implemented. Widening `src`'s use of `pg`
 * without widening this file is a build failure in the Cloudflare gate, not a silent
 * runtime hole.
 */
const UNAVAILABLE =
  "MCL63_PERSISTENCE_UNAVAILABLE: PostgreSQL is not reachable from this runtime";

export class Client {
  async connect(): Promise<void> {
    throw new Error(UNAVAILABLE);
  }

  async query(): Promise<never> {
    throw new Error(UNAVAILABLE);
  }

  /** Resolves: the route calls this in a finally block and must not fail there. */
  async end(): Promise<void> {}
}

export class Pool {
  async connect(): Promise<never> {
    throw new Error(UNAVAILABLE);
  }

  async query(): Promise<never> {
    throw new Error(UNAVAILABLE);
  }

  async end(): Promise<void> {}

  on(): this {
    return this;
  }
}

const pgUnavailable = { Client, Pool };

export default pgUnavailable;
