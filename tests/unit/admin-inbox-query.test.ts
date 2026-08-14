import { describe, expect, it } from "vitest";
import {
  buildInboxQuery,
  createLatestOnly,
  QUESTION_FILTER_DEBOUNCE_MS,
  type AdminFilterState,
} from "@/app/admin-inbox-query";

const empty: AdminFilterState = { status: "", kind: "", questionId: "" };

describe("buildInboxQuery", () => {
  it("asks for no constraint when nothing is selected", () => {
    expect(buildInboxQuery(empty)).toEqual({});
  });

  it("carries each selected filter through", () => {
    expect(
      buildInboxQuery({ status: "RECEIVED", kind: "text", questionId: "hidden-door" }),
    ).toEqual({ status: "RECEIVED", kind: "text", questionId: "hidden-door" });
  });

  it("treats a blank or whitespace question as no filter rather than as an empty one", () => {
    // The route refuses a blank questionId with 400. A user who cleared the box asked
    // for "all questions", not for an error.
    expect(buildInboxQuery({ ...empty, questionId: "   " })).toEqual({});
  });

  it("trims the question so a stray space does not silently match nothing", () => {
    expect(buildInboxQuery({ ...empty, questionId: "  hidden-door " })).toEqual({
      questionId: "hidden-door",
    });
  });

  it("keeps an over-long question so the server, not the browser, is the authority", () => {
    // Deliberately NOT clamped here. The route enforces the ceiling and answers 400;
    // a browser-side truncation would send a DIFFERENT query than the one asked for and
    // present its results as the answer.
    const long = "a".repeat(500);
    expect(buildInboxQuery({ ...empty, questionId: long })).toEqual({ questionId: long });
  });
});

describe("createLatestOnly", () => {
  // The ordering policy behind the admin read: two inbox reads can be in flight at once
  // and they can resolve in either order. Only the newest may reach the screen, because
  // an older page displayed under a newer filter shows a child's answers as the answer
  // to a question nobody asked.

  it("treats the only issued read as the current one", () => {
    const sequence = createLatestOnly();
    const only = sequence.issue();

    expect(sequence.isLatest(only)).toBe(true);
  });

  it("supersedes an earlier read as soon as a later one is issued", () => {
    const sequence = createLatestOnly();
    const first = sequence.issue();
    const second = sequence.issue();

    // This is the whole point: `first` resolving last must not be allowed to paint.
    expect(sequence.isLatest(first)).toBe(false);
    expect(sequence.isLatest(second)).toBe(true);
  });

  it("keeps the newest read current no matter how many times it is asked", () => {
    const sequence = createLatestOnly();
    sequence.issue();
    const newest = sequence.issue();

    expect(sequence.isLatest(newest)).toBe(true);
    expect(sequence.isLatest(newest)).toBe(true);
  });

  it("never lets a superseded read become current again", () => {
    const sequence = createLatestOnly();
    const first = sequence.issue();
    sequence.issue();
    sequence.issue();

    expect(sequence.isLatest(first)).toBe(false);
  });

  it("gives every read a distinct ticket", () => {
    const sequence = createLatestOnly();
    const tickets = [sequence.issue(), sequence.issue(), sequence.issue()];

    // Without distinct tickets a stale read could hold the same value as the newest one
    // and pass the guard it is supposed to fail.
    expect(new Set(tickets).size).toBe(tickets.length);
  });

  it("keeps separate sequences independent", () => {
    // One sequence per mounted view: a read issued by one must not supersede another's.
    const one = createLatestOnly();
    const other = createLatestOnly();
    const ticket = one.issue();
    other.issue();

    expect(one.isLatest(ticket)).toBe(true);
  });
});

describe("QUESTION_FILTER_DEBOUNCE_MS", () => {
  it("waits long enough to collapse a typed word but stays under half a second", () => {
    // The band is the requirement, not the exact number. Below ~250ms a fluent typist
    // still issues a read per character and can rate-limit themselves out of their own
    // inbox; above ~400ms the filter starts feeling broken.
    expect(QUESTION_FILTER_DEBOUNCE_MS).toBeGreaterThanOrEqual(250);
    expect(QUESTION_FILTER_DEBOUNCE_MS).toBeLessThanOrEqual(400);
  });
});
