import { describe, expect, it } from "vitest";
import {
  acknowledgeSubmission,
  createTextSubmission,
  submissionStatusLabel,
} from "@/domain/submissions/submission";

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

describe("acknowledgeSubmission", () => {
  const submission = createTextSubmission(
    { questionId: "companion-animal", originalText: "  Mein Tier ist ein Steinwolf.  " },
    dependencies,
  );

  it("marks the submission as server acknowledged without touching the original text", () => {
    const acknowledged = acknowledgeSubmission(submission, {
      receiptId: "receipt-001",
      receivedAt: "2026-08-11T10:00:00.000Z",
    });

    expect(acknowledged.status).toBe("SERVER_ACKNOWLEDGED");
    expect(acknowledged.originalText).toBe(submission.originalText);
    expect(acknowledged.id).toBe(submission.id);
    expect(acknowledged.createdAt).toBe(submission.createdAt);
    expect(acknowledged.receipt).toEqual({
      receiptId: "receipt-001",
      receivedAt: "2026-08-11T10:00:00.000Z",
    });
  });

  it("refuses to acknowledge without a real receipt id", () => {
    expect(() =>
      acknowledgeSubmission(submission, {
        receiptId: "   ",
        receivedAt: "2026-08-11T10:00:00.000Z",
      }),
    ).toThrow("receiptId must not be blank");
  });

  it("refuses to acknowledge without a real receipt timestamp", () => {
    expect(() =>
      acknowledgeSubmission(submission, { receiptId: "receipt-001", receivedAt: "" }),
    ).toThrow("receivedAt must not be blank");
  });

  it("leaves the source submission untouched", () => {
    acknowledgeSubmission(submission, {
      receiptId: "receipt-001",
      receivedAt: "2026-08-11T10:00:00.000Z",
    });
    expect(submission.status).toBe("LOCAL_ONLY");
  });

  it("maps the acknowledged status to the exact child-facing wording", () => {
    expect(submissionStatusLabel("SERVER_ACKNOWLEDGED")).toBe("Im Projekt angekommen");
  });
});
