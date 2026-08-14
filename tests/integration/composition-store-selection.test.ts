import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The wiring slice of MCL-48: the adapter existed for two commits without anything in
 * the running app ever constructing it. These two cases are what make the choice
 * observable - which store the composition root hands the route, and that removing
 * DATABASE_URL really does hand back the file store.
 *
 * That second case is the rollback path, not a curiosity: one line out of app.env and a
 * restart, with the bind-mounted JSONL still in place, no code revert and no redeploy.
 *
 * Gated on MCL_TEST_DATABASE_URL like the other integration suites, and given a real
 * connection string so the Postgres branch is selected with a string that would in fact
 * connect - not a placeholder that only happens to be non-empty.
 */
const CONNECTION_STRING = process.env.MCL_TEST_DATABASE_URL?.trim() ?? "";
const ENABLED = CONNECTION_STRING.length > 0;

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe.skipIf(!ENABLED)("createSubmissionInboxStore", () => {
  it("builds the PostgreSQL store when DATABASE_URL is set", async () => {
    vi.stubEnv("DATABASE_URL", CONNECTION_STRING);

    const { createSubmissionInboxStore } = await import("@/composition/server");
    const { PostgresSubmissionInboxStore } = await import(
      "@/adapters/persistence/postgres-submission-inbox-store"
    );

    // Constructed only - no pool is opened until the first append, so this case leaves
    // no connection behind.
    expect(createSubmissionInboxStore()).toBeInstanceOf(PostgresSubmissionInboxStore);
  });

  it("falls back to the file store when DATABASE_URL is not set", async () => {
    vi.stubEnv("DATABASE_URL", undefined);

    const { createSubmissionInboxStore } = await import("@/composition/server");
    const { FileSubmissionInboxStore } = await import(
      "@/adapters/persistence/file-submission-inbox-store"
    );

    expect(createSubmissionInboxStore()).toBeInstanceOf(FileSubmissionInboxStore);
  });

  it("falls back to the file store when DATABASE_URL is defined but blank", async () => {
    // A host that defines the variable and leaves it empty must not count as
    // configured - the same reason AVALORIA_INBOX_DIR uses `||` and not `??`. With
    // `??` this hands the Postgres adapter an empty connection string, and every
    // submission 503s while the app and /api/health both still look fine.
    vi.stubEnv("DATABASE_URL", "   ");

    const { createSubmissionInboxStore } = await import("@/composition/server");
    const { FileSubmissionInboxStore } = await import(
      "@/adapters/persistence/file-submission-inbox-store"
    );

    expect(createSubmissionInboxStore()).toBeInstanceOf(FileSubmissionInboxStore);
  });
});
