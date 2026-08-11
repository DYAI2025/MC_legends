import { describe, expect, it } from "vitest";
import { HttpSubmissionInbox } from "@/adapters/http/http-submission-inbox";
import { createTextSubmission, type TextSubmission } from "@/domain/submissions/submission";

const ORIGINAL_TEXT = "  Der Steinwolf trägt eine Laterne.  ";
const NOT_ACKNOWLEDGED = "inbox did not acknowledge the submission";

const submission: TextSubmission = createTextSubmission(
  { questionId: "companion-animal", originalText: ORIGINAL_TEXT },
  { createId: () => "sub-001", now: () => new Date("2026-08-11T00:00:00.000Z") },
);

type Call = Readonly<{ input: RequestInfo | URL; init?: RequestInit }>;

function recordingFetch(response: () => Promise<Response>): {
  calls: Call[];
  fetchImplementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
} {
  const calls: Call[] = [];
  return {
    calls,
    fetchImplementation: async (input, init) => {
      calls.push({ input, init });
      return response();
    },
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("HttpSubmissionInbox", () => {
  it("posts the unchanged original text and returns the receipt", async () => {
    const { calls, fetchImplementation } = recordingFetch(async () =>
      jsonResponse(
        { acknowledged: true, receiptId: "receipt-001", receivedAt: "2026-08-11T10:00:00.000Z" },
        202,
      ),
    );

    const inbox = new HttpSubmissionInbox("/api/inbox/submissions", fetchImplementation);
    const receipt = await inbox.deliver(submission);

    expect(receipt).toEqual({
      receiptId: "receipt-001",
      receivedAt: "2026-08-11T10:00:00.000Z",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe("/api/inbox/submissions");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      submissionId: "sub-001",
      questionId: "companion-animal",
      createdAt: "2026-08-11T00:00:00.000Z",
      originalText: ORIGINAL_TEXT,
    });
  });

  it("throws when the server refuses the submission", async () => {
    const { fetchImplementation } = recordingFetch(async () =>
      jsonResponse({ acknowledged: false, error: "invalid-payload" }, 400),
    );

    const inbox = new HttpSubmissionInbox("/api/inbox/submissions", fetchImplementation);

    await expect(inbox.deliver(submission)).rejects.toThrow(NOT_ACKNOWLEDGED);
  });

  it("throws when the server answers 202 without acknowledging", async () => {
    const { fetchImplementation } = recordingFetch(async () =>
      jsonResponse(
        { acknowledged: false, receiptId: "receipt-001", receivedAt: "2026-08-11T10:00:00.000Z" },
        202,
      ),
    );

    const inbox = new HttpSubmissionInbox("/api/inbox/submissions", fetchImplementation);

    await expect(inbox.deliver(submission)).rejects.toThrow(NOT_ACKNOWLEDGED);
  });

  it("throws when the server answers 202 with a blank receipt id", async () => {
    const { fetchImplementation } = recordingFetch(async () =>
      jsonResponse(
        { acknowledged: true, receiptId: "   ", receivedAt: "2026-08-11T10:00:00.000Z" },
        202,
      ),
    );

    const inbox = new HttpSubmissionInbox("/api/inbox/submissions", fetchImplementation);

    await expect(inbox.deliver(submission)).rejects.toThrow(NOT_ACKNOWLEDGED);
  });

  it("throws when the server answers 202 with a missing receipt timestamp", async () => {
    const { fetchImplementation } = recordingFetch(async () =>
      jsonResponse({ acknowledged: true, receiptId: "receipt-001" }, 202),
    );

    const inbox = new HttpSubmissionInbox("/api/inbox/submissions", fetchImplementation);

    await expect(inbox.deliver(submission)).rejects.toThrow(NOT_ACKNOWLEDGED);
  });

  it("throws when the server answers 202 with an unreadable body", async () => {
    const { fetchImplementation } = recordingFetch(
      async () => new Response("not json at all", { status: 202 }),
    );

    const inbox = new HttpSubmissionInbox("/api/inbox/submissions", fetchImplementation);

    await expect(inbox.deliver(submission)).rejects.toThrow(NOT_ACKNOWLEDGED);
  });

  it("throws the same failure when the transport itself rejects, keeping the cause", async () => {
    const transportError = new TypeError("Failed to fetch");
    const inbox = new HttpSubmissionInbox("/api/inbox/submissions", async () => {
      throw transportError;
    });

    await expect(inbox.deliver(submission)).rejects.toThrow(NOT_ACKNOWLEDGED);
    await expect(inbox.deliver(submission)).rejects.toMatchObject({ cause: transportError });
  });
});
