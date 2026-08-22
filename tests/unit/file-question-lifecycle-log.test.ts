import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileQuestionLifecycleLog } from "@/adapters/persistence/file-question-lifecycle-log";
import {
  closeRequest,
  describeQuestionLifecycleContract,
  reopenRequest,
} from "./question-lifecycle-contract";

/**
 * The JSONL lifecycle log (MCL-35): the store a machine with no database runs on, and
 * the rollback path when DATABASE_URL is taken out of the picture.
 *
 * The shared contract covers what both adapters must do. What is left here is what is
 * true of a FILE and of nothing else: the line that is written, and what happens when a
 * line cannot be read.
 */

let directory = "";

/** Every directory this file made, so afterEach removes all of them and not just one. */
const created: string[] = [];

async function makeDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "avaloria-question-lifecycle-"));
  created.push(path);
  return path;
}

beforeEach(async () => {
  directory = await makeDirectory();
});

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describeQuestionLifecycleContract("FileQuestionLifecycleLog", async () => {
  // A fresh directory per handout, so "an empty store" is empty for a reason a case can
  // see rather than because something deleted rows.
  return new FileQuestionLifecycleLog(await makeDirectory());
});

describe("FileQuestionLifecycleLog", () => {
  function logFile(): string {
    return join(directory, "question-lifecycle.jsonl");
  }

  it("appends one line per change and never rewrites an earlier one", async () => {
    const log = new FileQuestionLifecycleLog(directory);

    await log.append(closeRequest("companion-animal"));
    const afterClose = await readFile(logFile(), "utf8");
    await log.append(reopenRequest("companion-animal"));
    const afterReopen = await readFile(logFile(), "utf8");

    // The file grew and its beginning is byte-identical: the close is still exactly the
    // bytes it was written as. That is what "traceably archived" means on a filesystem,
    // and it is stronger than any claim about which SQL verbs the adapter uses.
    expect(afterReopen.startsWith(afterClose)).toBe(true);
    expect(afterReopen.trimEnd().split("\n")).toHaveLength(2);
  });

  it("numbers the sequence by line, so the file reads the way it is derived", async () => {
    const log = new FileQuestionLifecycleLog(directory);

    await log.append(closeRequest("companion-animal"));
    await log.append(closeRequest("druhen-protection"));

    const lines = (await readFile(logFile(), "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { sequence: number; questionId: string });

    expect(lines.map((line) => line.sequence)).toEqual([1, 2]);
    expect(lines.map((line) => line.questionId)).toEqual([
      "companion-animal",
      "druhen-protection",
    ]);
  });

  it("refuses to answer at all when a line cannot be read", async () => {
    await writeFile(logFile(), "{not json}\n", "utf8");
    const log = new FileQuestionLifecycleLog(directory);

    // Deliberately the opposite of the inbox file store, which skips a damaged line and
    // carries on. Skipping here would silently change what every question's state is
    // derived to be: a dropped `closed` event puts a retired question back in front of
    // children, and nothing anywhere would look wrong. An unreadable log is an
    // unavailable store, which both surfaces already know how to say.
    await expect(log.snapshot()).rejects.toThrow(/line 1/);
    await expect(log.history()).rejects.toThrow(/line 1/);
    await expect(log.append(closeRequest("companion-animal"))).rejects.toThrow(/line 1/);
  });

  it("refuses a line whose action and states contradict each other", async () => {
    // Valid JSON, every field present, and a lie: an event claiming it closed a question
    // while leaving it open. A cast would have accepted it and the derived state would
    // have been whatever that line said.
    await writeFile(
      logFile(),
      `${JSON.stringify({
        questionId: "companion-animal",
        action: "closed",
        previousState: "closed",
        nextState: "open",
        occurredAt: "2026-08-22T09:00:00.000Z",
        sequence: 1,
        revision: 0,
      })}\n`,
      "utf8",
    );

    await expect(new FileQuestionLifecycleLog(directory).snapshot()).rejects.toThrow(
      /not a lifecycle event/,
    );
  });

  it("reports nothing rather than failing before anything was ever closed", async () => {
    const log = new FileQuestionLifecycleLog(directory);

    // No file on disk at all. A fresh deployment must not look like a broken one.
    expect(await log.snapshot()).toEqual({});
    expect(await log.history()).toEqual([]);
  });
});
