import type {
  InboxPage,
  SubmissionInboxReader,
} from "@/application/submissions/submission-inbox-reader";
import type {
  AppendOutcome,
  SubmissionInboxStore,
} from "@/application/submissions/submission-inbox-store";

/**
 * MCL-63. The persistence adapters, as the Cloudflare Worker build sees them.
 *
 * `next.config.ts` resolves BOTH `@/adapters/persistence/postgres-submission-inbox-store`
 * and `@/adapters/persistence/file-submission-inbox-store` to this module when
 * MCL_CLOUDFLARE_BUILD=1. Nothing else in the repository imports it, and the normal
 * Node/VPS build never sees it.
 *
 * It exists for two reasons, and both matter:
 *
 * 1. It is what actually fixes the build. `pg` reaches the Worker bundle only because
 *    `src/composition/server.ts` imports the PostgreSQL adapter; `pg/lib/stream.js`
 *    then requires `pg-cloudflare`, whose `workerd` export condition points at a
 *    `dist/index.js` that Next's tracer never copies. Taking the adapter out of the
 *    module graph takes `pg` and `pg-cloudflare` with it. Marking `pg-cloudflare`
 *    external, or copying that file in by hand, would instead leave a TCP PostgreSQL
 *    client inside the Worker - which MCL-48 forbids.
 *
 * 2. It fails closed. If a request ever did reach the local API handlers inside the
 *    Worker - despite cloudflare/worker.ts intercepting /api/* first - the composition
 *    root would otherwise quietly pick FileSubmissionInboxStore and write a child's
 *    answer to a Worker-local filesystem that does not survive the request. The route
 *    would then answer `{acknowledged: true}` with a receipt for something nobody
 *    kept. The constructor throws instead, the route's existing try/catch turns that
 *    into 503 `inbox-unavailable`, and the child is told to try again - which is true.
 *
 * Both class names are exported because the composition root imports both by name; the
 * alias replaces the module, not the identifier.
 */
const UNAVAILABLE =
  "MCL63_PERSISTENCE_UNAVAILABLE: submission persistence is not reachable from this runtime";

class UnavailableSubmissionInbox implements SubmissionInboxStore, SubmissionInboxReader {
  /**
   * Throws on construction, not on first use. The composition root builds a store per
   * request and the route builds it inside the try block that already answers 503, so
   * throwing here is the earliest point at which the failure is both certain and
   * correctly reported. A method that only threw when called would let a caller hold a
   * store it believes in.
   */
  constructor() {
    throw new Error(UNAVAILABLE);
  }

  appendIfAbsent(): Promise<AppendOutcome> {
    throw new Error(UNAVAILABLE);
  }

  list(): Promise<InboxPage> {
    throw new Error(UNAVAILABLE);
  }
}

export class PostgresSubmissionInboxStore extends UnavailableSubmissionInbox {}

export class FileSubmissionInboxStore extends UnavailableSubmissionInbox {}

/** Exported so a test can assert the marker without duplicating the literal. */
export const PERSISTENCE_UNAVAILABLE_MESSAGE = UNAVAILABLE;
