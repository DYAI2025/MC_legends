import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  actionProducingState,
  type QuestionLifecycleSnapshot,
  type QuestionState,
} from "@/domain/questions/question-lifecycle";
import {
  assertStorableLifecycleRequest,
  type QuestionLifecycleEvent,
  type QuestionLifecycleLog,
  type QuestionLifecycleOutcome,
  type QuestionLifecycleReader,
  type QuestionLifecycleRequest,
} from "@/application/questions/question-lifecycle";

const FILE_NAME = "question-lifecycle.jsonl";

/**
 * One queue per directory, shared by every instance in this process.
 *
 * A log is built per request, so an instance field would serialise nothing. Keyed by
 * directory rather than global so two directories - tests, mainly - do not wait on each
 * other.
 *
 * This is the honest boundary of the file adapter's concurrency safety: it holds within
 * ONE process. Two app processes writing the same directory can both read "still open"
 * before either appends, and both will append. It is not distributed and it is not
 * production-grade; the durable answer is the UNIQUE (question_id, revision) constraint
 * in migration 0003, which holds across processes and across crashes.
 */
const writeQueues = new Map<string, Promise<unknown>>();

function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  // Both handlers run `task`: a failed predecessor must not stall the queue behind it.
  const next = previous.then(task, task);
  writeQueues.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

function isState(value: unknown): value is QuestionState {
  return value === "open" || value === "closed";
}

/**
 * One line of the log, checked rather than cast.
 *
 * Returns null for anything this adapter cannot have written - which the caller turns
 * into a thrown read, NOT into a skipped line. That is the opposite of the inbox file
 * store's policy, and deliberately so: a skipped submission line loses one answer, while
 * a skipped lifecycle line silently changes what every question's state is derived to
 * be. Dropping a `closed` event would put a retired question back in front of children
 * and nothing anywhere would look wrong.
 */
function readEvent(value: unknown): QuestionLifecycleEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const { questionId, action, previousState, nextState, occurredAt, sequence, revision } =
    candidate;

  if (typeof questionId !== "string" || questionId.length === 0) return null;
  if (action !== "closed" && action !== "reopened") return null;
  if (!isState(previousState) || !isState(nextState)) return null;
  if (previousState === nextState) return null;
  if (actionProducingState(nextState) !== action) return null;
  if (typeof occurredAt !== "string" || Number.isNaN(Date.parse(occurredAt))) return null;
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 1) return null;
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) return null;

  return {
    questionId,
    action,
    previousState,
    nextState,
    occurredAt,
    sequence: sequence as number,
    revision: revision as number,
  };
}

/** The newest event per question, by that question's own revision counter. */
function latestPerQuestion(
  events: readonly QuestionLifecycleEvent[],
): Map<string, QuestionLifecycleEvent> {
  const latest = new Map<string, QuestionLifecycleEvent>();

  for (const event of events) {
    const known = latest.get(event.questionId);
    if (known === undefined || event.revision > known.revision) {
      latest.set(event.questionId, event);
    }
  }

  return latest;
}

/**
 * Append-only JSONL log of question lifecycle changes (MCL-35).
 *
 * The rollback path for the PostgreSQL table, and the store a machine with no database
 * runs on. Same shape as the inbox file store on purpose - one directory, one file, one
 * per-directory write queue, an fsync on the line and on the directory entry - so there
 * is one set of filesystem rules in this project rather than two.
 *
 * Nothing here updates or deletes. Reopening a question appends a second event next to
 * the first, which is what makes "reopening does not erase the close" true by
 * construction rather than by care.
 */
export class FileQuestionLifecycleLog implements QuestionLifecycleLog, QuestionLifecycleReader {
  constructor(private readonly directory: string) {}

  async append(request: QuestionLifecycleRequest): Promise<QuestionLifecycleOutcome> {
    assertStorableLifecycleRequest(request);

    return serialize(this.directory, async () => {
      const events = await this.readAll();
      const latest = latestPerQuestion(events).get(request.questionId) ?? null;
      const currentState = latest?.nextState ?? request.seededState;

      if (currentState !== request.expectedState) {
        // Not a failure: the caller acted on a state that has since moved. It is told
        // what actually holds so it can show the truth rather than only refuse.
        return { applied: false, reason: "stale", currentState } as const;
      }

      const event: QuestionLifecycleEvent = {
        questionId: request.questionId,
        action: actionProducingState(request.nextState),
        previousState: request.expectedState,
        nextState: request.nextState,
        occurredAt: new Date().toISOString(),
        // The file's own total order. Equal to the line number, which is what makes a
        // hand-read of the file agree with what the application derived from it.
        sequence: events.length + 1,
        revision: (latest?.revision ?? -1) + 1,
      };

      await mkdir(this.directory, { recursive: true });
      await this.durablyAppend(`${JSON.stringify(event)}\n`);

      return { applied: true, event } as const;
    });
  }

  async snapshot(): Promise<QuestionLifecycleSnapshot> {
    const latest = latestPerQuestion(await this.readAll());

    return Object.fromEntries(
      [...latest.values()].map((event) => [
        event.questionId,
        { state: event.nextState, sequence: event.sequence },
      ]),
    );
  }

  async history(questionId?: string): Promise<readonly QuestionLifecycleEvent[]> {
    const events = await this.readAll();

    // Exact equality, never a prefix: "companion" is a prefix of "companion-animal", and
    // a widening filter reads as more history rather than as a bug.
    const matching =
      questionId === undefined
        ? events
        : events.filter((event) => event.questionId === questionId);

    return [...matching].sort((left, right) => right.sequence - left.sequence);
  }

  private path(): string {
    return join(this.directory, FILE_NAME);
  }

  /**
   * Appends one line and does not resolve until the operating system says it is on the
   * storage device. Two fsyncs, as in the inbox file store and for the same reason: the
   * first makes the line durable, the second makes the file's directory entry durable,
   * without which a crash after the very first append can lose the whole file.
   */
  private async durablyAppend(line: string): Promise<void> {
    const handle = await open(this.path(), "a");
    try {
      await handle.writeFile(line, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    const directory = await open(this.directory, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  /**
   * Every event on disk, in the order it was appended.
   *
   * A line this adapter cannot read is a THROWN read, not a skipped line - see
   * `readEvent`. The caller turns that into an unavailable store, which the child surface
   * draws as "the question is not here right now" and the adult surface refuses to act
   * on. Both are honest; a silently mis-derived state is not.
   */
  private async readAll(): Promise<QuestionLifecycleEvent[]> {
    let content: string;

    try {
      content = await readFile(this.path(), "utf8");
    } catch (cause) {
      // No file yet means nothing was ever closed. Every other read error is a real
      // fault and must reach the caller.
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw cause;
    }

    const events: QuestionLifecycleEvent[] = [];
    const lines = content.split("\n");

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.length === 0) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`question lifecycle log line ${index + 1} is not JSON`);
      }

      const event = readEvent(parsed);
      if (event === null) {
        // The line number and nothing else: a lifecycle line holds no child text, but
        // the rule that a log line never carries stored content is worth keeping
        // unconditional.
        throw new Error(`question lifecycle log line ${index + 1} is not a lifecycle event`);
      }

      events.push(event);
    }

    return events;
  }
}
