import { describe, expect, it } from "vitest";
import {
  allCategoryFilters,
  avaloriaIdeas,
  categoryFilterFromSlug,
  categorySlugFor,
  childCategories,
  ideaAnchorId,
  ideaById,
  ideaDetailHref,
  overviewHref,
  relatedIdeas,
  THEMA_PARAM,
} from "@/content/avaloria-content";
import { expectChildSafe } from "../support/child-safe";

describe("category slugs", () => {
  it("covers every filter the overview can show, including the all-ideas filter", () => {
    expect(allCategoryFilters).toContain("Alle Ideen");
    for (const category of childCategories) {
      expect(allCategoryFilters).toContain(category.label);
    }
    expect(allCategoryFilters.length).toBe(childCategories.length + 1);
  });

  it("gives every filter a distinct url-safe slug", () => {
    const slugs = allCategoryFilters.map((filter) => categorySlugFor(filter));
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      expect(slug, `slug for "${slug}" must survive an address bar`).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("round-trips every filter through its slug", () => {
    for (const filter of allCategoryFilters) {
      expect(categoryFilterFromSlug(categorySlugFor(filter))).toBe(filter);
    }
  });

  it("falls back to all ideas for a missing or unknown slug", () => {
    // A child pasting a half-typed or stale address must land on the whole world,
    // never on an empty grid and never on an error page.
    expect(categoryFilterFromSlug(undefined)).toBe("Alle Ideen");
    expect(categoryFilterFromSlug("")).toBe("Alle Ideen");
    expect(categoryFilterFromSlug("geschichte")).toBe("Alle Ideen");
    expect(categoryFilterFromSlug("../../etc/passwd")).toBe("Alle Ideen");
  });

  it("keeps every filter label free of project jargon", () => {
    for (const filter of allCategoryFilters) {
      expectChildSafe(filter, `filter ${filter}`);
    }
  });
});

describe("addresses", () => {
  function themaOf(href: string): string | undefined {
    return new URL(href, "https://example.invalid").searchParams.get(THEMA_PARAM) ?? undefined;
  }

  it("round-trips every filter through the overview address", () => {
    for (const filter of allCategoryFilters) {
      expect(categoryFilterFromSlug(themaOf(overviewHref(filter))), filter).toBe(filter);
    }
  });

  it("leaves the default filter out of the address", () => {
    // "/" is what an adult hands a child. It has to keep meaning the whole world.
    expect(overviewHref("Alle Ideen")).toBe("/");
    expect(themaOf(overviewHref("Alle Ideen"))).toBeUndefined();
  });

  it("points the overview address at one card when asked", () => {
    expect(overviewHref("Alle Ideen", "creatures-druhen")).toBe("/#idee-creatures-druhen");
    expect(overviewHref("Wesen & Figuren", "creatures-druhen")).toBe(
      "/?thema=wesen-und-figuren#idee-creatures-druhen",
    );
    expect(ideaAnchorId("creatures-druhen")).toBe("idee-creatures-druhen");
  });

  it("carries the chosen filter into every idea's own address", () => {
    for (const idea of avaloriaIdeas) {
      const href = ideaDetailHref(idea.id, idea.childCategory);
      expect(new URL(href, "https://example.invalid").pathname).toBe(`/welt/${idea.id}`);
      expect(categoryFilterFromSlug(themaOf(href)), idea.id).toBe(idea.childCategory);
    }
  });

  it("gets a child back to the filter they came from", () => {
    // The whole point of the round trip: overview -> detail -> overview loses nothing.
    for (const filter of allCategoryFilters) {
      const detail = ideaDetailHref("creatures-druhen", filter);
      const back = overviewHref(categoryFilterFromSlug(themaOf(detail)), "creatures-druhen");
      expect(back, filter).toBe(overviewHref(filter, "creatures-druhen"));
    }
  });
});

describe("idea lookup", () => {
  it("finds every idea the overview can show", () => {
    for (const idea of avaloriaIdeas) {
      expect(ideaById(idea.id)).toBe(idea);
    }
  });

  it("returns nothing for an id the dataset does not carry", () => {
    expect(ideaById("does-not-exist")).toBeUndefined();
    expect(ideaById("")).toBeUndefined();
  });
});

describe("related ideas", () => {
  it("never lists the idea itself", () => {
    for (const idea of avaloriaIdeas) {
      expect(relatedIdeas(idea).map((related) => related.id)).not.toContain(idea.id);
    }
  });

  it("only lists ideas that share the same owner topic", () => {
    // The detail page states no relationship the dataset does not already carry.
    for (const idea of avaloriaIdeas) {
      for (const related of relatedIdeas(idea)) {
        expect(related.internalCategory, `${idea.id} -> ${related.id}`).toBe(idea.internalCategory);
      }
    }
  });

  it("finds real neighbours for at least one idea, so the section is not dead code", () => {
    const withNeighbours = avaloriaIdeas.filter((idea) => relatedIdeas(idea).length > 0);
    expect(withNeighbours.length).toBeGreaterThan(0);
  });

  it("leaves an idea whose topic it alone owns without neighbours", () => {
    // Guards the other direction: a selector returning everything would pass every
    // case above except this one.
    const lonely = avaloriaIdeas.filter(
      (idea) =>
        avaloriaIdeas.filter((other) => other.internalCategory === idea.internalCategory).length ===
        1,
    );
    for (const idea of lonely) {
      expect(relatedIdeas(idea), `${idea.id} owns its topic alone`).toEqual([]);
    }
  });
});
