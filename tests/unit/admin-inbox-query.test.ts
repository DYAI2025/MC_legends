import { describe, expect, it } from "vitest";
import { buildInboxQuery, type AdminFilterState } from "@/app/admin-inbox-query";

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
