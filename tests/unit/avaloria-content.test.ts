import { describe, expect, it } from "vitest";
import { avaloriaIdeas, childCategories } from "@/content/avaloria-content";
import {
  allChildStatuses,
  allInternalCategories,
  childStatusFor,
  childStatusLegend,
  childStatusPresentationFor,
  childTopicLabelFor,
  childUnsafeVocabulary,
} from "@/content/content-source";

/** Sprint-1 placeholders that MCL-42 removes. */
const removedDemoIds = [
  "prologue-gate",
  "main-story-lanterns",
  "bridge-helper",
  "treehouse-workshop",
  "shared-map",
  "question-colors",
];

const removedDemoTitles = [
  "Das Tor ins grüne Tal",
  "Die Lichter von Avaloria",
  "Der Brückenhüter",
  "Die Werkstatt im Baum",
];

describe("avaloria content", () => {
  it("no longer ships the Sprint-1 demo entries", () => {
    const ids = avaloriaIdeas.map((idea) => idea.id);
    const titles = avaloriaIdeas.map((idea) => idea.title);

    for (const id of removedDemoIds) {
      expect(ids, `demo id ${id} must be gone`).not.toContain(id);
    }
    for (const title of removedDemoTitles) {
      expect(titles, `demo title ${title} must be gone`).not.toContain(title);
    }
  });

  it("gives every entry a stable unique id", () => {
    const ids = avaloriaIdeas.map((idea) => idea.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("backs every entry with a concrete project source reference", () => {
    for (const idea of avaloriaIdeas) {
      expect(idea.source.ref.trim(), `${idea.id} needs a source ref`).not.toBe("");
      expect(idea.source.note.trim(), `${idea.id} needs a source note`).not.toBe("");
      expect(idea.source.url).toMatch(/^https:\/\/dyai2026\.atlassian\.net\//);
      if (idea.source.system === "jira") {
        expect(idea.source.ref).toMatch(/^MCL-\d+$/);
      }
    }
  });

  it("only claims STATED for the two documented canon guardrails", () => {
    const stated = avaloriaIdeas.filter((idea) => idea.truthStatus === "STATED").map((idea) => idea.id);
    expect(stated.toSorted()).toEqual(["crafting-elemental-swords", "creatures-druhen"]);
  });

  it("keeps prologue and main story separately traceable", () => {
    const prologue = avaloriaIdeas.filter((idea) => idea.internalCategory === "prologue");
    const mainStory = avaloriaIdeas.filter((idea) => idea.internalCategory === "main-story");

    expect(prologue.length).toBeGreaterThan(0);
    expect(mainStory.length).toBeGreaterThan(0);
    expect(childTopicLabelFor("prologue")).not.toBe(childTopicLabelFor("main-story"));
    for (const idea of [...prologue, ...mainStory]) {
      expect(idea.source.ref).toMatch(/^MCL-\d+$/);
    }
  });

  it("maps every entry onto one of the accepted child groups and child states", () => {
    const groups = childCategories.map((category) => category.label);
    expect(groups.length).toBe(6);

    for (const idea of avaloriaIdeas) {
      expect(groups).toContain(idea.childCategory);
      expect(allChildStatuses).toContain(childStatusFor(idea.truthStatus));
    }
  });

  it("never offers a filter chip that would render an empty grid", () => {
    for (const category of childCategories) {
      const matching = avaloriaIdeas.filter((idea) => idea.childCategory === category.label);
      expect(matching.length, `filter "${category.label}" must not be a dead end`).toBeGreaterThan(0);
    }
  });
});

describe("truth status to child status mapping", () => {
  it.each([
    ["STATED", "in-world"],
    ["TENTATIVE", "idea"],
    ["AMBIGUOUS", "open"],
    ["CONFLICT", "open"],
    ["OPEN", "open"],
  ] as const)("maps %s to %s", (truth, expected) => {
    expect(childStatusFor(truth)).toBe(expected);
  });

  it("never presents a non-STATED entry as already part of the world", () => {
    for (const idea of avaloriaIdeas) {
      if (idea.truthStatus !== "STATED") {
        expect(childStatusFor(idea.truthStatus), idea.id).not.toBe("in-world");
      }
    }
  });

  it("has a presentation for every child status, with no shared identity", () => {
    const labels = childStatusLegend.map((status) => status.label);
    expect(new Set(labels).size).toBe(childStatusLegend.length);
    for (const status of childStatusLegend) {
      expect(childStatusPresentationFor(status.id)).toBe(status);
      expect(status.label.trim()).not.toBe("");
      expect(status.explanation.trim()).not.toBe("");
      expect(status.icon.trim()).not.toBe("");
    }
  });

  /**
   * Pinned against literals on purpose: childStatusLegend and allChildStatuses are both
   * derived from childStatusPresentations, so comparing them to each other would pass
   * under any permutation of that record and silently reorder the child's status cards.
   */
  it("shows the legend in the intended reading order", () => {
    expect(childStatusLegend.map((status) => status.id)).toEqual([
      "in-world",
      "idea",
      "open",
      "tryout",
    ]);
  });
});

describe("internal owner taxonomy", () => {
  it("gives every internal category a distinct, non-empty child-facing topic label", () => {
    const labels = allInternalCategories.map((category) => childTopicLabelFor(category));

    expect(allInternalCategories.length).toBeGreaterThan(0);
    expect(new Set(allInternalCategories).size).toBe(allInternalCategories.length);
    expect(new Set(labels).size, "topic labels must be pairwise distinct").toBe(labels.length);
    for (const label of labels) {
      expect(label.trim()).not.toBe("");
    }
  });

  it("uses only internal categories that the shared taxonomy knows", () => {
    for (const idea of avaloriaIdeas) {
      expect(allInternalCategories, `${idea.id} has an unknown owner`).toContain(idea.internalCategory);
    }
  });
});

describe("child-safe vocabulary", () => {
  function expectChildSafe(visible: string, context: string): void {
    for (const word of childUnsafeVocabulary) {
      expect(visible, `${context} must not expose ${word}`).not.toContain(word);
    }
  }

  it("keeps idea titles and summaries free of project jargon", () => {
    for (const idea of avaloriaIdeas) {
      expectChildSafe(`${idea.title} ${idea.summary}`, idea.id);
    }
  });

  it("keeps every topic label free of project jargon", () => {
    for (const category of allInternalCategories) {
      expectChildSafe(childTopicLabelFor(category), `topic label ${category}`);
    }
  });

  it("keeps every status label and explanation free of project jargon", () => {
    for (const status of childStatusLegend) {
      expectChildSafe(`${status.label} ${status.explanation}`, `status ${status.id}`);
    }
  });
});
