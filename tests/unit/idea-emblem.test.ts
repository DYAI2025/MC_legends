import { describe, expect, it } from "vitest";
import { emblemBlocksFor, emblemColumns, emblemPaletteFor } from "@/app/components/idea-emblem";
import { avaloriaIdeas } from "@/content/avaloria-content";
import { allChildStatuses, childStatusFor } from "@/content/content-source";

describe("idea emblem geometry", () => {
  it("is deterministic for the same id", () => {
    expect(emblemBlocksFor("creatures-druhen")).toEqual(emblemBlocksFor("creatures-druhen"));
    expect(emblemBlocksFor("world-great-wall")).toEqual(emblemBlocksFor("world-great-wall"));
  });

  it("gives every real idea a full, in-bounds block stack", () => {
    for (const idea of avaloriaIdeas) {
      const blocks = emblemBlocksFor(idea.id);
      expect(blocks.length, idea.id).toBe(emblemColumns);
      for (const block of blocks) {
        expect(block.column, idea.id).toBeGreaterThanOrEqual(0);
        expect(block.column, idea.id).toBeLessThan(emblemColumns);
        expect(block.height, idea.id).toBeGreaterThanOrEqual(1);
        expect(block.height, idea.id).toBeLessThanOrEqual(4);
      }
      expect(
        blocks.map((block) => block.column),
        `${idea.id} must fill each column exactly once`,
      ).toEqual([...blocks.keys()]);
    }
  });

  it("does not hand the whole dataset the same picture", () => {
    // A constant function would satisfy every case above. This is the one that costs it.
    const shapes = new Set(avaloriaIdeas.map((idea) => JSON.stringify(emblemBlocksFor(idea.id))));
    expect(shapes.size).toBeGreaterThan(avaloriaIdeas.length / 2);
  });

  it("varies the silhouette rather than only its total mass", () => {
    // Different heights that always sum to the same value would still read as one shape.
    const silhouettes = new Set(
      avaloriaIdeas.map((idea) => emblemBlocksFor(idea.id).map((block) => block.height).join("-")),
    );
    expect(silhouettes.size).toBeGreaterThan(1);
    const flat = avaloriaIdeas.filter((idea) => {
      const heights = emblemBlocksFor(idea.id).map((block) => block.height);
      return new Set(heights).size === 1;
    });
    expect(flat.length, "a flat wall for every idea is not a silhouette").toBeLessThan(
      avaloriaIdeas.length,
    );
  });
});

describe("idea emblem palette", () => {
  it("has a distinct palette for every child status", () => {
    const palettes = allChildStatuses.map((status) => JSON.stringify(emblemPaletteFor(status)));
    expect(new Set(palettes).size).toBe(allChildStatuses.length);
  });

  it("gives every status four real colours", () => {
    for (const status of allChildStatuses) {
      const palette = emblemPaletteFor(status);
      for (const [face, colour] of Object.entries(palette)) {
        expect(colour, `${status}.${face}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
      // Three distinguishable cube faces, otherwise the blocks read as flat rectangles.
      expect(new Set([palette.top, palette.left, palette.right]).size).toBe(3);
    }
  });

  it("has a palette for every status a real idea can reach", () => {
    for (const idea of avaloriaIdeas) {
      expect(emblemPaletteFor(childStatusFor(idea.truthStatus)).top).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
