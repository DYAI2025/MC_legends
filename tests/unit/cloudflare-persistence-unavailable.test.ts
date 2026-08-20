/**
 * MCL-63. Pins the second fail-closed guarantee.
 *
 * `next.config.ts` resolves the two persistence adapters and `pg` to these stubs when
 * MCL_CLOUDFLARE_BUILD=1. That is what removes `pg` - and with it the `pg-cloudflare`
 * resolution that broke the Worker build - from the Cloudflare module graph.
 *
 * The behaviour tested here is what happens if a request nevertheless reaches the local
 * persistence composition inside a Worker. Without these stubs the composition root
 * would pick FileSubmissionInboxStore whenever DATABASE_URL is unset, write a child's
 * answer to a filesystem that does not outlive the request, and answer
 * `{acknowledged: true}` with a receipt for something nobody kept. AGENTS.md forbids
 * exactly that: no arrival claim without a real, durable server acknowledgement.
 *
 * Note the deliberate asymmetry between the two files, and why each shape is the right
 * one for its caller:
 *  - the inbox stores throw in the CONSTRUCTOR, because the route builds the store
 *    inside the try block that already answers 503 `inbox-unavailable`;
 *  - the pg Client rejects on CONNECT, because the readiness route builds its client
 *    outside its try and would turn a constructor throw into an unhandled 500 instead
 *    of its own `{"database":"unavailable"}` 503.
 */
import { describe, expect, it } from "vitest";
import {
  FileSubmissionInboxStore,
  PERSISTENCE_UNAVAILABLE_MESSAGE,
  PostgresSubmissionInboxStore,
} from "../../cloudflare/persistence-unavailable";
import { Client, Pool } from "../../cloudflare/pg-unavailable";

/** The greppable marker scripts/check-cloudflare-bundle.mjs looks for in the bundle. */
const MARKER = "MCL63_PERSISTENCE_UNAVAILABLE";

describe("cloudflare persistence stubs", () => {
  it("refuses to construct the PostgreSQL store", () => {
    expect(() => new PostgresSubmissionInboxStore()).toThrow(MARKER);
  });

  it("refuses to construct the file store, so a Worker cannot fall back to local disk", () => {
    // The important one. The PostgreSQL adapter is unreachable from a Worker anyway;
    // the file store is the branch that would otherwise look like it worked.
    expect(() => new FileSubmissionInboxStore()).toThrow(MARKER);
  });

  it("carries the marker the bundle check greps for", () => {
    expect(PERSISTENCE_UNAVAILABLE_MESSAGE).toContain(MARKER);
  });

  it("names no secret and no child-facing text", () => {
    expect(PERSISTENCE_UNAVAILABLE_MESSAGE).not.toMatch(/AVALORIA_|postgres(ql)?:\/\//i);
  });
});

describe("cloudflare pg stub", () => {
  it("rejects on connect rather than on construction", async () => {
    const client = new Client();
    await expect(client.connect()).rejects.toThrow(MARKER);
  });

  it("resolves end(), which the readiness route calls in a finally block", async () => {
    await expect(new Client().end()).resolves.toBeUndefined();
  });

  it("refuses pool use as well", async () => {
    await expect(new Pool().connect()).rejects.toThrow(MARKER);
    await expect(new Pool().query()).rejects.toThrow(MARKER);
  });
});
