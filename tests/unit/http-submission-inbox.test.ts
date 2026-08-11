import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpSubmissionInbox } from "@/adapters/http/http-submission-inbox";
import { createBrowserSubmissionInbox } from "@/composition/browser";
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
        201,
      ),
    );

    const inbox = new HttpSubmissionInbox({ endpoint: "/api/inbox/submissions", fetchImplementation });
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
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("trims a padded receipt rather than carrying the padding onward", async () => {
    const { fetchImplementation } = recordingFetch(async () =>
      jsonResponse(
        { acknowledged: true, receiptId: "  receipt-001  ", receivedAt: "  2026-08-11T10:00:00.000Z  " },
        201,
      ),
    );

    const inbox = new HttpSubmissionInbox({ endpoint: "/api/inbox/submissions", fetchImplementation });

    await expect(inbox.deliver(submission)).resolves.toEqual({
      receiptId: "receipt-001",
      receivedAt: "2026-08-11T10:00:00.000Z",
    });
  });

  it("throws when the server refuses the submission", async () => {
    const { fetchImplementation } = recordingFetch(async () =>
      jsonResponse({ acknowledged: false, error: "invalid-payload" }, 400),
    );

    const inbox = new HttpSubmissionInbox({ endpoint: "/api/inbox/submissions", fetchImplementation });

    await expect(inbox.deliver(submission)).rejects.toThrow(NOT_ACKNOWLEDGED);
    await expect(inbox.deliver(submission)).rejects.toMatchObject({ reason: "refused" });
  });

  it("calls a server error transport, because a later attempt can still work", async () => {
    const { fetchImplementation } = recordingFetch(async () =>
      jsonResponse({ acknowledged: false, error: "inbox-unavailable" }, 503),
    );

    const inbox = new HttpSubmissionInbox({ endpoint: "/api/inbox/submissions", fetchImplementation });

    await expect(inbox.deliver(submission)).rejects.toMatchObject({ reason: "transport" });
  });

  it(
    "gives up on a server that never answers",
    async () => {
      // Honours the abort signal the way a real transport does: if the adapter passes
      // none, this promise never settles and the test times out instead of passing.
      const inbox = new HttpSubmissionInbox({
        endpoint: "/api/inbox/submissions",
        timeoutMs: 10,
        fetchImplementation: (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("The operation was aborted.", "AbortError")),
            );
          }),
      });

      await expect(inbox.deliver(submission)).rejects.toThrow(NOT_ACKNOWLEDGED);
    },
    2000,
  );

  it("throws when the server answers 201 without acknowledging", async () => {
    const { fetchImplementation } = recordingFetch(async () =>
      jsonResponse(
        { acknowledged: false, receiptId: "receipt-001", receivedAt: "2026-08-11T10:00:00.000Z" },
        201,
      ),
    );

    const inbox = new HttpSubmissionInbox({ endpoint: "/api/inbox/submissions", fetchImplementation });

    await expect(inbox.deliver(submission)).rejects.toThrow(NOT_ACKNOWLEDGED);
  });

  it("throws when the server answers 201 with a blank receipt id", async () => {
    const { fetchImplementation } = recordingFetch(async () =>
      jsonResponse(
        { acknowledged: true, receiptId: "   ", receivedAt: "2026-08-11T10:00:00.000Z" },
        201,
      ),
    );

    const inbox = new HttpSubmissionInbox({ endpoint: "/api/inbox/submissions", fetchImplementation });

    await expect(inbox.deliver(submission)).rejects.toThrow(NOT_ACKNOWLEDGED);
  });

  it("throws when the server answers 201 with a missing receipt timestamp", async () => {
    const { fetchImplementation } = recordingFetch(async () =>
      jsonResponse({ acknowledged: true, receiptId: "receipt-001" }, 201),
    );

    const inbox = new HttpSubmissionInbox({ endpoint: "/api/inbox/submissions", fetchImplementation });

    await expect(inbox.deliver(submission)).rejects.toThrow(NOT_ACKNOWLEDGED);
  });

  it("throws when the server answers 201 with an unreadable body", async () => {
    const { fetchImplementation } = recordingFetch(
      async () => new Response("not json at all", { status: 201 }),
    );

    const inbox = new HttpSubmissionInbox({ endpoint: "/api/inbox/submissions", fetchImplementation });

    await expect(inbox.deliver(submission)).rejects.toThrow(NOT_ACKNOWLEDGED);
  });

  it("throws the same failure when the transport itself rejects, keeping the cause", async () => {
    const transportError = new TypeError("Failed to fetch");
    const inbox = new HttpSubmissionInbox({
      endpoint: "/api/inbox/submissions",
      fetchImplementation: async () => {
        throw transportError;
      },
    });

    await expect(inbox.deliver(submission)).rejects.toThrow(NOT_ACKNOWLEDGED);
    await expect(inbox.deliver(submission)).rejects.toMatchObject({
      cause: transportError,
      reason: "transport",
    });
  });
});

describe("createBrowserSubmissionInbox", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts to the real default endpoint through the global fetch", async () => {
    // The one path production actually takes: both defaults, nothing injected. Every
    // other test names the endpoint, so a typo in it would otherwise stay invisible
    // until a child pressed the button.
    let requested: RequestInfo | URL | undefined;
    const fetchSpy = vi.fn(async (...args: [RequestInfo | URL, RequestInit?]) => {
      requested = args[0];
      return jsonResponse(
        { acknowledged: true, receiptId: "receipt-001", receivedAt: "2026-08-11T10:00:00.000Z" },
        201,
      );
    });
    vi.stubGlobal("fetch", fetchSpy);

    const receipt = await createBrowserSubmissionInbox().deliver(submission);

    expect(receipt).toEqual({
      receiptId: "receipt-001",
      receivedAt: "2026-08-11T10:00:00.000Z",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(requested).toBe("/api/inbox/submissions");
  });
});
