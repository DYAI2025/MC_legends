import { describe, expect, it } from "vitest";
import { HttpAdminInboxClient } from "@/adapters/http/http-admin-inbox-client";
import type { InboxPage } from "@/application/submissions/submission-inbox-reader";

const page: InboxPage = {
  entries: [
    {
      submissionId: "sub-1",
      kind: "text",
      questionId: "companion-animal",
      createdAt: "2026-08-13T08:00:00.000Z",
      receivedAt: "2026-08-13T09:00:00.000Z",
      receiptId: "receipt-1",
      originalText: "  ein drache mit  zwei koepfen  ",
      status: "RECEIVED",
    },
  ],
  total: 1,
};

function okFetch(captured: { url?: string; init?: RequestInit }) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.url = String(input);
    captured.init = init;
    return new Response(JSON.stringify(page), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

describe("HttpAdminInboxClient", () => {
  it("returns the page and keeps the original text byte-identical", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const client = new HttpAdminInboxClient({ fetchImplementation: okFetch(captured) });

    const result = await client.list({});

    expect(result.outcome).toBe("granted");
    if (result.outcome !== "granted") return;
    // Not trimmed, not normalised: the whole point of the read side is that what an
    // adult sees is what the child sent.
    expect(result.page.entries[0].originalText).toBe("  ein drache mit  zwei koepfen  ");
    expect(result.page.total).toBe(1);
  });

  it("sends only the filters that were set, and sends the cookie", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const client = new HttpAdminInboxClient({ fetchImplementation: okFetch(captured) });

    await client.list({ status: "RECEIVED", questionId: "hidden-door" });

    const url = new URL(captured.url ?? "", "http://localhost");
    expect(url.pathname).toBe("/api/admin/inbox/submissions");
    expect(url.searchParams.get("status")).toBe("RECEIVED");
    expect(url.searchParams.get("questionId")).toBe("hidden-door");
    // Absent, not empty: "no constraint on kind" and "kind=" are different questions,
    // and the route refuses the second one.
    expect(url.searchParams.has("kind")).toBe(false);
    expect(captured.init?.credentials).toBe("same-origin");
  });

  it.each([
    [401, "denied"],
    [400, "invalid-query"],
    [429, "rate-limited"],
    [503, "unavailable"],
    [418, "transport"],
  ])("maps status %i to %s", async (status, outcome) => {
    const client = new HttpAdminInboxClient({
      fetchImplementation: async () => new Response("{}", { status }),
    });

    await expect(client.list({})).resolves.toEqual({ outcome });
  });

  it("reports transport when the request never gets an answer", async () => {
    const client = new HttpAdminInboxClient({
      fetchImplementation: async () => {
        throw new Error("network down");
      },
    });

    await expect(client.list({})).resolves.toEqual({ outcome: "transport" });
  });

  it("reports transport rather than throwing when the body is unreadable", async () => {
    const client = new HttpAdminInboxClient({
      fetchImplementation: async () => new Response("not json", { status: 200 }),
    });

    await expect(client.list({})).resolves.toEqual({ outcome: "transport" });
  });
});
