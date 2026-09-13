import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { avaloriaIdeas, childCategories } from "@/content/avaloria-content";
import {
  allChildStatuses,
  allInternalCategories,
  childStatusFor,
  childStatusLegend,
  childStatusPresentationFor,
  childTopicLabelFor,
} from "@/content/content-source";
import { expectChildSafe } from "../support/child-safe";

/** Sprint-1 placeholders that MCL-42 removes. */
const removedDemoIds = [
  "prologue-gate",
  "main-story-lanterns",
  "bridge-helper",
  "treehouse-workshop",
  "shared-map",
  "question-colors",
];

/**
 * Four of the six ids above, not all six, and that asymmetry is deliberate.
 * "Eine Karte für alle" is legitimately reused by the re-sourced persistent-shared-map
 * entry, so banning the title would ban valid content; only the demo *id* is gone.
 * The river-colour demo question is a question, not an idea, and is pinned in
 * tests/unit/open-questions.test.ts instead. Do not "fix" this list to six.
 */
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

  /*
    STATED is the strongest claim this dataset can make: it is the only status that
    reaches a child as "Schon dabei". The list stays an exact equality rather than a
    lower bound, so a new one is always a deliberate edit here and never a side effect
    of authoring an entry. Each id below names the page that marks it STATED.

    MCL-71 added four: the bestiary page (32735234) carries Mugosh, Flammenwolf and
    Veras under a literal `Status: STATED`, and the design SSoT (20250626) marks the
    Elementarspeer "STATED als neuer direkter Design-Input". Steinwolf (TENTATIVE there)
    and Zhalm (name in CONFLICT there) are deliberately NOT on this list.
  */
  it("only claims STATED for entries whose source page says STATED", () => {
    const stated = avaloriaIdeas.filter((idea) => idea.truthStatus === "STATED").map((idea) => idea.id);
    expect(stated.toSorted()).toEqual([
      "crafting-elemental-swords",
      "creatures-druhen",
      "elementarspeer",
      "flammenwolf",
      "mugosh",
      "veras",
    ]);
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

  it("keeps every filter chip label and description free of project jargon", () => {
    for (const category of childCategories) {
      expectChildSafe(`${category.label} ${category.description}`, `category ${category.label}`);
    }
  });
});

/*
  MCL-71. Pins that the seven V2 entities carry the statements their sources actually
  make, and that every picture a child sees is a file that exists on disk with a
  provenance record beside it.

  The disk check is the point of this suite. A typo in `artwork.src` is invisible in a
  unit test that only reads the dataset - the page would render a broken image and the
  status badge under it would still claim the creature is "Schon dabei". Reading the
  file is what makes that failure loud here instead of on a child's screen.
*/
describe("MCL-71 artwork", () => {
  const publicDir = path.join(process.cwd(), "public");

  const expectedEntities = [
    // truthStatus follows the bestiary page (32735234) and the design SSoT (20250626),
    // not convenience: Steinwolf is TENTATIVE there and the Zhalm *name* is in CONFLICT.
    { id: "mugosh", truthStatus: "STATED", childCategory: "Wesen & Figuren", internalCategory: "creatures", hasArtwork: true },
    { id: "eis-mugosh", truthStatus: "TENTATIVE", childCategory: "Wesen & Figuren", internalCategory: "creatures", hasArtwork: true },
    { id: "flammenwolf", truthStatus: "STATED", childCategory: "Wesen & Figuren", internalCategory: "creatures", hasArtwork: true },
    { id: "veras", truthStatus: "STATED", childCategory: "Wesen & Figuren", internalCategory: "creatures", hasArtwork: true },
    { id: "steinwolf", truthStatus: "TENTATIVE", childCategory: "Wesen & Figuren", internalCategory: "creatures", hasArtwork: false },
    { id: "zhalm", truthStatus: "CONFLICT", childCategory: "Wesen & Figuren", internalCategory: "creatures", hasArtwork: false },
    { id: "elementarspeer", truthStatus: "STATED", childCategory: "Ausrüstung & Bauen", internalCategory: "crafting", hasArtwork: false },
  ] as const;

  it("ships the seven V2 entities with the status their source gives them", () => {
    for (const expected of expectedEntities) {
      const idea = avaloriaIdeas.find((candidate) => candidate.id === expected.id);
      expect(idea, `${expected.id} must be in the dataset`).toBeDefined();
      expect(idea?.truthStatus, `${expected.id} truth status`).toBe(expected.truthStatus);
      expect(idea?.childCategory, `${expected.id} child category`).toBe(expected.childCategory);
      expect(idea?.internalCategory, `${expected.id} owner`).toBe(expected.internalCategory);
    }
  });

  it("gives artwork only to the entities whose picture is approved", () => {
    for (const expected of expectedEntities) {
      const idea = avaloriaIdeas.find((candidate) => candidate.id === expected.id);
      expect(
        idea?.artwork !== undefined,
        `${expected.id} artwork presence`,
      ).toBe(expected.hasArtwork);
    }
  });

  it("describes every picture in words a child can hear, and in the project's own terms", () => {
    for (const idea of avaloriaIdeas) {
      if (idea.artwork === undefined) continue;
      const { artwork } = idea;
      expect(artwork.src.startsWith("/assets/creatures/"), `${idea.id} src root`).toBe(true);
      expect(artwork.alt.trim(), `${idea.id} alt`).not.toBe("");
      expectChildSafe(artwork.alt, `${idea.id} alt text`);
      expect(artwork.license, `${idea.id} license`).toBe("project-owned");
      expect(artwork.approvedOn, `${idea.id} approval date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(artwork.width, `${idea.id} width`).toBeGreaterThan(0);
      expect(artwork.height, `${idea.id} height`).toBeGreaterThan(0);
      expect(artwork.assetId.trim(), `${idea.id} asset id`).not.toBe("");
      expect(artwork.hero.src.startsWith("/assets/creatures/"), `${idea.id} hero src root`).toBe(true);
      expect(artwork.hero.width, `${idea.id} hero width`).toBeGreaterThan(artwork.width);
      expect(artwork.hero.height, `${idea.id} hero height`).toBeGreaterThan(0);
    }
  });

  it("has the file and its provenance record on disk for every picture it promises", () => {
    for (const idea of avaloriaIdeas) {
      if (idea.artwork === undefined) continue;
      const { artwork } = idea;
      for (const file of [artwork.src, artwork.hero.src]) {
        expect(fs.existsSync(path.join(publicDir, file)), `${idea.id}: ${file} must exist`).toBe(true);
      }

      const provenancePath = path.join(publicDir, artwork.provenance);
      expect(
        fs.existsSync(provenancePath),
        `${idea.id}: ${artwork.provenance} must exist`,
      ).toBe(true);

      const record = JSON.parse(fs.readFileSync(provenancePath, "utf8"));
      expect(record.license, `${idea.id} provenance license`).toBe("project-owned");
      expect(record.assetId, `${idea.id} provenance asset id`).toBe(artwork.assetId);
      expect(record.approvedOn, `${idea.id} provenance approval`).toBe(artwork.approvedOn);
      expect(
        typeof record.source === "string" && record.source.trim() !== "",
        `${idea.id} provenance must name the source crop`,
      ).toBe(true);
      expect(
        record.negativeListChecked?.list,
        `${idea.id} provenance must name the negative list it was checked against`,
      ).toBe("docs/image-negative-list.md");
    }
  });
});
