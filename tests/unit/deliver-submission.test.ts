import { describe, expect, it } from "vitest";
import { deliverSubmission } from "@/application/submissions/deliver-submission";
import type { SubmissionInbox } from "@/application/submissions/submission-inbox";
import type { SubmissionRepository } from "@/application/submissions/submission-repository";
import {
  createTextSubmission,
  type ServerReceipt,
  type SubmissionId,
  type TextSubmission,
} from "@/domain/submissions/submission";

const dependencies = {
  createId: () => "sub-042",
  now: () => new Date("2026-08-11T00:00:00.000Z"),
};

const ORIGINAL_TEXT = "  Der Steinwolf trägt eine Laterne.  ";

class InMemorySubmissionRepository implements SubmissionRepository {
  private readonly submissions = new Map<SubmissionId, TextSubmission>();

  async save(submission: TextSubmission): Promise<void> {
    this.submissions.set(submission.id, submission);
  }

  async findById(id: SubmissionId): Promise<TextSubmission | null> {
    return this.submissions.get(id) ?? null;
  }

  async list(): Promise<readonly TextSubmission[]> {
    return [...this.submissions.values()];
  }
}

function newSubmission(): TextSubmission {
  return createTextSubmission(
    { questionId: "companion-animal", originalText: ORIGINAL_TEXT },
    dependencies,
  );
}

async function storedSubmission(
  repository: SubmissionRepository,
  submission: TextSubmission,
): Promise<TextSubmission> {
  const stored = await repository.findById(submission.id);
  if (stored === null) {
    throw new Error("expected the submission to be stored");
  }
  return stored;
}

describe("deliverSubmission", () => {
  it("persists the server acknowledged copy when the inbox returns a real receipt", async () => {
    const submission = newSubmission();
    const repository = new InMemorySubmissionRepository();
    await repository.save(submission);

    const inbox: SubmissionInbox = {
      async deliver(): Promise<ServerReceipt> {
        return { receiptId: "receipt-777", receivedAt: "2026-08-11T10:00:00.000Z" };
      },
    };

    const outcome = await deliverSubmission(submission, repository, inbox);

    expect(outcome.delivered).toBe(true);
    expect(outcome.submission.status).toBe("SERVER_ACKNOWLEDGED");
    expect(outcome.submission.originalText).toBe(ORIGINAL_TEXT);

    const stored = await storedSubmission(repository, submission);
    expect(stored.status).toBe("SERVER_ACKNOWLEDGED");
    expect(stored.originalText).toBe(ORIGINAL_TEXT);
    expect(stored.receipt).toEqual({
      receiptId: "receipt-777",
      receivedAt: "2026-08-11T10:00:00.000Z",
    });
  });

  it("keeps the stored submission local when the inbox throws", async () => {
    const submission = newSubmission();
    const repository = new InMemorySubmissionRepository();
    await repository.save(submission);

    const inbox: SubmissionInbox = {
      async deliver(): Promise<ServerReceipt> {
        throw new Error("inbox did not acknowledge the submission");
      },
    };

    const outcome = await deliverSubmission(submission, repository, inbox);

    expect(outcome.delivered).toBe(false);
    expect(outcome.submission).toBe(submission);

    const stored = await storedSubmission(repository, submission);
    expect(stored.status).toBe("LOCAL_ONLY");
    expect(stored.originalText).toBe(ORIGINAL_TEXT);
    expect(stored.receipt).toBeUndefined();
  });

  it("refuses to acknowledge when the inbox answers with a blank receipt", async () => {
    const submission = newSubmission();
    const repository = new InMemorySubmissionRepository();
    await repository.save(submission);

    const inbox: SubmissionInbox = {
      async deliver(): Promise<ServerReceipt> {
        return { receiptId: "   ", receivedAt: "2026-08-11T10:00:00.000Z" };
      },
    };

    const outcome = await deliverSubmission(submission, repository, inbox);

    expect(outcome.delivered).toBe(false);
    expect(outcome.submission.status).toBe("LOCAL_ONLY");

    const stored = await storedSubmission(repository, submission);
    expect(stored.status).toBe("LOCAL_ONLY");
    expect(stored.receipt).toBeUndefined();
  });

  it("refuses to acknowledge when the inbox answers with a blank receipt timestamp", async () => {
    const submission = newSubmission();
    const repository = new InMemorySubmissionRepository();
    await repository.save(submission);

    const inbox: SubmissionInbox = {
      async deliver(): Promise<ServerReceipt> {
        return { receiptId: "receipt-777", receivedAt: "" };
      },
    };

    const outcome = await deliverSubmission(submission, repository, inbox);

    expect(outcome.delivered).toBe(false);

    const stored = await storedSubmission(repository, submission);
    expect(stored.status).toBe("LOCAL_ONLY");
    expect(stored.receipt).toBeUndefined();
  });

  it("reports a failed delivery when the local save fails after a real acknowledgement", async () => {
    const submission = newSubmission();

    class RejectingOnAcknowledgedRepository extends InMemorySubmissionRepository {
      override async save(candidate: TextSubmission): Promise<void> {
        if (candidate.status === "SERVER_ACKNOWLEDGED") {
          throw new Error("IndexedDB save failed");
        }
        await super.save(candidate);
      }
    }

    const repository = new RejectingOnAcknowledgedRepository();
    await repository.save(submission);

    const inbox: SubmissionInbox = {
      async deliver(): Promise<ServerReceipt> {
        return { receiptId: "receipt-779", receivedAt: "2026-08-11T10:10:00.000Z" };
      },
    };

    const outcome = await deliverSubmission(submission, repository, inbox);

    // Understating what arrived is the accepted direction: never tell a child an
    // answer reached the project when this device could not record that it did.
    expect(outcome.delivered).toBe(false);
    expect(outcome.submission).toBe(submission);
    expect(outcome.submission.status).toBe("LOCAL_ONLY");

    const stored = await storedSubmission(repository, submission);
    expect(stored.status).toBe("LOCAL_ONLY");
    expect(stored.originalText).toBe(ORIGINAL_TEXT);
    expect(stored.receipt).toBeUndefined();
  });

  it("acknowledges on a retry after a first failed delivery", async () => {
    const submission = newSubmission();
    const repository = new InMemorySubmissionRepository();
    await repository.save(submission);

    let attempts = 0;
    const inbox: SubmissionInbox = {
      async deliver(): Promise<ServerReceipt> {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("inbox did not acknowledge the submission");
        }
        return { receiptId: "receipt-778", receivedAt: "2026-08-11T10:05:00.000Z" };
      },
    };

    const first = await deliverSubmission(submission, repository, inbox);
    expect(first.delivered).toBe(false);
    expect((await storedSubmission(repository, submission)).status).toBe("LOCAL_ONLY");

    const second = await deliverSubmission(first.submission, repository, inbox);
    expect(second.delivered).toBe(true);
    expect(attempts).toBe(2);

    const stored = await storedSubmission(repository, submission);
    expect(stored.status).toBe("SERVER_ACKNOWLEDGED");
    expect(stored.originalText).toBe(ORIGINAL_TEXT);
    expect(stored.receipt).toEqual({
      receiptId: "receipt-778",
      receivedAt: "2026-08-11T10:05:00.000Z",
    });
  });
});
