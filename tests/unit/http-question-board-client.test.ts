import { describe, expect, it } from "vitest";
import { HttpQuestionBoardClient } from "@/adapters/http/http-question-board-client";
import type { QuestionBoardPage } from "@/application/questions/question-board-client";

/**
 * The browser side of the question board (MCL-35), exercised without a browser and
 * without a server.
 *
 * What this file is really about is the two answers that are NOT failures and not
 * successes either: a 409, which means somebody changed the question first, and a
 * positive answer whose body does not say what state the question ended up in. Both are
 * easy to turn into a wrong claim on screen, and both are pinned here.
 */

const PAGE: QuestionBoardPage = {
  questions: [{ id: "companion-animal", title: "Welches Tier?", state: "open", active: true }],
  history: [],
  historyTotal: 0,
};

type Call = { url: string; init: RequestInit | undefined };

function clientAnswering(
  answer: (call: Call) => Response | Promise<Response>,
): { client: HttpQuestionBoardClient; calls: Call[] } {
  const calls: Call[] = [];

  const client = new HttpQuestionBoardClient({
    fetchImplementation: (input, init) => {
      const call = { url: String(input), init };
      calls.push(call);
      return Promise.resolve(answer(call));
    },
  });

  return { client, calls };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("HttpQuestionBoardClient.list", () => {
  it("returns the board a signed-in adult is entitled to", async () => {
    const { client, calls } = clientAnswering(() => json(PAGE, 200));

    await expect(client.list()).resolves.toEqual({ outcome: "granted", page: PAGE });
    expect(calls[0].url).toBe("/api/admin/questions");
    expect(calls[0].init?.method).toBe("GET");
    // The session is an HttpOnly cookie the browser attaches; this client never holds it.
    expect(calls[0].init?.credentials).toBe("same-origin");
  });

  it("treats a positive answer that is not a board as no answer at all", async () => {
    // A captive portal, an SSO consent page or a proxy can all return valid JSON with a
    // 200. Passing that on as `granted` would render a board with no questions on it,
    // which reads as "every question is closed".
    const { client } = clientAnswering(() => json({ hello: "there" }, 200));

    await expect(client.list()).resolves.toEqual({ outcome: "transport" });
  });

  it.each([
    [401, "denied"],
    [429, "rate-limited"],
    [503, "unavailable"],
    [500, "transport"],
    [404, "transport"],
  ] as const)("maps %i to %s", async (status, outcome) => {
    const { client } = clientAnswering(() => json({ error: "whatever" }, status));

    await expect(client.list()).resolves.toEqual({ outcome });
  });

  it("reports a request that never arrived as retryable", async () => {
    const client = new HttpQuestionBoardClient({
      fetchImplementation: () => Promise.reject(new TypeError("network down")),
    });

    await expect(client.list()).resolves.toEqual({ outcome: "transport" });
  });
});

describe("HttpQuestionBoardClient.change", () => {
  it("asks to close a question and reports the state the server confirmed", async () => {
    const { client, calls } = clientAnswering(() => json({ state: "closed" }, 200));

    await expect(client.change("companion-animal", "closed", "open")).resolves.toEqual({
      outcome: "applied",
      state: "closed",
    });

    expect(calls[0].url).toBe("/api/admin/questions/companion-animal");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      action: "close",
      expectedState: "open",
    });
  });

  it("asks to reopen a question, stating what it believed the state was", async () => {
    const { client, calls } = clientAnswering(() => json({ state: "open" }, 200));

    await client.change("companion-animal", "open", "closed");

    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      action: "reopen",
      expectedState: "closed",
    });
  });

  it("escapes a question id rather than pasting it into the path", async () => {
    const { client, calls } = clientAnswering(() => json({ state: "closed" }, 200));

    await client.change("a/../b", "closed", "open");

    expect(calls[0].url).toBe("/api/admin/questions/a%2F..%2Fb");
  });

  it("refuses to claim a state the answer did not carry", async () => {
    // The state comes from the SERVER, never from what this client asked for. Assuming
    // the request succeeded would put a state on the board that nothing confirmed.
    const { client } = clientAnswering(() => json({ ok: true }, 200));

    await expect(client.change("companion-animal", "closed", "open")).resolves.toEqual({
      outcome: "transport",
    });
  });

  it("reports a conflict with the state that actually holds", async () => {
    const { client } = clientAnswering(() =>
      json({ error: "stale-state", currentState: "closed" }, 409),
    );

    await expect(client.change("companion-animal", "closed", "open")).resolves.toEqual({
      outcome: "stale",
      currentState: "closed",
    });
  });

  it("does not invent a current state when the conflict body cannot be read", async () => {
    // Still "somebody got there first", but this client does not know what holds - and
    // showing a guessed state is exactly the mistake the concurrency contract exists to
    // avoid.
    const { client } = clientAnswering(
      () => new Response("<html>proxy</html>", { status: 409 }),
    );

    await expect(client.change("companion-animal", "closed", "open")).resolves.toEqual({
      outcome: "transport",
    });
  });

  it.each([
    [400, "invalid-request"],
    [401, "denied"],
    [429, "rate-limited"],
    [503, "unavailable"],
    [500, "transport"],
  ] as const)("maps %i to %s", async (status, outcome) => {
    const { client } = clientAnswering(() => json({ error: "whatever" }, status));

    await expect(client.change("companion-animal", "closed", "open")).resolves.toEqual({
      outcome,
    });
  });

  it("reports a request that never arrived as retryable", async () => {
    const client = new HttpQuestionBoardClient({
      fetchImplementation: () => Promise.reject(new TypeError("network down")),
    });

    await expect(client.change("companion-animal", "closed", "open")).resolves.toEqual({
      outcome: "transport",
    });
  });
});
