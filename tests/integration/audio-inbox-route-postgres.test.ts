import { readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closePostgresSubmissionInboxPools } from "@/adapters/persistence/postgres-submission-inbox-store";
import { TEST_FAMILY_ACCESS_CODE } from "../support/family-access-code";
import { familySessionCookieHeader } from "../support/family-session-header";
import { WEBM } from "../support/audio-fixtures";
import {
  lockSubmissionInboxTable,
  unlockSubmissionInboxTable,
} from "../support/submission-inbox-table-lock";

/**
 * The audio upload route with PostgreSQL actually selected (MCL-49 finding F1).
 *
 * The unit suite proves the size ceiling against the file adapters. It cannot prove this,
 * because the failure F1 describes is specific to the durable mode: the route writes the
 * recording to the blob store FIRST and only then attempts the row, and it deliberately
 * never deletes those bytes when the row fails - a row pointing at a recording that was
 * never written is unrecoverable, so the ordering is right and the deletion would be
 * wrong. That ordering is exactly what makes an over-wide AVALORIA_AUDIO_MAX_BYTES
 * expensive here rather than merely wrong: measured on a135e2b, every upload between the
 * configured value and the CHECK constraint's 8388608 left an orphan recording on disk and
 * answered the child with a failure.
 *
 * So what this file establishes is that with a real database selected, an oversized upload
 * is refused by the application before either store is touched: no blob on disk, and the
 * row count in `submission_inbox` unchanged.
 *
 * Skipped rather than failed without MCL_TEST_DATABASE_URL, so `npm run test` still runs on
 * a machine with no database. That is a real gap while it lasts, which is why
 * `npm run check:integration-ran` exists and why the CI slice sets the variable.
 */
const CONNECTION_STRING = process.env.MCL_TEST_DATABASE_URL?.trim() ?? "";
const ENABLED = CONNECTION_STRING.length > 0;

/** 8 MiB, the product maximum. Written out so this file fails if the route's drifts. */
const MAX_AUDIO_BYTES = 8_388_608;

const ENDPOINT = "http://localhost/api/inbox/submissions/audio";

let mediaDirectory = "";
let inboxDirectory = "";
let sessionCookie = "";

/**
 * Reads the table directly, so what a case asserts about stored rows does not come from
 * the code under test. Built on first use, never at collection time: a skipped file must
 * not open a connection.
 */
let reader: Client | null = null;

async function inspect(): Promise<Client> {
  reader ??= await (async () => {
    const client = new Client({ connectionString: CONNECTION_STRING });
    await client.connect();
    return client;
  })();

  return reader;
}

async function rowCount(): Promise<number> {
  const result = await (
    await inspect()
  ).query<{ count: string }>("SELECT count(*) FROM submission_inbox");
  return Number(result.rows[0].count);
}

async function emptyTable(): Promise<void> {
  await (await inspect()).query("TRUNCATE submission_inbox");
}

async function mediaFiles(): Promise<string[]> {
  return (await readdir(mediaDirectory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

beforeAll(async () => {
  if (!ENABLED) return;
  // Third file to own this table. Without the lock it TRUNCATEs the other two mid-test.
  await lockSubmissionInboxTable(CONNECTION_STRING);
});

afterAll(async () => {
  await reader?.end();
  reader = null;
  await unlockSubmissionInboxTable();
  // Or the worker holds a socket open and vitest never exits.
  await closePostgresSubmissionInboxPools();
});

beforeEach(async () => {
  if (!ENABLED) return;

  // A known starting point, like the other two files that own this table. Without it the
  // second case's submissionId survives from the previous run and the route answers the
  // idempotent-retry 200 instead of the 201 this case is about - which is a green
  // assertion about the wrong path.
  await emptyTable();

  mediaDirectory = await mkdtemp(join(tmpdir(), "mcl-audio-pg-media-"));
  inboxDirectory = await mkdtemp(join(tmpdir(), "mcl-audio-pg-inbox-"));

  vi.stubEnv("DATABASE_URL", CONNECTION_STRING);
  vi.stubEnv("AVALORIA_MEDIA_DIR", mediaDirectory);
  // Set, and deliberately empty of any file this case could reach: if the composition root
  // ever stopped selecting PostgreSQL, the file store would write here and the row-count
  // assertion below would pass for the wrong reason. An empty directory at the end is the
  // second half of that proof.
  vi.stubEnv("AVALORIA_INBOX_DIR", inboxDirectory);
  vi.stubEnv("AVALORIA_FAMILY_ACCESS_CODE", TEST_FAMILY_ACCESS_CODE);
  vi.stubEnv("AVALORIA_SESSION_SECRET", undefined);
  sessionCookie = familySessionCookieHeader(TEST_FAMILY_ACCESS_CODE);
});

afterEach(async () => {
  vi.resetModules();
  vi.unstubAllEnvs();
  await rm(mediaDirectory, { recursive: true, force: true });
  await rm(inboxDirectory, { recursive: true, force: true });
});

describe.skipIf(!ENABLED)("POST /api/inbox/submissions/audio against a real PostgreSQL", () => {
  it("refuses a recording above the product maximum before writing a blob or a row", async () => {
    vi.stubEnv("AVALORIA_AUDIO_MAX_BYTES", "33554432");

    const { POST } = await import("@/app/api/inbox/submissions/audio/route");
    const { resetRateLimitersForTest } = await import("@/composition/server");
    resetRateLimitersForTest();

    const before = await rowCount();

    const overCap: Uint8Array<ArrayBuffer> = new Uint8Array(MAX_AUDIO_BYTES + 1).fill(0x11);
    overCap.set(WEBM.slice(0, 9), 0);

    const response = await POST(
      new Request(ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "audio/webm",
          "content-length": String(overCap.byteLength),
          cookie: sessionCookie,
          "x-avaloria-submission-id": "sub-pg-over-max",
          "x-avaloria-question-id": "companion-animal",
          "x-avaloria-created-at": "2026-08-21T09:00:00.000Z",
        },
        body: overCap,
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      acknowledged: false,
      error: "invalid-payload",
    });

    // The two things the CHECK constraint could not have given us. The row count is
    // unchanged because the application refused, not because the database did - and the
    // media directory is empty because the refusal came before the write that is never
    // undone.
    expect(await rowCount()).toBe(before);
    expect(await mediaFiles()).toEqual([]);
    expect(await readdir(inboxDirectory)).toEqual([]);
  });

  it("still accepts a recording of exactly the product maximum", async () => {
    // The other half of the same boundary, in the mode that matters most. A clamp that
    // was off by one here would refuse the largest legitimate recording, and the child
    // could not tell that refusal from a genuinely oversized one.
    vi.stubEnv("AVALORIA_AUDIO_MAX_BYTES", undefined);

    const { POST } = await import("@/app/api/inbox/submissions/audio/route");
    const { resetRateLimitersForTest } = await import("@/composition/server");
    resetRateLimitersForTest();

    const before = await rowCount();

    const atCap: Uint8Array<ArrayBuffer> = new Uint8Array(MAX_AUDIO_BYTES).fill(0x11);
    atCap.set(WEBM.slice(0, 9), 0);

    const response = await POST(
      new Request(ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "audio/webm",
          "content-length": String(atCap.byteLength),
          cookie: sessionCookie,
          "x-avaloria-submission-id": "sub-pg-at-max",
          "x-avaloria-question-id": "companion-animal",
          "x-avaloria-created-at": "2026-08-21T09:00:00.000Z",
        },
        body: atCap,
      }),
    );

    expect(response.status).toBe(201);
    expect(await rowCount()).toBe(before + 1);
    expect(await mediaFiles()).toHaveLength(1);
  });
});
