import { describe, expect, it } from "vitest";
import {
  avaloriaIdeas,
  childCategories,
  childStatusFor,
  childStatusMeta,
  internalCategoryLabel,
} from "@/content/avaloria-content";

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
    expect(internalCategoryLabel("prologue")).not.toBe(internalCategoryLabel("main-story"));
    for (const idea of [...prologue, ...mainStory]) {
      expect(idea.source.ref).toMatch(/^MCL-\d+$/);
    }
  });

  it("maps every entry onto one of the accepted child groups and child states", () => {
    const groups = childCategories.map((category) => category.label);
    const states = childStatusMeta.map((status) => status.id);
    expect(groups.length).toBeLessThanOrEqual(6);

    for (const idea of avaloriaIdeas) {
      expect(groups).toContain(idea.childCategory);
      expect(states).toContain(childStatusFor(idea.truthStatus));
    }
  });

  it("uses no child-facing project jargon in visible strings", () => {
    const forbidden = ["Canon", "SSoT", "Divergenz", "IndexedDB", "Sync", "STATED", "TENTATIVE"];
    for (const idea of avaloriaIdeas) {
      const visible = `${idea.title} ${idea.summary}`;
      for (const word of forbidden) {
        expect(visible, `${idea.id} must not expose ${word}`).not.toContain(word);
      }
    }
  });
});
