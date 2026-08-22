import type { Pool, QueryResult, QueryResultRow } from "pg";
import {
  isPostgresPayloadFault,
  postgresErrorCode,
  postgresPool,
} from "@/adapters/persistence/postgres-pool";
import {
  actionProducingState,
  type QuestionLifecycleSnapshot,
  type QuestionState,
} from "@/domain/questions/question-lifecycle";
import {
  assertStorableLifecycleRequest,
  QuestionLifecyclePayloadError,
  type QuestionLifecycleEvent,
  type QuestionLifecycleLog,
  type QuestionLifecycleOutcome,
  type QuestionLifecycleReader,
  type QuestionLifecycleRequest,
} from "@/application/questions/question-lifecycle";

/**
 * Durable question lifecycle log (MCL-35).
 *
 * The whole concurrency story is one statement and one constraint, and it is worth
 * stating plainly because the obvious alternatives are all bigger:
 *
 * - The INSERT computes the new revision from the latest one it can see and writes only
 *   if the state it was given still matches what the table says. Two callers who both
 *   read the same latest revision compute the same new one, and
 *   `question_lifecycle_revision_unique` lets exactly one of them commit. The loser gets
 *   a 23505, which is reported as a stale caller - not as an outage, and never as a
 *   second event.
 * - So there is no explicit transaction to hold open, no advisory lock to remember, and
 *   no isolation level to raise. A lock would serialise the same outcome at a higher
 *   cost and would have to be taken by every future writer of this table to be worth
 *   anything; a unique index is taken by all of them whether they know about it or not.
 *
 * Nothing here updates or deletes a row. Reopening appends the second event next to the
 * first, which is what makes the archive an archive.
 */

type EventRow = {
  question_id: string;
  revision: number;
  action: string;
  previous_state: string;
  next_state: string;
  occurred_at: Date;
  sequence: string;
};

/** `sequence` is bigint, which node-postgres hands back as text so nothing is rounded. */
const EVENT_COLUMNS =
  "question_id, revision, action, previous_state, next_state, occurred_at, sequence::text AS sequence";

/**
 * Append-if-the-state-still-holds, as one statement.
 *
 * `$3` is the expected (and therefore the previous) state and appears twice on purpose:
 * once as the value written, once as the condition. Splitting them would let a caller
 * record a transition from a state the table never held.
 *
 * When the question has no events at all, `latest` is empty and the seeded state decides
 * - which is why `$6` exists rather than the adapter defaulting to "open": what the
 * dataset seeded is the content layer's business, and this module must not have an
 * opinion about it.
 */
const APPEND = `
  WITH latest AS (
    SELECT revision, next_state
      FROM question_lifecycle_event
     WHERE question_id = $1::text
     ORDER BY revision DESC
     LIMIT 1
  )
  INSERT INTO question_lifecycle_event (
    question_id, revision, action, previous_state, next_state, occurred_at
  )
  SELECT
    $1::text,
    coalesce((SELECT revision FROM latest), -1) + 1,
    $2::text,
    $3::text,
    $4::text,
    $5::timestamptz
  WHERE coalesce((SELECT next_state FROM latest), $6::text) = $3::text
  RETURNING ${EVENT_COLUMNS}
`;

const CURRENT_STATE = `
  SELECT next_state
    FROM question_lifecycle_event
   WHERE question_id = $1::text
   ORDER BY revision DESC
   LIMIT 1
`;

/**
 * The newest row per question.
 *
 * DISTINCT ON with a matching ORDER BY, which PostgreSQL answers from the
 * (question_id, revision) unique index rather than by sorting the whole table.
 */
const SNAPSHOT = `
  SELECT DISTINCT ON (question_id) question_id, next_state, sequence::text AS sequence
    FROM question_lifecycle_event
   ORDER BY question_id, revision DESC
`;

/**
 * Ordered by `sequence`, not by `occurred_at`.
 *
 * occurred_at is the application clock and two events can share a millisecond; sequence
 * is the database's own total order and cannot tie. A history whose order depends on a
 * clock is a history that reorders itself when a clock is wrong.
 */
const HISTORY = `SELECT ${EVENT_COLUMNS} FROM question_lifecycle_event ORDER BY sequence DESC`;

const HISTORY_FOR_QUESTION = `
  SELECT ${EVENT_COLUMNS}
    FROM question_lifecycle_event
   WHERE question_id = $1::text
   ORDER BY sequence DESC
`;

/** The SQLSTATE for a unique violation - here, two writers racing for one revision. */
const UNIQUE_VIOLATION = "23505";

/**
 * Every statement this adapter runs, with the payload faults separated from the outages,
 * exactly as the inbox adapter does it.
 *
 * 23505 is deliberately let through untranslated: on this table it is not a payload
 * problem and not an outage either, it is the collision that means somebody else got
 * there first, and only `append` knows what to do with it.
 */
async function run<Row extends QueryResultRow>(
  pool: Pool,
  text: string,
  values: unknown[],
): Promise<QueryResult<Row>> {
  try {
    return await pool.query<Row>(text, values);
  } catch (cause) {
    if (postgresErrorCode(cause) !== UNIQUE_VIOLATION && isPostgresPayloadFault(cause)) {
      // The driver's message names the constraint. Kept as `cause` for the server log
      // and left out of the thrown message, because the route logs what it catches.
      throw new QuestionLifecyclePayloadError(
        "question_lifecycle_event refused the submitted values",
        { cause },
      );
    }
    throw cause;
  }
}

function stateFrom(value: string): QuestionState {
  if (value === "open" || value === "closed") {
    return value;
  }

  // The CHECK constraints are what make the narrowing true. A value they allow and this
  // function does not know must fail on the row rather than reach a page as an untyped
  // string.
  throw new Error(`question_lifecycle_event holds a state this adapter cannot type: ${value}`);
}

function sequenceFrom(value: string, questionId: string): number {
  const sequence = Number(value);

  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new Error(
      `question_lifecycle_event row for ${questionId} holds a sequence this adapter cannot represent exactly`,
    );
  }

  return sequence;
}

function toEvent(row: EventRow): QuestionLifecycleEvent {
  const nextState = stateFrom(row.next_state);
  const action = actionProducingState(nextState);

  if (action !== row.action) {
    // `question_lifecycle_action_matches` forbids this. Reaching it means the constraint
    // is gone or the row was written by something that bypassed it, and an event whose
    // stated action disagrees with its own outcome is exactly what an archive must not
    // hand back without saying so.
    throw new Error(
      `question_lifecycle_event row for ${row.question_id} records ${row.action} but produced ${nextState}`,
    );
  }

  if (!(row.occurred_at instanceof Date) || Number.isNaN(row.occurred_at.getTime())) {
    throw new Error(
      "question_lifecycle_event.occurred_at did not come back as a timestamp - check the session DateStyle, which must be 'ISO, YMD'",
    );
  }

  return {
    questionId: row.question_id,
    action,
    previousState: stateFrom(row.previous_state),
    nextState,
    occurredAt: row.occurred_at.toISOString(),
    sequence: sequenceFrom(row.sequence, row.question_id),
    revision: row.revision,
  };
}

export class PostgresQuestionLifecycleLog
  implements QuestionLifecycleLog, QuestionLifecycleReader
{
  constructor(private readonly connectionString: string) {}

  async append(request: QuestionLifecycleRequest): Promise<QuestionLifecycleOutcome> {
    assertStorableLifecycleRequest(request);

    const pool = postgresPool(this.connectionString);

    let inserted: QueryResult<EventRow>;

    try {
      inserted = await run<EventRow>(pool, APPEND, [
        request.questionId,
        actionProducingState(request.nextState),
        request.expectedState,
        request.nextState,
        new Date().toISOString(),
        request.seededState,
      ]);
    } catch (cause) {
      if (postgresErrorCode(cause) !== UNIQUE_VIOLATION) {
        throw cause;
      }

      // Somebody else wrote this revision between the SELECT inside the statement and
      // the INSERT it fed. That is the concurrent case, and the answer is the same one a
      // caller working from an out-of-date board gets: nothing was written, and here is
      // the state that actually holds.
      return this.stale(pool, request);
    }

    const row = inserted.rows[0];

    if (row === undefined) {
      // The WHERE refused it: the state moved before this call arrived.
      return this.stale(pool, request);
    }

    return { applied: true, event: toEvent(row) };
  }

  async snapshot(): Promise<QuestionLifecycleSnapshot> {
    const pool = postgresPool(this.connectionString);
    const found = await run<{ question_id: string; next_state: string; sequence: string }>(
      pool,
      SNAPSHOT,
      [],
    );

    return Object.fromEntries(
      found.rows.map((row) => [
        row.question_id,
        {
          state: stateFrom(row.next_state),
          sequence: sequenceFrom(row.sequence, row.question_id),
        },
      ]),
    );
  }

  async history(questionId?: string): Promise<readonly QuestionLifecycleEvent[]> {
    const pool = postgresPool(this.connectionString);

    // Exact equality through a bound parameter, never LIKE and never interpolation:
    // "companion" is a prefix of "companion-animal", and a widening filter reads as more
    // history rather than as a bug.
    const found =
      questionId === undefined
        ? await run<EventRow>(pool, HISTORY, [])
        : await run<EventRow>(pool, HISTORY_FOR_QUESTION, [questionId]);

    return found.rows.map(toEvent);
  }

  /** The state the table actually holds, for a caller whose belief did not match it. */
  private async stale(
    pool: Pool,
    request: QuestionLifecycleRequest,
  ): Promise<QuestionLifecycleOutcome> {
    const found = await run<{ next_state: string }>(pool, CURRENT_STATE, [request.questionId]);
    const row = found.rows[0];

    return {
      applied: false,
      reason: "stale",
      currentState: row === undefined ? request.seededState : stateFrom(row.next_state),
    };
  }
}
