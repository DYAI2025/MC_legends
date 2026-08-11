import { describe, expect, it } from "vitest";
import {
  acknowledgeSubmission,
  createTextSubmission,
  hasArrivedInProject,
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

  it("stores a padded receipt without its padding", () => {
    const acknowledged = acknowledgeSubmission(submission, {
      receiptId: "  receipt-001  ",
      receivedAt: "  2026-08-11T10:00:00.000Z  ",
    });

    expect(acknowledged.receipt).toEqual({
      receiptId: "receipt-001",
      receivedAt: "2026-08-11T10:00:00.000Z",
    });
    // The submitted text is the opposite rule and keeps every space it arrived with.
    expect(acknowledged.originalText).toBe(submission.originalText);
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

/**
 * The child view has to branch on arrival - one status gets the arrived wording, the
 * other gets a retry button. Only this module may name the acknowledged status
 * literal (tests/architecture/boundaries.test.ts), so the branch itself lives here
 * instead of being re-derived from a string comparison in the UI.
 */
describe("hasArrivedInProject", () => {
  it("is true only for a status the domain produced from a real receipt", () => {
    const submission = createTextSubmission(
      { questionId: "companion-animal", originalText: "Mein Tier ist ein Steinwolf." },
      dependencies,
    );
    const acknowledged = acknowledgeSubmission(submission, {
      receiptId: "receipt-001",
      receivedAt: "2026-08-11T10:00:00.000Z",
    });

    expect(hasArrivedInProject(submission.status)).toBe(false);
    expect(hasArrivedInProject(acknowledged.status)).toBe(true);
  });

  it("agrees with the child-facing wording for every status", () => {
    expect(hasArrivedInProject("LOCAL_ONLY")).toBe(false);
    expect(submissionStatusLabel("LOCAL_ONLY")).toBe("Nur auf diesem Gerät gespeichert");
    expect(hasArrivedInProject("SERVER_ACKNOWLEDGED")).toBe(true);
    expect(submissionStatusLabel("SERVER_ACKNOWLEDGED")).toBe("Im Projekt angekommen");
  });
});
