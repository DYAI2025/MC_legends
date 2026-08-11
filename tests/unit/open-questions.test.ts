import { describe, expect, it } from "vitest";
import { allInternalCategories, childUnsafeVocabulary } from "@/content/content-source";
import { focusQuestion, openQuestions, otherOpenQuestions } from "@/content/open-questions";

describe("open design questions", () => {
  it("holds at least three real open questions", () => {
    expect(openQuestions.filter((question) => question.state === "open").length).toBeGreaterThanOrEqual(3);
  });

  it("puts exactly one question in focus", () => {
    const focused = openQuestions.filter((question) => question.state === "open" && question.focus);
    expect(focused).toHaveLength(1);
    expect(focusQuestion().id).toBe(focused[0].id);
    expect(otherOpenQuestions().map((question) => question.id)).not.toContain(focusQuestion().id);
  });

  /**
   * A guard nobody has watched fail is not a guard: exercise it against a set that
   * breaks the invariant, so a silently removed check cannot pass this suite.
   */
  it("refuses to serve a question set with no or several focused questions", () => {
    const [first, second] = openQuestions;

    expect(() => focusQuestion([])).toThrow(/found 0/);
    expect(() => focusQuestion([{ ...first, focus: false }])).toThrow(/found 0/);
    expect(() => focusQuestion([{ ...first, focus: true }, { ...second, focus: true }])).toThrow(/found 2/);
    expect(() => focusQuestion([{ ...first, focus: true, state: "closed" }])).toThrow(/found 0/);
  });

  it("no longer contains the Sprint-1 river-colour demo question", () => {
    const ids = openQuestions.map((question) => question.id);
    expect(ids).not.toContain("river-color");
    for (const question of openQuestions) {
      expect(question.title).not.toContain("Fluss");
    }
  });

  it("gives every question a stable unique id and a project source", () => {
    const ids = openQuestions.map((question) => question.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const question of openQuestions) {
      expect(question.id).toMatch(/^[a-z0-9-]+$/);
      expect(question.source.ref).toMatch(/^MCL-\d+$/);
      expect(question.source.note.trim()).not.toBe("");
    }
  });

  it("uses only internal categories that the shared taxonomy knows", () => {
    for (const question of openQuestions) {
      expect(allInternalCategories, `${question.id} has an unknown owner`).toContain(question.internalCategory);
    }
  });

  it("asks children nothing technical or project-management shaped", () => {
    for (const question of openQuestions) {
      const visible = `${question.title} ${question.prompt} ${question.placeholder}`;
      for (const word of childUnsafeVocabulary) {
        // Word boundaries, not substrings: German "Papier" contains "api" and would
        // otherwise fail a perfectly good question. Case-insensitive, because these
        // are authored German sentences where "server" is as unfit as "Server".
        const mention = new RegExp(`\\b${word}\\b`, "iu");
        expect(visible, `${question.id} must not mention ${word}`).not.toMatch(mention);
      }
    }
  });

  /**
   * MCL-35 will close, rotate and archive questions. Asserting that every state value is
   * one of its own two union members would prove nothing - what has to hold on today's
   * model is the behaviour rotation depends on: a closed question leaves the rotation.
   */
  it("keeps a closed question out of the active rotation", () => {
    const [focused, next] = openQuestions;
    const withClosed = [focused, { ...next, state: "closed" as const }];

    const others = otherOpenQuestions(withClosed).map((question) => question.id);
    expect(others, `${next.id} is closed and must not be offered as upcoming`).not.toContain(next.id);
    expect(others).toEqual([]);
    expect(focusQuestion(withClosed).id).toBe(focused.id);
  });

  it("completes one rotation step without a data-model change", () => {
    const [previous, next, ...rest] = openQuestions;
    const rotated = [
      { ...previous, state: "closed" as const, focus: false },
      { ...next, focus: true },
      ...rest,
    ];

    expect(focusQuestion(rotated).id).toBe(next.id);

    const others = otherOpenQuestions(rotated).map((question) => question.id);
    expect(others, "the closed question must appear in neither list").not.toContain(previous.id);
    expect(others, "the new focus question must appear in neither list").not.toContain(next.id);
    expect(others).toEqual(rest.map((question) => question.id));
  });
});
