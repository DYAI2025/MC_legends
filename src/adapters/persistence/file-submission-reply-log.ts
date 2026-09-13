import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SubmissionReply } from "@/domain/replies/reply";
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
import type { SubmissionInboxReader } from "@/application/submissions/submission-inbox-reader";

/**
 * Append-only JSONL log of replies (MCL-74).
 *
 * The rollback path for `submission_reply`, and the store a machine with no database
 * runs on - the same role `FileSubmissionInboxStore` plays for the inbox, with the same
 * filesystem rules: one directory, one file, one per-directory write queue, an fsync on
 * the line and on the directory entry.
 *
 * It is handed a `SubmissionInboxReader` rather than reaching into the inbox files
 * itself. Two reasons, and the second is the load-bearing one: an adapter that parsed
 * another adapter's file would be a second reader of a format only one module is
 * supposed to own, and - because the composition root picks inbox adapters by
 * `DATABASE_URL` - it would also be the file reply log quietly assuming the inbox is on
 * disk too. Taking the port means it works against whichever inbox it is given.
 */

/**
 * One queue per directory, shared by every instance in this process.
 *
 * Same construction and the same honest limit as the other file stores: it holds within
 * ONE process. It is not distributed and it is not production-grade. The durable answer
 * is `submission_reply`'s primary key plus its foreign key, which hold across processes
 * and across crashes.
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

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * One line of the log, checked field by field rather than cast.
 *
 * `JSON.parse` returns `unknown`, and a cast would be a claim about data this process did
 * not produce. The failure that matters here is specific: a damaged line that still
 * carries a `submissionId` would otherwise become a reply card in front of a child,
 * built out of corruption and read aloud in an adult's name.
 */
function readReply(value: unknown): SubmissionReply | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;

  const { replyId, submissionId, understood, question, questionId, author, status, createdAt } =
    candidate;

  if (!isNonBlankString(replyId)) return null;
  if (!isNonBlankString(submissionId)) return null;
  if (!isNonBlankString(understood)) return null;
  if (!isNonBlankString(question)) return null;
  if (!isNonBlankString(questionId) || !isReplyQuestionId(questionId)) return null;
  if (questionId !== `reply:${submissionId}`) return null;
  if (author !== "human" && author !== "llm") return null;
  if (status !== "ready" && status !== "fallback") return null;
  if (!isNonBlankString(createdAt) || Number.isNaN(Date.parse(createdAt))) return null;

  return {
    replyId,
    submissionId,
    understood,
    question,
    questionId,
    author,
    status,
    createdAt,
  };
}

/** Ties in `createdAt` are broken by reply id, so two adapters agree on one order. */
function newestFirst(left: SubmissionReply, right: SubmissionReply): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1;
  return left.replyId < right.replyId ? 1 : -1;
}

export class FileSubmissionReplyLog implements SubmissionReplyLog, SubmissionReplyReader {
  constructor(
    private readonly directory: string,
    private readonly inbox: SubmissionInboxReader,
  ) {}

  async append(reply: SubmissionReply): Promise<void> {
    // Checked before the queue, not inside it: an unknown submission is a fact about the
    // inbox, not a race with another writer, and making callers wait behind the write
    // queue to be told "no such submission" buys nothing.
    const target = await this.inbox.find(reply.submissionId);
    if (target === null) throw new ReplyTargetError(reply.submissionId);

    await serialize(this.directory, async () => {
      await mkdir(this.directory, { recursive: true });
      await this.durablyAppend(`${JSON.stringify(reply)}\n`);
    });
  }

  async latestForHousehold(query: HouseholdReplyQuery): Promise<readonly ReplyView[]> {
    const replies = await this.readAll();

    const newestPerSubmission = new Map<string, SubmissionReply>();
    for (const reply of replies) {
      // A machine's admitted best effort never reaches a child in place of an answer.
      if (reply.status !== "ready") continue;
      if (query.since !== undefined && reply.createdAt <= query.since) continue;

      const known = newestPerSubmission.get(reply.submissionId);
      if (known === undefined || newestFirst(reply, known) < 0) {
        newestPerSubmission.set(reply.submissionId, reply);
      }
    }

    const ordered = [...newestPerSubmission.values()].sort(newestFirst);
    // Clamped here rather than refused, and clamped in the adapter rather than the route:
    // a limit is a memory question, and the answer must not depend on which caller asked.
    const limit = Math.min(query.limit ?? MAX_REPLY_PAGE_SIZE, MAX_REPLY_PAGE_SIZE);

    const views: ReplyView[] = [];
    for (const reply of ordered.slice(0, Math.max(limit, 0))) {
      const entry = await this.inbox.find(reply.submissionId);
      // A reply whose submission is gone is not shown. The delete script removes both
      // together; a half-removed pair is a fault, and drawing a card for it would show a
      // child an answer to something that no longer exists.
      if (entry === null) continue;

      views.push({
        reply,
        submission: {
          submissionId: entry.submissionId,
          kind: entry.kind,
          questionId: entry.questionId,
          createdAt: entry.createdAt,
          originalTextExcerpt:
            entry.kind === "text"
              ? entry.originalText.slice(0, MAX_ORIGINAL_EXCERPT_LENGTH)
              : null,
        },
      });
    }

    return views;
  }

  async listForSubmission(submissionId: string): Promise<readonly SubmissionReply[]> {
    const replies = await this.readAll();
    return replies
      .filter((reply) => reply.submissionId === submissionId)
      .sort((left, right) => -newestFirst(left, right));
  }

  private path(): string {
    return join(this.directory, "replies.jsonl");
  }

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
   * Every reply on disk, in the order it was appended.
   *
   * A line this adapter cannot read is a THROWN read, not a skipped line. The caller
   * turns that into an unavailable store, and the child surface draws nothing new -
   * which is honest. Skipping the line would silently drop a reply a child has already
   * been told about.
   */
  private async readAll(): Promise<SubmissionReply[]> {
    let content: string;

    try {
      content = await readFile(this.path(), "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw cause;
    }

    const replies: SubmissionReply[] = [];
    const lines = content.split("\n");

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined || line.length === 0) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`submission reply log line ${index + 1} is not JSON`);
      }

      const reply = readReply(parsed);
      if (reply === null) {
        // The line number, never the line: a reply holds an adult's words about a child's
        // words, and neither belongs in a log file an operator reads over someone's
        // shoulder.
        throw new Error(`submission reply log line ${index + 1} is not a reply`);
      }
      replies.push(reply);
    }

    return replies;
  }
}
