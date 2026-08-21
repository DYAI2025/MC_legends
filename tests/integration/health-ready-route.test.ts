import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The `database: "ok"` branch is the one branch a fake cannot prove. A mocked client
 * that resolves says only that this route calls pg; what readiness has to establish is
 * that the connection string in the environment actually opens a session on a real
 * server and answers a query - which is exactly the thing that breaks in production
 * when a socket path, a role or a pg_hba line is wrong.
 *
 * Skipped rather than failed without MCL_TEST_DATABASE_URL, so `npm run test` still
 * runs on a machine with no database. That is a real gap while it lasts.
 */
const CONNECTION_STRING = process.env.MCL_TEST_DATABASE_URL?.trim() ?? "";
const ENABLED = CONNECTION_STRING.length > 0;

let mediaDirectory = "";

beforeEach(async () => {
  // Its own directory, so this case never writes a probe file into the repository's
  // .data/media - and so `storage: "ok"` here means a real write really succeeded.
  mediaDirectory = await mkdtemp(join(tmpdir(), "mcl-ready-int-"));
  vi.stubEnv("AVALORIA_MEDIA_DIR", mediaDirectory);
});

afterEach(async () => {
  await rm(mediaDirectory, { recursive: true, force: true });
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe.skipIf(!ENABLED)("GET /api/health/ready against a real PostgreSQL", () => {
  it("reports the database ok when the configured server answers", async () => {
    vi.stubEnv("DATABASE_URL", CONNECTION_STRING);
    const { GET } = await import("@/app/api/health/ready/route");

    const response = await GET();

    expect(response.status).toBe(200);
    // All three reported apart. This is the shape the deploy runbook tells an operator to
    // expect from a healthy VPS, so the assertion is the whole body rather than one field.
    await expect(response.json()).resolves.toEqual({
      app: "ok",
      database: "ok",
      storage: "ok",
    });
  });
});
