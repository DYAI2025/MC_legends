import type { Pool, QueryResult, QueryResultRow } from "pg";
import type { SubmissionKind } from "@/domain/submissions/submission";
import type { ReplyAuthor, ReplyStatus, SubmissionReply } from "@/domain/replies/reply";
import { isReplyQuestionId } from "@/domain/replies/reply";
import {
  ReplyTargetError,
  type SubmissionReplyLog,
} from "@/application/replies/submission-reply-log";
import {
  MAX_ORIGINAL_EXCERPT_LENGTH,
  MAX_REPLY_PAGE_SIZE,
  type HouseholdReplyQuery,
  type ReplyView,
  type SubmissionReplyReader,
} from "@/application/replies/submission-reply-reader";
import { postgresErrorCode, postgresPool } from "@/adapters/persistence/postgres-pool";

/**
 * The durable reply log (MCL-74).
 *
 * Shares the pool with the other PostgreSQL adapters - same server, same credentials -
 * and leans on the schema for the invariants that must survive a second writer: the
 * foreign key for "a reply answers something that exists", and the CHECKs for shape.
 *
 * The join to `submission_inbox` happens in SQL rather than in two round trips, because
 * the household view is the polled one: a card list of twenty replies would otherwise be
 * twenty-one queries every sixty seconds for every open tablet.
 */

const FOREIGN_KEY_VIOLATION = "23503";

const APPEND = `
  INSERT INTO submission_reply (
    reply_id, submission_id, understood, question, question_id, author, status, created_at
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
`;

/**
 * The newest ready reply per submission, joined to just enough of the original.
 *
 * `DISTINCT ON` with the same leading expression as the ORDER BY is what makes "newest
 * per submission" one index scan. The `reply_id` tiebreak is not decoration: two replies
 * can share a `created_at` to the microsecond, and without it PostgreSQL would be free to
 * pick either - which would make this adapter and the file one disagree about which reply
 * a child sees.
 *
 * `left(original_text, $1)` cuts in the database so the bytes never cross the socket. The
 * length is passed in rather than written here so one constant governs both adapters.
 */
const HOUSEHOLD = `
  SELECT DISTINCT ON (r.submission_id)
         r.reply_id, r.submission_id, r.understood, r.question, r.question_id,
         r.author, r.status, r.created_at,
         i.kind, i.question_id AS submission_question_id, i.created_at AS submission_created_at,
         left(i.original_text, $1) AS original_text_excerpt
    FROM submission_reply r
    JOIN submission_inbox i ON i.submission_id = r.submission_id
   WHERE r.status = 'ready'
     AND ($2::timestamptz IS NULL OR r.created_at > $2::timestamptz)
   ORDER BY r.submission_id, r.created_at DESC, r.reply_id DESC
`;

/**
 * Ordering the DISTINCT ON result again, because a DISTINCT ON must be ordered by its own
 * key first and that is not the order a child reads in.
 */
const HOUSEHOLD_PAGE = `
  SELECT * FROM (${HOUSEHOLD}) AS latest
   ORDER BY latest.created_at DESC, latest.reply_id DESC
   LIMIT $3
`;

const FOR_SUBMISSION = `
  SELECT reply_id, submission_id, understood, question, question_id, author, status, created_at
    FROM submission_reply
   WHERE submission_id = $1
   ORDER BY created_at ASC, reply_id ASC
`;

type ReplyRow = {
  reply_id: string;
  submission_id: string;
  understood: string;
  question: string;
  question_id: string;
  author: string;
  status: string;
  created_at: Date;
};

type HouseholdRow = ReplyRow & {
  kind: string;
  submission_question_id: string;
  submission_created_at: Date;
  original_text_excerpt: string | null;
};

async function run<Row extends QueryResultRow>(
  pool: Pool,
  text: string,
  values: unknown[],
): Promise<QueryResult<Row>> {
  return pool.query<Row>(text, values);
}

/**
 * A row turned into a reply, checked rather than cast.
 *
 * The CHECK constraints already refuse anything else, so this cannot normally fail - but
 * "normally" excludes a restore, a manual fix in psql, and a future migration that adds
 * an author this build has never heard of. A row this adapter cannot read stops the read
 * rather than becoming a card in front of a child.
 */
function toReply(row: ReplyRow): SubmissionReply {
  if (row.author !== "human" && row.author !== "llm") {
    throw new Error(`submission_reply ${row.reply_id} has an unknown author`);
  }
  if (row.status !== "ready" && row.status !== "fallback") {
    throw new Error(`submission_reply ${row.reply_id} has an unknown status`);
  }
  if (!isReplyQuestionId(row.question_id)) {
    throw new Error(`submission_reply ${row.reply_id} has a question id that is not a reply id`);
  }

  return {
    replyId: row.reply_id,
    submissionId: row.submission_id,
    understood: row.understood,
    question: row.question,
    questionId: row.question_id,
    author: row.author satisfies ReplyAuthor,
    status: row.status satisfies ReplyStatus,
    createdAt: row.created_at.toISOString(),
  };
}

function toKind(value: string, replyId: string): SubmissionKind {
  if (value !== "text" && value !== "audio") {
    throw new Error(`submission_reply ${replyId} answers a submission of an unknown kind`);
  }
  return value;
}

export class PostgresSubmissionReplyLog implements SubmissionReplyLog, SubmissionReplyReader {
  constructor(private readonly connectionString: string) {}

  async append(reply: SubmissionReply): Promise<void> {
    const pool = postgresPool(this.connectionString);

    try {
      await run(pool, APPEND, [
        reply.replyId,
        reply.submissionId,
        reply.understood,
        reply.question,
        reply.questionId,
        reply.author,
        reply.status,
        reply.createdAt,
      ]);
    } catch (cause) {
      if (postgresErrorCode(cause) === FOREIGN_KEY_VIOLATION) {
        // The submission is not in the inbox. A typed error rather than a generic throw:
        // the route answers 404 for this and 503 for everything else, and inviting a
        // retry of something that can never succeed is the failure that distinction
        // exists to prevent.
        throw new ReplyTargetError(reply.submissionId, { cause });
      }
      throw cause;
    }
  }

  async latestForHousehold(query: HouseholdReplyQuery): Promise<readonly ReplyView[]> {
    const pool = postgresPool(this.connectionString);
    // Clamped in the adapter, never trusted from the caller: the page size is a memory
    // question, and the answer must not depend on which route asked.
    const limit = Math.max(Math.min(query.limit ?? MAX_REPLY_PAGE_SIZE, MAX_REPLY_PAGE_SIZE), 0);

    const found = await run<HouseholdRow>(pool, HOUSEHOLD_PAGE, [
      MAX_ORIGINAL_EXCERPT_LENGTH,
      query.since ?? null,
      limit,
    ]);

    return found.rows.map((row) => ({
      reply: toReply(row),
      submission: {
        submissionId: row.submission_id,
        kind: toKind(row.kind, row.reply_id),
        questionId: row.submission_question_id,
        createdAt: row.submission_created_at.toISOString(),
        // An audio row has no original_text at all, so the database already returns null
        // here. Nothing is substituted for it: a recording's original is the recording.
        originalTextExcerpt: row.original_text_excerpt,
      },
    }));
  }

  async listForSubmission(submissionId: string): Promise<readonly SubmissionReply[]> {
    const pool = postgresPool(this.connectionString);
    const found = await run<ReplyRow>(pool, FOR_SUBMISSION, [submissionId]);
    return found.rows.map(toReply);
  }
}
