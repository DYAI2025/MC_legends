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

/**
 * The same wiring question for the MCL-35 lifecycle store. Both factories, not just one:
 * the write side and the read side have to land on the SAME store, because an adult
 * closing a question in one and a child reading the rotation from the other is the
 * failure this pair of cases exists to catch - and it would look like a question that
 * refuses to go away rather than like a configuration mistake.
 */
describe.skipIf(!ENABLED)("createQuestionLifecycleLog / createQuestionLifecycleReader", () => {
  it("builds the PostgreSQL log when DATABASE_URL is set", async () => {
    vi.stubEnv("DATABASE_URL", CONNECTION_STRING);

    const { createQuestionLifecycleLog, createQuestionLifecycleReader } = await import(
      "@/composition/server"
    );
    const { PostgresQuestionLifecycleLog } = await import(
      "@/adapters/persistence/postgres-question-lifecycle-log"
    );

    // Constructed only - no pool is opened until the first query, so this case leaves no
    // connection behind.
    expect(createQuestionLifecycleLog()).toBeInstanceOf(PostgresQuestionLifecycleLog);
    expect(createQuestionLifecycleReader()).toBeInstanceOf(PostgresQuestionLifecycleLog);
  });

  it("falls back to the file log when DATABASE_URL is not set", async () => {
    vi.stubEnv("DATABASE_URL", undefined);

    const { createQuestionLifecycleLog, createQuestionLifecycleReader } = await import(
      "@/composition/server"
    );
    const { FileQuestionLifecycleLog } = await import(
      "@/adapters/persistence/file-question-lifecycle-log"
    );

    expect(createQuestionLifecycleLog()).toBeInstanceOf(FileQuestionLifecycleLog);
    expect(createQuestionLifecycleReader()).toBeInstanceOf(FileQuestionLifecycleLog);
  });

  it("falls back to the file log when DATABASE_URL is defined but blank", async () => {
    // Same reason the inbox does: a host that defines the variable and leaves it empty
    // has not configured a database, and `??` would hand the adapter an empty connection
    // string while the site and /api/health both still looked fine.
    vi.stubEnv("DATABASE_URL", "   ");

    const { createQuestionLifecycleLog } = await import("@/composition/server");
    const { FileQuestionLifecycleLog } = await import(
      "@/adapters/persistence/file-question-lifecycle-log"
    );

    expect(createQuestionLifecycleLog()).toBeInstanceOf(FileQuestionLifecycleLog);
  });
});
