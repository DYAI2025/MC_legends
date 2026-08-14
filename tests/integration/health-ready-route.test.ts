import { afterEach, describe, expect, it, vi } from "vitest";

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

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe.skipIf(!ENABLED)("GET /api/health/ready against a real PostgreSQL", () => {
  it("reports the database ok when the configured server answers", async () => {
    vi.stubEnv("DATABASE_URL", CONNECTION_STRING);
    const { GET } = await import("@/app/api/health/ready/route");

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ app: "ok", database: "ok" });
  });
});
