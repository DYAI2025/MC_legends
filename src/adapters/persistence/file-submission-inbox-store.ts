import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AppendOutcome,
  InboxRecord,
  SubmissionInboxStore,
} from "@/application/submissions/submission-inbox-store";

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
export class FileSubmissionInboxStore implements SubmissionInboxStore {
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
    let content: string;

    try {
      content = await readFile(this.path(), "utf8");
    } catch (cause) {
      // No file yet means nothing is stored. Every other read error is a real fault and
      // must reach the caller: swallowing it would turn "cannot read the inbox" into
      // "this submission is new" and duplicate silently.
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw cause;
    }

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

      const candidate = parsed as Partial<InboxRecord>;
      if (candidate.submissionId === submissionId) {
        return candidate as InboxRecord;
      }
    }

    return null;
  }
}
