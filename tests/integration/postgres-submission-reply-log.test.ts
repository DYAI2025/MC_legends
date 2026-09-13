import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresSubmissionReplyLog } from "@/adapters/persistence/postgres-submission-reply-log";
import { PostgresSubmissionInboxStore } from "@/adapters/persistence/postgres-submission-inbox-store";
import { ReplyTargetError } from "@/application/replies/submission-reply-log";
import {
  describeSubmissionReplyLogContract,
  replyInboxSeed,
  type ReplyLogUnderTest,
} from "../unit/submission-reply-log-contract";
import {
  lockSubmissionInboxTable,
  unlockSubmissionInboxTable,
} from "../support/submission-inbox-table-lock";

/**
 * MCL-74. A real PostgreSQL is the whole point of this file.
 *
 * Three properties here belong to the server and cannot be proven anywhere else: the
 * foreign key refusing a reply to a submission that does not exist, `DISTINCT ON`
 * returning the newest reply per submission rather than an arbitrary one, and
 * `left(original_text, 120)` cutting exactly where the file adapter's `slice` does.
 * A mocked pool would only prove this adapter calls pg, which nobody doubts.
 *
 * Skipped rather than failed when MCL_TEST_DATABASE_URL is unset, so `npm run test` on a
 * machine without a database still runs. In CI the variable IS set, and
 * `check:integration-ran` fails on a skipped suite - so a skip there is a red gate, not
 * a quiet pass.
 */
const CONNECTION_STRING = process.env.MCL_TEST_DATABASE_URL?.trim() ?? "";
const ENABLED = CONNECTION_STRING.length > 0;

let inspector: Pool | null = null;

function inspect(): Pool {
  if (inspector === null) {
    inspector = new Pool({ connectionString: CONNECTION_STRING });
    inspector.on("error", (cause) => {
      console.error("inspector pool error", cause);
    });
  }
  return inspector;
}

/**
 * Replies first, then the inbox: the foreign key decides the order, and getting it
 * backwards is exactly the mistake the restore runbook warns about.
 */
async function emptyTables(): Promise<void> {
  await inspect().query("TRUNCATE submission_reply, submission_inbox");
}

async function createLog(): Promise<ReplyLogUnderTest> {
  await emptyTables();
  const store = new PostgresSubmissionInboxStore(CONNECTION_STRING);
  for (const record of replyInboxSeed()) {
    await store.appendIfAbsent(record);
  }
  return new PostgresSubmissionReplyLog(CONNECTION_STRING);
}

// Shares `submission_inbox` with the other integration files that TRUNCATE it.
beforeAll(async () => {
  if (ENABLED) await lockSubmissionInboxTable(CONNECTION_STRING);
});

afterAll(async () => {
  if (inspector !== null) {
    await emptyTables();
    await inspector.end();
    inspector = null;
  }
  if (ENABLED) await unlockSubmissionInboxTable();
});

describe.skipIf(!ENABLED)("postgres reply log", () => {
  describeSubmissionReplyLogContract("postgres", createLog);

  it("stores the question id rather than leaving it to be derived", async () => {
    const log = await createLog();
    await log.append({
      replyId: "r-1",
      submissionId: "sub-alpha",
      understood: "Du magst den Wolf.",
      question: "Wie soll er heißen?",
      questionId: "reply:sub-alpha",
      author: "human",
      status: "ready",
      createdAt: "2026-09-12T18:00:00.000Z",
    });

    const found = await inspect().query<{ question_id: string }>(
      "SELECT question_id FROM submission_reply WHERE reply_id = $1",
      ["r-1"],
    );
    expect(found.rows[0]?.question_id).toBe("reply:sub-alpha");
  });

  it("lets the database refuse a reply whose question id names another submission", async () => {
    // The adapter would never build one; a restore or a manual fix could. The CHECK is
    // what stops a reply being filed under a chain it does not belong to.
    await createLog();
    await expect(
      inspect().query(
        `INSERT INTO submission_reply
           (reply_id, submission_id, understood, question, question_id, author, status, created_at)
         VALUES ('r-x', 'sub-alpha', 'Text', 'Frage?', 'reply:sub-beta', 'human', 'ready', now())`,
      ),
    ).rejects.toThrow(/submission_reply_question_id/u);
  });

  it("lets the database refuse a question that asks nothing", async () => {
    await createLog();
    await expect(
      inspect().query(
        `INSERT INTO submission_reply
           (reply_id, submission_id, understood, question, question_id, author, status, created_at)
         VALUES ('r-y', 'sub-alpha', 'Text', 'Keine Frage.', 'reply:sub-alpha', 'human', 'ready', now())`,
      ),
    ).rejects.toThrow(/submission_reply_question_shape/u);
  });

  it("reports a missing submission as a target error and not as an outage", async () => {
    const log = await createLog();
    await expect(
      log.append({
        replyId: "r-2",
        submissionId: "sub-nope",
        understood: "Text",
        question: "Frage?",
        questionId: "reply:sub-nope",
        author: "human",
        status: "ready",
        createdAt: "2026-09-12T18:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(ReplyTargetError);
  });

  it("picks the same reply as the file store when two share a timestamp", async () => {
    // Without the reply_id tiebreak in the ORDER BY, PostgreSQL is free to return either
    // row and the two adapters would disagree about which reply a child sees.
    const log = await createLog();
    const base = {
      submissionId: "sub-alpha",
      understood: "Du magst den Wolf.",
      questionId: "reply:sub-alpha" as const,
      author: "human" as const,
      status: "ready" as const,
      createdAt: "2026-09-12T18:00:00.000Z",
    };
    await log.append({ ...base, replyId: "r-aaa", question: "Frage A?" });
    await log.append({ ...base, replyId: "r-bbb", question: "Frage B?" });

    const views = await log.latestForHousehold({});
    expect(views.map((view) => view.reply.replyId)).toEqual(["r-bbb"]);
  });
});
