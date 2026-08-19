import { describe, expect, it } from "vitest";
import { allInternalCategories } from "@/content/content-source";
import {
  focusQuestion,
  openQuestions,
  openQuestionsAbout,
  otherOpenQuestions,
} from "@/content/open-questions";
import { expectChildSafe } from "../support/child-safe";

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
      expectChildSafe(
        `${question.title} ${question.prompt} ${question.placeholder}`,
        question.id,
      );
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

/**
 * MCL-47 lets a detail page point at an open question that factually belongs to the
 * element being read. "Factually" is the whole point: the link exists only where both
 * datasets already agree on the owner topic, and nothing is conjured up to create one.
 */
describe("open questions about an element", () => {
  it("only returns still-open questions filed under the asked topic", () => {
    for (const category of allInternalCategories) {
      for (const question of openQuestionsAbout(category)) {
        expect(question.internalCategory).toBe(category);
        expect(question.state).toBe("open");
      }
    }
  });

  it("returns nothing for a topic the question set does not cover", () => {
    const covered = new Set(openQuestions.map((question) => question.internalCategory));
    const uncovered = allInternalCategories.filter((category) => !covered.has(category));

    // Without a real uncovered topic this case would assert nothing at all.
    expect(uncovered.length, "the dataset needs at least one topic with no question").toBeGreaterThan(0);
    for (const category of uncovered) {
      expect(openQuestionsAbout(category), `${category} has no question`).toEqual([]);
    }
  });

  it("finds the focus question through the topic it belongs to", () => {
    const focus = focusQuestion();
    expect(openQuestionsAbout(focus.internalCategory).map((question) => question.id)).toContain(
      focus.id,
    );
  });

  it("skips a closed question", () => {
    const closed = { ...openQuestions[0], id: "closed-fixture", state: "closed" as const };
    expect(
      openQuestionsAbout(closed.internalCategory, [closed]).map((question) => question.id),
    ).not.toContain("closed-fixture");
  });
});
