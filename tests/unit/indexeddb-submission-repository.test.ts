import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { IndexedDbSubmissionRepository } from "@/adapters/persistence/indexeddb-submission-repository";
import { createTextSubmission } from "@/domain/submissions/submission";

describe("IndexedDbSubmissionRepository", () => {
  it("returns the same id and original text after a new repository instance reads it", async () => {
    const databaseName = `test-${crypto.randomUUID()}`;
    const firstRepository = new IndexedDbSubmissionRepository(databaseName);
    const submission = createTextSubmission(
      { questionId: "question-001", originalText: "  unveraendert  " },
      {
        createId: () => "sub-001",
        now: () => new Date("2026-08-11T00:00:00.000Z"),
      },
    );

    await firstRepository.save(submission);

    const reloadedRepository = new IndexedDbSubmissionRepository(databaseName);
    const reloaded = await reloadedRepository.findById(submission.id);

    expect(reloaded?.id).toBe(submission.id);
    expect(reloaded?.originalText).toBe(submission.originalText);
  });
});
