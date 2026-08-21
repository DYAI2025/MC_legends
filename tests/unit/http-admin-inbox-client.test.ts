import { describe, expect, it } from "vitest";
import { HttpAdminInboxClient } from "@/adapters/http/http-admin-inbox-client";
import type { InboxPage } from "@/application/submissions/submission-inbox-reader";
import { asTextEntry } from "../support/text-submission-shape";

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
    expect(asTextEntry(result.page.entries[0]).originalText).toBe("  ein drache mit  zwei koepfen  ");
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
    // The whole request line, not just its query. This route exports GET and nothing
    // else on purpose - the mutation verbs do not exist - so a client that sent POST
    // would collect a 405 and report it as `transport`, hiding a wiring bug behind a
    // message about the network.
    expect(captured.init?.method).toBe("GET");
  });

  it("round-trips the page size", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const client = new HttpAdminInboxClient({ fetchImplementation: okFetch(captured) });

    await client.list({ limit: 25 });

    const url = new URL(captured.url ?? "", "http://localhost");
    expect(url.searchParams.get("limit")).toBe("25");
  });

  it.each(["", "   "])("treats a blank questionId (%j) as no filter at all", async (questionId) => {
    const captured: { url?: string; init?: RequestInit } = {};
    const client = new HttpAdminInboxClient({ fetchImplementation: okFetch(captured) });

    await client.list({ questionId });

    const url = new URL(captured.url ?? "", "http://localhost");
    // questionId is the only free-text filter, so it is the one that arrives as "" from
    // an empty input element. The route refuses a blank one with 400, and an adult who
    // cleared the search box has not asked an invalid question - they have asked for no
    // filter. Handled here rather than trusted to every caller.
    expect(url.searchParams.has("questionId")).toBe(false);
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

  it("keeps its never-throws promise when a replaced fetch resolves no response", async () => {
    // The port documents that this method never throws, and the default implementation
    // resolves the global fetch at call time - so a page or a test that monkey-patches
    // window.fetch and forgets to return its value decides whether that promise holds.
    // Pinned here because the invariant is a doc claim, and a doc claim the code does not
    // keep is worse than no comment: the caller writes no error path for it.
    const client = new HttpAdminInboxClient({
      fetchImplementation: async () => undefined as unknown as Response,
    });

    await expect(client.list({})).resolves.toEqual({ outcome: "transport" });
  });

  it("reports transport rather than throwing when the body is unreadable", async () => {
    const client = new HttpAdminInboxClient({
      fetchImplementation: async () => new Response("not json", { status: 200 }),
    });

    await expect(client.list({})).resolves.toEqual({ outcome: "transport" });
  });

  it.each([
    ["null", "null"],
    ["an empty object", "{}"],
    ["a total that is not a number", '{"entries":[],"total":"lots"}'],
    ["entries that are not a list", '{"entries":{},"total":1}'],
  ])("refuses a 200 whose body is not an inbox page (%s)", async (_name, body) => {
    // A 200 is not proof the inbox answered. A captive portal, an SSO consent page or a
    // proxy can all return valid JSON of the wrong shape, and handing that to the view as
    // `granted` is how "3 answers" appears when there are 300 - the exact failure the
    // reader port's own doc calls worse than no number at all. Envelope only: the entries
    // themselves stay the server's business.
    const client = new HttpAdminInboxClient({
      fetchImplementation: async () =>
        new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
    });

    await expect(client.list({})).resolves.toEqual({ outcome: "transport" });
  });
});
