import { describe, expect, it } from "vitest";
import type { SubmissionReply } from "@/domain/replies/reply";
import { ReplyTargetError, type SubmissionReplyLog } from "@/application/replies/submission-reply-log";
import type { SubmissionReplyReader } from "@/application/replies/submission-reply-reader";
import type { InboxRecord } from "@/application/submissions/submission-inbox-store";

/**
 * MCL-74. The behaviour both reply adapters owe, run against each of them.
 *
 * One suite rather than two, for the reason the inbox contract records: the file store is
 * the rollback path, so "the same reply reads the same way whichever store happens to be
 * configured" is a promise a deployment actually depends on. The asymmetries this catches
 * are real ones - a database orders with SQL and a file orders in JavaScript, and
 * `DISTINCT ON` and a Map do not agree about ties unless somebody makes them.
 */

/**
 * The submissions the replies answer.
 *
 * `sub-audio` is here and not only in a text fixture because the excerpt rule differs by
 * kind, and that is exactly the kind of thing one adapter gets right by accident.
 * Deliberately non-monotonic times relative to the ids: `sub-beta` is older than
 * `sub-alpha`, so an adapter ordering by primary key passes a tidier fixture and fails
 * this one.
 */
export function replyInboxSeed(): readonly InboxRecord[] {
  return [
    {
      kind: "text",
      submissionId: "sub-alpha",
      questionId: "companion-animal",
      createdAt: "2026-09-10T08:00:00.000Z",
      receivedAt: "2026-09-10T08:00:01.000Z",
      receiptId: "receipt-alpha",
      originalText: `Ein Wolf der leuchtet. ${"und noch viel mehr dazu ".repeat(12)}`,
    },
    {
      kind: "text",
      submissionId: "sub-beta",
      questionId: "companion-animal",
      createdAt: "2026-09-09T08:00:00.000Z",
      receivedAt: "2026-09-09T08:00:01.000Z",
      receiptId: "receipt-beta",
      originalText: "Ein Stein der singt",
    },
    {
      kind: "audio",
      submissionId: "sub-audio",
      questionId: "companion-animal",
      createdAt: "2026-09-11T08:00:00.000Z",
      receivedAt: "2026-09-11T08:00:01.000Z",
      receiptId: "receipt-audio",
      audio: {
        objectKey: "2026/09/11/abc123.webm",
        mimeType: "audio/webm",
        extension: "webm",
        sizeBytes: 4096,
        sha256: "a".repeat(64),
      },
    },
  ];
}

function reply(overrides: Partial<SubmissionReply> & { replyId: string; submissionId: string }): SubmissionReply {
  return {
    understood: "Du möchtest ein Wesen, das leuchtet.",
    question: "Welche Farbe soll es sein?",
    questionId: `reply:${overrides.submissionId}`,
    author: "human",
    status: "ready",
    createdAt: "2026-09-12T18:00:00.000Z",
    ...overrides,
  };
}

export type ReplyLogUnderTest = SubmissionReplyLog & SubmissionReplyReader;

/**
 * @param factory builds an adapter seeded with `replyInboxSeed()` and an empty reply log.
 */
export function describeSubmissionReplyLogContract(
  name: string,
  factory: () => Promise<ReplyLogUnderTest>,
): void {
  describe(`${name} reply log contract`, () => {
    it("hands back what it stored", async () => {
      const log = await factory();
      const written = reply({ replyId: "r-1", submissionId: "sub-alpha" });
      await log.append(written);

      expect(await log.listForSubmission("sub-alpha")).toEqual([written]);
    });

    it("keeps every reply to one submission, oldest first", async () => {
      const log = await factory();
      await log.append(
        reply({ replyId: "r-2", submissionId: "sub-alpha", createdAt: "2026-09-12T19:00:00.000Z" }),
      );
      await log.append(
        reply({ replyId: "r-1", submissionId: "sub-alpha", createdAt: "2026-09-12T18:00:00.000Z" }),
      );

      const history = await log.listForSubmission("sub-alpha");
      expect(history.map((entry) => entry.replyId)).toEqual(["r-1", "r-2"]);
    });

    it("never overwrites a correction over the reply a child already heard", async () => {
      const log = await factory();
      await log.append(
        reply({
          replyId: "r-1",
          submissionId: "sub-alpha",
          understood: "Ein erster Versuch.",
          createdAt: "2026-09-12T18:00:00.000Z",
        }),
      );
      await log.append(
        reply({
          replyId: "r-2",
          submissionId: "sub-alpha",
          understood: "So war es gemeint.",
          createdAt: "2026-09-12T19:00:00.000Z",
        }),
      );

      expect(await log.listForSubmission("sub-alpha")).toHaveLength(2);
    });

    it("shows the household only the newest reply per submission", async () => {
      const log = await factory();
      await log.append(
        reply({ replyId: "r-1", submissionId: "sub-alpha", createdAt: "2026-09-12T18:00:00.000Z" }),
      );
      await log.append(
        reply({ replyId: "r-2", submissionId: "sub-alpha", createdAt: "2026-09-12T19:00:00.000Z" }),
      );
      await log.append(
        reply({ replyId: "r-3", submissionId: "sub-beta", createdAt: "2026-09-12T17:00:00.000Z" }),
      );

      const views = await log.latestForHousehold({});
      expect(views.map((view) => view.reply.replyId)).toEqual(["r-2", "r-3"]);
    });

    it("never lets a fallback reach a child in place of an answer", async () => {
      const log = await factory();
      await log.append(
        reply({
          replyId: "r-1",
          submissionId: "sub-alpha",
          status: "fallback",
          author: "llm",
          createdAt: "2026-09-12T19:00:00.000Z",
        }),
      );
      await log.append(
        reply({ replyId: "r-2", submissionId: "sub-beta", createdAt: "2026-09-12T18:00:00.000Z" }),
      );

      const views = await log.latestForHousehold({});
      expect(views.map((view) => view.reply.replyId)).toEqual(["r-2"]);
      // Still in the adult's history: it happened, and hiding it from the person who has
      // to notice it happened would be the wrong half to keep.
      expect(await log.listForSubmission("sub-alpha")).toHaveLength(1);
    });

    it("answers a since filter with what came strictly after it", async () => {
      const log = await factory();
      await log.append(
        reply({ replyId: "r-1", submissionId: "sub-alpha", createdAt: "2026-09-12T18:00:00.000Z" }),
      );
      await log.append(
        reply({ replyId: "r-2", submissionId: "sub-beta", createdAt: "2026-09-12T20:00:00.000Z" }),
      );

      const views = await log.latestForHousehold({ since: "2026-09-12T18:00:00.000Z" });
      expect(views.map((view) => view.reply.replyId)).toEqual(["r-2"]);
    });

    it("clamps an over-large limit instead of trusting it", async () => {
      const log = await factory();
      await log.append(reply({ replyId: "r-1", submissionId: "sub-alpha" }));
      expect(await log.latestForHousehold({ limit: 10_000 })).toHaveLength(1);
    });

    it("caps the page at the limit it was given", async () => {
      const log = await factory();
      await log.append(
        reply({ replyId: "r-1", submissionId: "sub-alpha", createdAt: "2026-09-12T19:00:00.000Z" }),
      );
      await log.append(
        reply({ replyId: "r-2", submissionId: "sub-beta", createdAt: "2026-09-12T18:00:00.000Z" }),
      );

      const views = await log.latestForHousehold({ limit: 1 });
      expect(views.map((view) => view.reply.replyId)).toEqual(["r-1"]);
    });

    it("carries a handle to the idea, cut to the same length in every store", async () => {
      const log = await factory();
      await log.append(reply({ replyId: "r-1", submissionId: "sub-alpha" }));

      const [view] = await log.latestForHousehold({});
      expect(view?.submission.originalTextExcerpt?.length).toBe(120);
      expect(view?.submission.kind).toBe("text");
      expect(view?.submission.questionId).toBe("companion-animal");
      expect(view?.submission.createdAt).toBe("2026-09-10T08:00:00.000Z");
    });

    it("has no text to excerpt for a recording, and invents none", async () => {
      const log = await factory();
      await log.append(reply({ replyId: "r-1", submissionId: "sub-audio" }));

      const [view] = await log.latestForHousehold({});
      expect(view?.submission.kind).toBe("audio");
      expect(view?.submission.originalTextExcerpt).toBeNull();
    });

    it("refuses a reply to a submission no inbox holds", async () => {
      const log = await factory();
      await expect(
        log.append(reply({ replyId: "r-1", submissionId: "sub-does-not-exist" })),
      ).rejects.toBeInstanceOf(ReplyTargetError);
    });

    it("says nothing about a submission nobody has answered", async () => {
      const log = await factory();
      expect(await log.listForSubmission("sub-beta")).toEqual([]);
      expect(await log.latestForHousehold({})).toEqual([]);
    });
  });
}
