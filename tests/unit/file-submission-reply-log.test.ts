import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSubmissionReplyLog } from "@/adapters/persistence/file-submission-reply-log";
import { FileSubmissionInboxStore } from "@/adapters/persistence/file-submission-inbox-store";
import {
  describeSubmissionReplyLogContract,
  replyInboxSeed,
} from "./submission-reply-log-contract";

/**
 * MCL-74. The file reply log: the rollback path, and the store a machine with no
 * database runs on.
 *
 * Beyond the shared contract, this file pins the two things only a file can get wrong -
 * a damaged line, and the file it writes actually being JSONL rather than whatever
 * JSON.stringify happened to produce. Both matter because this store holds an adult's
 * words about a child's words: a line that cannot be read must stop the read, not be
 * skipped into silence.
 */

const directories: string[] = [];

async function freshDirectories(): Promise<{ inbox: string; replies: string }> {
  const root = await mkdtemp(join(tmpdir(), "mcl-reply-"));
  directories.push(root);
  const inbox = join(root, "inbox");
  const replies = join(root, "replies");
  await mkdir(inbox, { recursive: true });
  await mkdir(replies, { recursive: true });
  return { inbox, replies };
}

async function seededLog(): Promise<FileSubmissionReplyLog> {
  const { inbox, replies } = await freshDirectories();
  const store = new FileSubmissionInboxStore(inbox);
  for (const record of replyInboxSeed()) {
    await store.appendIfAbsent(record);
  }
  return new FileSubmissionReplyLog(replies, store);
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describeSubmissionReplyLogContract("file", seededLog);

describe("file reply log specifics", () => {
  it("writes one JSON object per line, so the file stays readable by other tools", async () => {
    const { inbox, replies } = await freshDirectories();
    const store = new FileSubmissionInboxStore(inbox);
    for (const record of replyInboxSeed()) await store.appendIfAbsent(record);
    const log = new FileSubmissionReplyLog(replies, store);

    await log.append({
      replyId: "r-1",
      submissionId: "sub-alpha",
      understood: "Du möchtest ein Wesen, das leuchtet.",
      question: "Welche Farbe soll es sein?",
      questionId: "reply:sub-alpha",
      author: "human",
      status: "ready",
      createdAt: "2026-09-12T18:00:00.000Z",
    });

    const content = await readFile(join(replies, "replies.jsonl"), "utf8");
    const lines = content.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ replyId: "r-1" });
    expect(content.endsWith("\n")).toBe(true);
  });

  it("stops the read on a damaged line instead of quietly dropping a reply", async () => {
    const { inbox, replies } = await freshDirectories();
    const store = new FileSubmissionInboxStore(inbox);
    for (const record of replyInboxSeed()) await store.appendIfAbsent(record);
    await writeFile(join(replies, "replies.jsonl"), "{not json\n", "utf8");
    const log = new FileSubmissionReplyLog(replies, store);

    await expect(log.latestForHousehold({})).rejects.toThrow(/line 1 is not JSON/u);
  });

  it("refuses a line that parses but is not a reply", async () => {
    const { inbox, replies } = await freshDirectories();
    const store = new FileSubmissionInboxStore(inbox);
    for (const record of replyInboxSeed()) await store.appendIfAbsent(record);
    // A submissionId and nothing else: enough for a careless cast to build a card from,
    // and read aloud to a child in an adult's name.
    await writeFile(join(replies, "replies.jsonl"), '{"submissionId":"sub-alpha"}\n', "utf8");
    const log = new FileSubmissionReplyLog(replies, store);

    await expect(log.latestForHousehold({})).rejects.toThrow(/line 1 is not a reply/u);
  });

  it("refuses a line whose questionId does not name its own submission", async () => {
    const { inbox, replies } = await freshDirectories();
    const store = new FileSubmissionInboxStore(inbox);
    for (const record of replyInboxSeed()) await store.appendIfAbsent(record);
    await writeFile(
      join(replies, "replies.jsonl"),
      `${JSON.stringify({
        replyId: "r-1",
        submissionId: "sub-alpha",
        understood: "Text",
        question: "Frage?",
        questionId: "reply:sub-beta",
        author: "human",
        status: "ready",
        createdAt: "2026-09-12T18:00:00.000Z",
      })}\n`,
      "utf8",
    );
    const log = new FileSubmissionReplyLog(replies, store);

    // The database enforces this with a CHECK. Without the same rule here, a restore
    // through the file path could file a reply under a chain it does not belong to.
    await expect(log.latestForHousehold({})).rejects.toThrow(/line 1 is not a reply/u);
  });

  it("reads an empty store as empty rather than as an outage", async () => {
    const { inbox, replies } = await freshDirectories();
    const store = new FileSubmissionInboxStore(inbox);
    const log = new FileSubmissionReplyLog(replies, store);
    expect(await log.latestForHousehold({})).toEqual([]);
  });
});
