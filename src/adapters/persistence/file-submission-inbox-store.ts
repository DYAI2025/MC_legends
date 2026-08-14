import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AppendOutcome,
  InboxRecord,
  SubmissionInboxStore,
} from "@/application/submissions/submission-inbox-store";
import {
  MAX_INBOX_PAGE_SIZE,
  type InboxEntry,
  type InboxPage,
  type InboxQuery,
  type SubmissionInboxReader,
} from "@/application/submissions/submission-inbox-reader";

const FILE_NAME = "submissions.jsonl";

/**
 * One queue per inbox directory, shared by every store instance in this process.
 *
 * A store is built per request, so an instance field would serialise nothing. Keyed by
 * directory rather than global, so two directories (tests, mainly) do not wait on each
 * other.
 *
 * This is the honest boundary of the file adapter's idempotency: it holds within ONE
 * process. Two app processes writing the same directory can both read "absent" before
 * either appends, and both will append. The durable fix is a unique constraint in the
 * database of MCL-48, not more locking here.
 */
const writeQueues = new Map<string, Promise<unknown>>();

function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  // Both handlers run `task`: a failed predecessor must not stall the queue behind it.
  const next = previous.then(task, task);
  // Stored with its rejection already handled, so an unhandled rejection cannot be
  // raised from the queue itself. The real result is still returned to the caller.
  writeQueues.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

/**
 * Append-only JSONL store for the family project inbox. Deliberately minimal: the
 * durable multi-instance storage (MCL-48) and the read/admin side (MCL-50) are not
 * this adapter's job.
 */
/**
 * Exact equality on every supplied filter, never a prefix or substring match.
 *
 * `questionId` is the one that matters: "companion" is a prefix of "companion-animal",
 * so a startsWith-based filter would silently widen as soon as a question id gains a
 * suffix, and the widening would look like more answers rather than like a bug.
 */
function matches(record: InboxRecord, query: InboxQuery): boolean {
  if (query.questionId !== undefined && record.questionId !== query.questionId) {
    return false;
  }

  if (query.kind !== undefined && record.kind !== query.kind) {
    return false;
  }

  // The JSONL lines carry no status - nothing in the write path sets one. RECEIVED is
  // the value migration 0001 defaults the column to, so both adapters answer the same
  // thing for the same submission and a rollback does not change what the inbox shows.
  return query.status === undefined || query.status === "RECEIVED";
}

function toEntry(record: InboxRecord): InboxEntry {
  return {
    submissionId: record.submissionId,
    kind: record.kind,
    questionId: record.questionId,
    createdAt: record.createdAt,
    receivedAt: record.receivedAt,
    receiptId: record.receiptId,
    originalText: record.originalText,
    status: "RECEIVED",
  };
}

/**
 * A caller-supplied limit, clamped. Anything that is not a positive integer - absent,
 * zero, negative, fractional, NaN - falls back to the maximum rather than to nothing:
 * a malformed limit must not silently render an empty inbox that looks like "no answers
 * yet".
 */
function pageSize(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit <= 0) {
    return MAX_INBOX_PAGE_SIZE;
  }

  return Math.min(limit, MAX_INBOX_PAGE_SIZE);
}

export class FileSubmissionInboxStore implements SubmissionInboxStore, SubmissionInboxReader {
  constructor(private readonly directory: string) {}

  async appendIfAbsent(record: InboxRecord): Promise<AppendOutcome> {
    return serialize(this.directory, async () => {
      const existing = await this.findBySubmissionId(record.submissionId);
      if (existing !== null) {
        return { stored: false, existing } as const;
      }

      await mkdir(this.directory, { recursive: true });
      await appendFile(this.path(), `${JSON.stringify(record)}\n`, "utf8");
      return { stored: true } as const;
    });
  }

  private path(): string {
    return join(this.directory, FILE_NAME);
  }

  /**
   * A full scan per write. That is fine for a family inbox of this size and wrong for
   * a growing one - which is exactly why the durable store is a separate ticket rather
   * than an index bolted onto a text file.
   */
  private async findBySubmissionId(submissionId: string): Promise<InboxRecord | null> {
    for (const candidate of await this.readAll()) {
      if (candidate.submissionId === submissionId) {
        return candidate;
      }
    }

    return null;
  }

  /**
   * Every record on disk, in the order it was appended.
   *
   * Shared by the write-side duplicate check and the MCL-50 read side so both see the
   * same file the same way - including which damaged lines they skip. Two parsers over
   * one format would eventually disagree, and the disagreement would show up as a
   * submission that blocks a retry but never appears in the inbox.
   */
  private async readAll(): Promise<InboxRecord[]> {
    let content: string;

    try {
      content = await readFile(this.path(), "utf8");
    } catch (cause) {
      // No file yet means nothing is stored. Every other read error is a real fault and
      // must reach the caller: swallowing it would turn "cannot read the inbox" into
      // "this submission is new" and duplicate silently.
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw cause;
    }

    const records: InboxRecord[] = [];

    for (const line of content.split("\n")) {
      if (line.length === 0) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A line this adapter cannot have written is not a match for anything. Skipped
        // rather than thrown, so one damaged line cannot block every later submission.
        continue;
      }

      records.push(parsed as InboxRecord);
    }

    return records;
  }

  /**
   * MCL-50's read side, over the same JSONL file.
   *
   * This adapter is MCL-48's rollback path, not a second production store: removing
   * DATABASE_URL and restarting must return a *working* system, admin inbox included.
   * A read side that existed only on the PostgreSQL adapter would make the rollback
   * quietly lossy in exactly the situation somebody reaches for it.
   *
   * A full scan and an in-memory sort, for the same reason the write side scans: this
   * is a family inbox measured in kilobytes, and the file store is the fallback rather
   * than the destination. The indexed version of this query lives in the PostgreSQL
   * adapter, where migration 0001 already created the two indexes for it.
   */
  async list(query: InboxQuery): Promise<InboxPage> {
    const matching = (await this.readAll()).filter((record) => matches(record, query));

    // Descending by receivedAt, then by submissionId as a tiebreaker. receivedAt is not
    // unique - two answers can land in the same millisecond - and without the second key
    // their relative order would depend on file order, which is not something a reader
    // paging through the inbox should have to know about.
    matching.sort(
      (left, right) =>
        right.receivedAt.localeCompare(left.receivedAt) ||
        right.submissionId.localeCompare(left.submissionId),
    );

    const limit = pageSize(query.limit);

    return {
      entries: matching.slice(0, limit).map(toEntry),
      // The full match count, not the page's length: a capped page must not make the
      // inbox look smaller than it is.
      total: matching.length,
    };
  }
}
