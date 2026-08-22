import type {
  QuestionLifecycleAction,
  QuestionLifecycleSnapshot,
  QuestionState,
} from "@/domain/questions/question-lifecycle";

/**
 * MCL-35. The persistence boundary for closing and reopening questions.
 *
 * Two ports rather than one, for the reason MCL-50 already recorded for the inbox: the
 * child surface needs the READ capability and must never be able to acquire the write
 * one by asking the composition root for a reader. One interface carrying both methods
 * would make that a matter of discipline, and discipline is not what should stand
 * between a child's page and a verb that retires a question for everybody.
 */

/**
 * One recorded change, exactly as it happened.
 *
 * `previousState` is stored rather than replayed. History is read far more often than it
 * is written, and a row that states both ends of its own transition can be read on its
 * own - by a person in psql as much as by this application - instead of only making
 * sense in sequence with every row before it.
 *
 * `sequence` is the store's total order over every question. `revision` is the order
 * within ONE question, starting at 0. They are different jobs: `sequence` is what orders
 * reopened questions against each other in the rotation, and `revision` is what makes
 * two simultaneous changes to one question collide instead of both being written.
 */
export type QuestionLifecycleEvent = Readonly<{
  questionId: string;
  action: QuestionLifecycleAction;
  previousState: QuestionState;
  nextState: QuestionState;
  /** ISO 8601, minted by the application. Never used for ordering - see `sequence`. */
  occurredAt: string;
  sequence: number;
  revision: number;
}>;

/**
 * One attempted change.
 *
 * `expectedState` is what the caller believed when it decided to act, and it is the whole
 * of the concurrency contract: a change is applied only if the store still agrees. Two
 * adults on two devices looking at the same board therefore cannot both "close" a
 * question and produce two events, and neither can a stale browser tab left open
 * overnight.
 *
 * `seededState` is what the dataset says for a question the store holds no event for.
 * Passed in rather than looked up here, because the dataset is content and this is a
 * persistence port: the store must not have to import the questions to know what "no
 * event yet" means.
 */
export type QuestionLifecycleRequest = Readonly<{
  questionId: string;
  /** The state the caller wants. Must differ from `expectedState`. */
  nextState: QuestionState;
  expectedState: QuestionState;
  seededState: QuestionState;
}>;

/**
 * What one append attempt did.
 *
 * `applied: false` is not a failure and not an outage - it is the honest answer to a
 * caller acting on a state that has since moved. It carries the state that actually
 * holds, so the surface can show the truth rather than only refusing.
 */
export type QuestionLifecycleOutcome =
  | Readonly<{ applied: true; event: QuestionLifecycleEvent }>
  | Readonly<{ applied: false; reason: "stale"; currentState: QuestionState }>;

/**
 * The store refused the request itself. Retrying it unchanged can never succeed.
 *
 * On the port and not in one adapter, for the same reason SubmissionPayloadError is:
 * the caller has to tell "this can never be stored" from "the store is unavailable"
 * without knowing which adapter it was handed. Everything else stays untyped and means
 * the second.
 */
export class QuestionLifecyclePayloadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "QuestionLifecyclePayloadError";
  }
}

/**
 * Mirrors `question_lifecycle_question_id_length` in migration 0003.
 *
 * The number is duplicated in the schema on purpose - the limits belong where durability
 * does - but the CHECK it mirrors is only one of the two things a request has to satisfy,
 * and the other one has no SQL equivalent at all (see below).
 */
const MAX_QUESTION_ID_LENGTH = 200;

/**
 * What no store will ever hold, refused before any adapter reads or writes anything.
 *
 * On the port rather than in each adapter, because the two adapters would otherwise
 * disagree about it and the disagreement would be invisible: PostgreSQL refuses an
 * over-long id with a CHECK violation and a JSONL file refuses nothing at all, which is
 * exactly the asymmetry MCL-49 already paid for once - the same request rejected in
 * production and accepted after a rollback. A blank id has no SQL equivalent even in the
 * database branch, so stating it here is the only place it can be stated once.
 *
 * `QuestionLifecyclePayloadError` rather than a bare throw: the route answers the two
 * differently, and a request no retry can fix must not be reported as an outage the
 * caller is invited to retry forever.
 */
export function assertStorableLifecycleRequest(request: QuestionLifecycleRequest): void {
  if (request.expectedState === request.nextState) {
    throw new QuestionLifecyclePayloadError(
      "a lifecycle change must move the question to a different state",
    );
  }

  const { questionId } = request;

  if (
    questionId.trim().length === 0 ||
    questionId.length > MAX_QUESTION_ID_LENGTH ||
    questionId.includes("\u0000") ||
    !questionId.isWellFormed()
  ) {
    // The two shapes that survive every other check and still cannot be stored: a NUL,
    // which PostgreSQL refuses outright (22021), and a lone surrogate, which
    // node-postgres silently rewrites to U+FFFD - storing an id that is not the id that
    // was sent. Refused, never repaired.
    throw new QuestionLifecyclePayloadError("the question id cannot be stored");
  }
}

/** The write side. Only the protected adult surface is ever handed one of these. */
export interface QuestionLifecycleLog {
  append(request: QuestionLifecycleRequest): Promise<QuestionLifecycleOutcome>;
}

/**
 * The read side.
 *
 * `snapshot` deliberately answers with the CURRENT state per question and not with the
 * events: the child surface has no business replaying history to find out what to ask,
 * and a page that did would grow slower with every close an adult ever made.
 *
 * Neither method has a "return the seeded state when nothing is stored" mode. A store
 * knows what it stored; what the dataset seeded is the content layer's business, and
 * merging the two here would give two modules the same job.
 */
export interface QuestionLifecycleReader {
  snapshot(): Promise<QuestionLifecycleSnapshot>;

  /** Newest first. All questions, or one - filtered by exact id, never by prefix. */
  history(questionId?: string): Promise<readonly QuestionLifecycleEvent[]>;
}
