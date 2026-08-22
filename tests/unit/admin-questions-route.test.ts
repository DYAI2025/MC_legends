import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as boardRoute from "@/app/api/admin/questions/route";
import * as changeRoute from "@/app/api/admin/questions/[questionId]/route";
import { GET } from "@/app/api/admin/questions/route";
import { POST } from "@/app/api/admin/questions/[questionId]/route";
import { HmacFamilyAccessGate } from "@/adapters/access/hmac-family-access-gate";
import { FileQuestionLifecycleLog } from "@/adapters/persistence/file-question-lifecycle-log";
import { ADMIN_SESSION_COOKIE } from "@/adapters/http/admin-session-cookie";
import { FAMILY_SESSION_COOKIE } from "@/adapters/http/family-session-cookie";
import type { QuestionBoardPage } from "@/application/questions/question-board-client";
import { focusQuestion, openQuestions } from "@/content/open-questions";
import { resetRateLimitersForTest } from "@/composition/server";
import { TEST_FAMILY_ACCESS_CODE } from "../support/family-access-code";
import { expectChildSafe } from "../support/child-safe";

/**
 * The one write in MCL-35, and the read that feeds it (tests/unit).
 *
 * Three things this file exists to pin, none of which a happy path shows:
 *
 * 1. The verb is behind the ADULT identity. A family session - a real one, minted
 *    through the real gate - is refused here exactly as an anonymous caller is. That is
 *    the countertest: a route that merely checked "some session" would pass every other
 *    case in this file.
 * 2. A caller acting on a state that has moved is refused with 409 and told what holds,
 *    rather than silently overwriting a newer decision.
 * 3. An unreadable store fails CLOSED. An adult must never be able to close a question
 *    from a guess about its state.
 */

const BOARD = "http://localhost/api/admin/questions";
const ADMIN_CODE = "ein-eigener-admin-code-nur-fuer-erwachsene";
const SESSION_SECRET = "test-session-secret";

const [FIRST, SECOND] = openQuestions;

let directory = "";
let adminCookie = "";
let familyCookie = "";

function cookieFor(name: string, accessCode: string): string {
  const grant = new HmacFamilyAccessGate({
    accessCode,
    sessionSecret: SESSION_SECRET,
  }).openSession(accessCode);
  if (grant.outcome !== "granted") {
    throw new Error("fixture could not open a session");
  }
  return `${name}=${grant.session.value}`;
}

function get(headers: Record<string, string> = {}): Request {
  return new Request(BOARD, { method: "GET", headers: { cookie: adminCookie, ...headers } });
}

/**
 * A Request built in-process carries no content-length - only a real HTTP client sets
 * one - so every case that wants the normal path declares it explicitly.
 */
function change(
  questionId: string,
  body: unknown,
  headers: Record<string, string> = {},
): { request: Request; context: { params: Promise<{ questionId: string }> } } {
  const payload = JSON.stringify(body);

  return {
    request: new Request(`${BOARD}/${encodeURIComponent(questionId)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(payload, "utf8")),
        cookie: adminCookie,
        ...headers,
      },
      body: payload,
    }),
    context: { params: Promise.resolve({ questionId }) },
  };
}

async function post(
  questionId: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const { request, context } = change(questionId, body, headers);
  return POST(request, context);
}

async function board(): Promise<QuestionBoardPage> {
  const response = await GET(get());
  expect(response.status).toBe(200);
  return (await response.json()) as QuestionBoardPage;
}

function stateOf(page: QuestionBoardPage, id: string): string | undefined {
  return page.questions.find((entry) => entry.id === id)?.state;
}

function activeIdOf(page: QuestionBoardPage): string | undefined {
  return page.questions.find((entry) => entry.active)?.id;
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "avaloria-admin-questions-"));
  resetRateLimitersForTest();
  vi.stubEnv("AVALORIA_ADMIN_ACCESS_CODE", ADMIN_CODE);
  vi.stubEnv("AVALORIA_FAMILY_ACCESS_CODE", TEST_FAMILY_ACCESS_CODE);
  vi.stubEnv("AVALORIA_SESSION_SECRET", SESSION_SECRET);
  vi.stubEnv("AVALORIA_QUESTION_DIR", directory);
  vi.stubEnv("DATABASE_URL", undefined);
  adminCookie = cookieFor(ADMIN_SESSION_COOKIE, ADMIN_CODE);
  familyCookie = cookieFor(FAMILY_SESSION_COOKIE, TEST_FAMILY_ACCESS_CODE);
});

afterEach(async () => {
  // unstubAllEnvs and nothing else - reassigning process.env swaps the object vitest
  // recorded its stubs against, and the next test's unset silently stops unsetting.
  vi.unstubAllEnvs();
  resetRateLimitersForTest();
  await rm(directory, { recursive: true, force: true });
});

describe("GET /api/admin/questions", () => {
  it("lists every question with the seeded one marked active", async () => {
    const page = await board();

    expect(page.questions.map((entry) => entry.id)).toEqual(
      openQuestions.map((question) => question.id),
    );
    expect(activeIdOf(page)).toBe(focusQuestion().id);
    expect(page.history).toEqual([]);
    expect(page.historyTotal).toBe(0);
  });

  it("refuses an anonymous caller - there is no public board", async () => {
    const response = await GET(new Request(BOARD, { method: "GET" }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("refuses a real family session, which is the credential children hold", async () => {
    // The countertest. A route that checked "is there a valid session" rather than "is
    // this the adult one" would pass every other case in this file and let any child who
    // knows the family code retire a question for everybody.
    const response = await GET(get({ cookie: familyCookie }));

    expect(response.status).toBe(401);
  });

  it("fails closed when no admin code is configured", async () => {
    vi.stubEnv("AVALORIA_ADMIN_ACCESS_CODE", undefined);

    const response = await GET(get());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "questions-unavailable" });
  });

  it("reports the store as unavailable rather than guessing at the state", async () => {
    await writeFile(join(directory, "question-lifecycle.jsonl"), "{not json}\n", "utf8");

    const response = await GET(get());

    expect(response.status).toBe(503);
    // A bare code: no path, no line number, nothing about the store.
    expect(await response.json()).toEqual({ error: "questions-unavailable" });
  });

  it("exports no verb that could change a question from this path", async () => {
    // The board is a listing. The verb lives one segment deeper, so a client can only
    // ever change a question it has named.
    expect("POST" in boardRoute).toBe(false);
    expect("DELETE" in boardRoute).toBe(false);
    expect("PATCH" in boardRoute).toBe(false);
  });
});

describe("POST /api/admin/questions/[questionId]", () => {
  it("closes a question and hands the turn to the next one", async () => {
    const response = await post(FIRST.id, { action: "close", expectedState: "open" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "closed" });

    const page = await board();
    expect(stateOf(page, FIRST.id)).toBe("closed");
    expect(activeIdOf(page)).toBe(SECOND.id);
  });

  it("keeps the close in the archive and names the question in words", async () => {
    await post(FIRST.id, { action: "close", expectedState: "open" });
    await post(FIRST.id, { action: "reopen", expectedState: "closed" });

    const page = await board();

    expect(page.history.map((entry) => entry.action)).toEqual(["reopened", "closed"]);
    expect(page.historyTotal).toBe(2);
    // The wording, resolved on the server. The board never has to look a title up, so it
    // cannot show one from a dataset the events do not belong to.
    expect(page.history[1].title).toBe(FIRST.title);
    expect(page.history[1].questionId).toBe(FIRST.id);
  });

  it("does not let a reopened question take the turn back", async () => {
    await post(FIRST.id, { action: "close", expectedState: "open" });
    await post(FIRST.id, { action: "reopen", expectedState: "closed" });

    const page = await board();

    // The child is being asked SECOND, and reopening FIRST must not change that
    // underneath them: the answer somebody is halfway through writing would otherwise
    // become an answer to a question the page no longer shows.
    expect(activeIdOf(page)).toBe(SECOND.id);
    expect(stateOf(page, FIRST.id)).toBe("open");
  });

  it("refuses a caller working from a state that has moved", async () => {
    await post(FIRST.id, { action: "close", expectedState: "open" });

    const response = await post(FIRST.id, { action: "close", expectedState: "open" });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "stale-state", currentState: "closed" });
    // And nothing was written for the refused attempt.
    expect((await board()).historyTotal).toBe(1);
  });

  it("refuses a question the dataset does not know, and writes nothing", async () => {
    const response = await post("a-question-nobody-wrote", {
      action: "close",
      expectedState: "open",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid-request" });
    expect(await new FileQuestionLifecycleLog(directory).history()).toEqual([]);
  });

  it.each([
    ["an unknown action", { action: "archive", expectedState: "open" }],
    ["a missing expected state", { action: "close" }],
    ["an unknown expected state", { action: "close", expectedState: "retired" }],
    ["an array", []],
    ["a bare string", "close"],
  ])("refuses %s", async (_name, body) => {
    const response = await post(FIRST.id, body);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid-request" });
  });

  it("refuses an anonymous caller", async () => {
    const payload = JSON.stringify({ action: "close", expectedState: "open" });
    const response = await POST(
      new Request(`${BOARD}/${FIRST.id}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(payload, "utf8")),
        },
        body: payload,
      }),
      { params: Promise.resolve({ questionId: FIRST.id }) },
    );

    expect(response.status).toBe(401);
    expect(await new FileQuestionLifecycleLog(directory).history()).toEqual([]);
  });

  it("refuses a real family session and writes nothing", async () => {
    const response = await post(
      FIRST.id,
      { action: "close", expectedState: "open" },
      { cookie: familyCookie },
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    // The one that matters: refused AND nothing recorded. A route that answered 401
    // after appending would be worse than one that answered 200.
    expect(await new FileQuestionLifecycleLog(directory).history()).toEqual([]);
  });

  it("fails closed when no admin code is configured", async () => {
    vi.stubEnv("AVALORIA_ADMIN_ACCESS_CODE", undefined);

    const response = await post(FIRST.id, { action: "close", expectedState: "open" });

    expect(response.status).toBe(503);
    expect(await new FileQuestionLifecycleLog(directory).history()).toEqual([]);
  });

  it("fails closed rather than acting on a state nobody could read", async () => {
    await writeFile(join(directory, "question-lifecycle.jsonl"), "{not json}\n", "utf8");

    const response = await post(FIRST.id, { action: "close", expectedState: "open" });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "questions-unavailable" });
  });

  it("stops a caller who presses far too often", async () => {
    vi.stubEnv("AVALORIA_ADMIN_RATE_LIMIT", "2");
    resetRateLimitersForTest();

    await post(FIRST.id, { action: "close", expectedState: "open" });
    await post(FIRST.id, { action: "reopen", expectedState: "closed" });
    const response = await post(FIRST.id, { action: "close", expectedState: "open" });

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "too-many-requests" });
  });

  it("never answers with anything but a machine-readable code", async () => {
    await writeFile(join(directory, "question-lifecycle.jsonl"), "{not json}\n", "utf8");

    for (const response of [
      await GET(get()),
      await post(FIRST.id, { action: "close", expectedState: "open" }),
    ]) {
      const body = await response.text();

      expect(body).not.toContain(directory);
      expect(body).not.toContain(ADMIN_CODE);
      expect(body).not.toContain(TEST_FAMILY_ACCESS_CODE);
      expect(body).not.toMatch(/at .*\.ts:/u);
      expect(body.length).toBeLessThan(200);
    }
  });

  it("exports no way to delete a question", async () => {
    // A question is never removed - the archive is the point - so the verb does not
    // exist rather than existing and refusing.
    expect("DELETE" in changeRoute).toBe(false);
    expect("PUT" in changeRoute).toBe(false);
  });
});

describe("the board's own wording", () => {
  it("puts nothing in front of an adult that would be unsafe in front of a child", async () => {
    // The board is an adult surface, so this is not the child-safety gate - but the
    // TITLES on it are the same strings children read, and a title that failed here
    // would be one this dataset should never have carried.
    for (const entry of (await board()).questions) {
      expectChildSafe(entry.title, entry.id);
    }
  });
});
