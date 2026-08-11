import { describe, expect, it } from "vitest";
import { createTextSubmission, submissionStatusLabel } from "@/domain/submissions/submission";

const dependencies = {
  createId: () => "sub-001",
  now: () => new Date("2026-08-11T00:00:00.000Z"),
};

describe("createTextSubmission", () => {
  it("preserves the original text byte-for-byte while validating trimmed content", () => {
    const originalText = "  Meine Idee bleibt genau so.  ";
    const submission = createTextSubmission(
      { questionId: "question-001", originalText },
      dependencies,
    );

    expect(submission.originalText).toBe(originalText);
    expect(submission.id).toBe("sub-001");
    expect(submission.status).toBe("LOCAL_ONLY");
  });

  it("rejects whitespace-only answers", () => {
    expect(() =>
      createTextSubmission({ questionId: "question-001", originalText: "   " }, dependencies),
    ).toThrow("originalText must not be blank");
  });

  it("maps local status to the exact child-facing wording", () => {
    expect(submissionStatusLabel("LOCAL_ONLY")).toBe("Nur auf diesem Ger\u00e4t gespeichert");
  });
});
