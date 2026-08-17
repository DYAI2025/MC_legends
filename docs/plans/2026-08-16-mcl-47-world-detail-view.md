# MCL-47 — Spielwelt-Kacheln öffnen kindgerechte Detailansicht — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A child can open any world tile with mouse, touch or keyboard, read a child-friendly detail view built only from the existing SSoT dataset, and come back to exactly the overview they left — same category, same card, same focus.

**Architecture:** The tile stops being a decorative `<article>` and becomes a real Next.js `<Link>` to a new server-rendered route `/welt/[id]`. The overview's selected category stops being private client state and moves into the URL (`/?thema=<slug>`), so it survives a real navigation in both directions and is restorable by the server. The detail route renders only from `src/content/*` — new pure selectors (`ideaById`, `openQuestionsAbout`, `relatedIdeas`, `categorySlugFor`) are added to the content layer, no new lore is authored, and the child-facing truth status keeps coming from the one existing `childStatusFor` mapping. The back link carries `?thema=<slug>#idee-<id>` so the overview restores category, scroll anchor and focus.

**Tech Stack:** Next.js 16.3 App Router (server components, `typedRoutes`), React 19.2, TypeScript 6, Vitest 4 (node env, `tests/**/*.test.ts`), Playwright 1.62 (chromium).

**Baseline:** worktree `/Users/benjaminpoersch/Downloads/MC_legends-mcl47`, branch `feat/MCL-47-world-detail-view`, forked from `origin/main` = `2fe01b1bc70ec23f862fb9da632c20404bbe8fce` (verified live).

---

## Ground rules for every task

- Node must be 24.18.1: `source ~/.nvm/nvm.sh && nvm use 24.18.1` before any npm command.
- All work happens in `/Users/benjaminpoersch/Downloads/MC_legends-mcl47`. Never touch the other worktrees.
- E2E runs with an isolated port and a clean inbox: `rm -rf .data && E2E_PORT=3199 npx playwright test`.
- No secret values in code, commits, PR text or logs.
- No new game lore. Every sentence on the detail page is either (a) copied from the dataset, (b) a UI affordance ("Zurück zu den Ideen"), or (c) the existing status explanation from `content-source.ts`.

---

## Design decisions (decided, do not re-litigate during execution)

1. **Real route, not a modal.** `/welt/[id]` is a server component. "Echte Navigation" is an explicit requirement; a modal would not give a shareable URL, would not survive reload, and would make browser-Back leave the site.
2. **Category lives in the URL.** `src/app/page.tsx` reads `searchParams.thema` and passes the resolved filter to `FamilyExperience` as a prop. The chips call `router.replace()`. There is no local category state — one source of truth, so browser-Back and the in-app back link cannot disagree.
3. **Chips stay `<button aria-pressed>`.** Changing them to links would break `tests/e2e/foundation.spec.ts` for no user-visible gain. Their role stays; only where the selection is *stored* changes.
4. **The whole card is one `<a>`.** Not a card with a "more" link inside it: the requirement is that the whole tile is interactive, and a link gives mouse, touch, keyboard, focus and Enter-activation natively, with no `role`/`tabindex`/`onKeyDown` re-implementation.
5. **Focus restore is explicit, not inherited.** An effect in `FamilyExperience` focuses `#idee-<id>` on mount when the hash names a card. Relying on the browser's fragment-focus behaviour would make the acceptance criterion a property of Chrome, not of this code.
6. **The emblem invents nothing.** A deterministic abstract voxel SVG derived from the idea id, labelled with the existing "Konzeptbild · noch nicht fest" badge. Blocks, not creatures; no scene, no characters, no franchise motifs, no Minecraft textures.
7. **Source references stay off the child page.** `idea.source.note` is delivery language ("chronologisch konsistent machen"). It is evidence for the project, not content for an eight-year-old. Documented as a known limitation.

---

## Task 1: URL-addressable categories in the content layer

**Files:**
- Modify: `src/content/avaloria-content.ts`
- Create: `tests/unit/world-detail-content.test.ts`

**Step 1: Write the failing test**

Create `tests/unit/world-detail-content.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  allCategoryFilters,
  avaloriaIdeas,
  categoryFilterFromSlug,
  categorySlugFor,
  childCategories,
  ideaById,
  relatedIdeas,
  type CategoryFilter,
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
      expect(slug).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("round-trips every filter through its slug", () => {
    for (const filter of allCategoryFilters) {
      expect(categoryFilterFromSlug(categorySlugFor(filter))).toBe(filter);
    }
  });

  it("falls back to all ideas for a missing or unknown slug", () => {
    expect(categoryFilterFromSlug(undefined)).toBe("Alle Ideen");
    expect(categoryFilterFromSlug("")).toBe("Alle Ideen");
    expect(categoryFilterFromSlug("geschichte-und-welt-und-mehr")).toBe("Alle Ideen");
    // A child pasting a half-typed address must not land on an empty grid.
    expect(categoryFilterFromSlug("../../etc/passwd")).toBe("Alle Ideen");
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
    for (const idea of avaloriaIdeas) {
      for (const related of relatedIdeas(idea)) {
        expect(related.internalCategory).toBe(idea.internalCategory);
      }
    }
  });

  it("finds real neighbours for at least one idea, so the section is not dead code", () => {
    const withNeighbours = avaloriaIdeas.filter((idea) => relatedIdeas(idea).length > 0);
    expect(withNeighbours.length).toBeGreaterThan(0);
  });

  it("keeps every slug and filter label free of project jargon", () => {
    for (const filter of allCategoryFilters) {
      expectChildSafe(filter as CategoryFilter, `filter ${filter}`);
    }
  });
});
```

**Step 2: Run it and watch it fail**

```bash
source ~/.nvm/nvm.sh && nvm use 24.18.1
npx vitest run tests/unit/world-detail-content.test.ts
```

Expected: FAIL — `categorySlugFor` / `ideaById` / `relatedIdeas` are not exported.

**Step 3: Implement in `src/content/avaloria-content.ts`**

Append (keeping the existing exports untouched):

```ts
/** What the overview can be filtered to. "Alle Ideen" is a filter, not a category. */
export type CategoryFilter = ChildCategory | "Alle Ideen";

export const allIdeasFilter = "Alle Ideen" satisfies CategoryFilter;

/**
 * Total lookup: a new child category without a slug is a compile error. Slugs are
 * url-safe and stable, because they end up in the address a child can bookmark or
 * come back to with the browser's back button.
 */
const categorySlugs = {
  "Alle Ideen": "alle",
  "Geschichte & Welt": "geschichte-und-welt",
  "Wesen & Figuren": "wesen-und-figuren",
  "Quests & Abenteuer": "quests-und-abenteuer",
  "Ausrüstung & Bauen": "ausruestung-und-bauen",
  "Gemeinsam spielen": "gemeinsam-spielen",
  "Offene Ideen": "offene-ideen",
} as const satisfies Record<CategoryFilter, string>;

/** Derived from the slug table, so it can never fall out of sync with CategoryFilter. */
export const allCategoryFilters = Object.keys(categorySlugs) as ReadonlyArray<CategoryFilter>;

export function categorySlugFor(filter: CategoryFilter): string {
  return categorySlugs[filter];
}

/**
 * Anything unrecognised reads as "Alle Ideen". A hand-edited or truncated address must
 * show a child the whole world rather than an empty grid or an error page.
 */
export function categoryFilterFromSlug(slug: string | undefined): CategoryFilter {
  const match = allCategoryFilters.find((filter) => categorySlugs[filter] === slug);
  return match ?? allIdeasFilter;
}

export function ideaById(id: string): AvaloriaIdea | undefined {
  return avaloriaIdeas.find((idea) => idea.id === id);
}

/**
 * Other entries the project already files under the same owner topic. Derived, never
 * authored: this states no relationship the dataset does not already carry.
 */
export function relatedIdeas(idea: AvaloriaIdea): ReadonlyArray<AvaloriaIdea> {
  return avaloriaIdeas.filter(
    (other) => other.id !== idea.id && other.internalCategory === idea.internalCategory,
  );
}
```

**Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/unit/world-detail-content.test.ts
```

Expected: PASS, all cases green.

**Step 5: Commit**

```bash
git add src/content/avaloria-content.ts tests/unit/world-detail-content.test.ts
git commit -m "feat(MCL-47): make idea categories addressable and ideas lookupable"
```

---

## Task 2: Open questions that belong to an element

**Files:**
- Modify: `src/content/open-questions.ts`
- Modify: `tests/unit/open-questions.test.ts`

**Step 1: Write the failing test**

Append to `tests/unit/open-questions.test.ts` (import `openQuestionsAbout` and `focusQuestion` as needed):

```ts
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
    // Nothing may be conjured up to give an element a question it does not have.
    const covered = new Set(openQuestions.map((question) => question.internalCategory));
    const uncovered = allInternalCategories.filter((category) => !covered.has(category));
    expect(uncovered.length, "fixture needs at least one uncovered topic").toBeGreaterThan(0);
    for (const category of uncovered) {
      expect(openQuestionsAbout(category)).toEqual([]);
    }
  });

  it("finds the focus question through the topic it belongs to", () => {
    const focus = focusQuestion();
    expect(openQuestionsAbout(focus.internalCategory).map((q) => q.id)).toContain(focus.id);
  });

  it("skips closed questions", () => {
    const closed = { ...openQuestions[0], id: "closed-fixture", state: "closed" as const };
    expect(
      openQuestionsAbout(closed.internalCategory, [closed]).map((q) => q.id),
    ).not.toContain("closed-fixture");
  });
});
```

**Step 2: Run it and watch it fail**

```bash
npx vitest run tests/unit/open-questions.test.ts
```

Expected: FAIL — `openQuestionsAbout` is not exported.

**Step 3: Implement in `src/content/open-questions.ts`**

```ts
/**
 * The still-open questions the project files under the same owner topic as an element.
 * Same shape as the two selectors above: the question set is a parameter so the filter
 * can be exercised against a set that breaks the invariant.
 */
export function openQuestionsAbout(
  internalCategory: InternalCategory,
  questions: ReadonlyArray<OpenQuestion> = openQuestions,
): ReadonlyArray<OpenQuestion> {
  return questions.filter(
    (question) => question.state === "open" && question.internalCategory === internalCategory,
  );
}
```

**Step 4: Verify it passes**

```bash
npx vitest run tests/unit/open-questions.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/content/open-questions.ts tests/unit/open-questions.test.ts
git commit -m "feat(MCL-47): find the open questions that belong to an element"
```

---

## Task 3: The idea emblem (deterministic voxel visual)

**Files:**
- Create: `src/app/components/idea-emblem.tsx`
- Create: `tests/unit/idea-emblem.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { avaloriaIdeas } from "@/content/avaloria-content";
import { allChildStatuses, childStatusFor } from "@/content/content-source";
import { emblemBlocksFor, emblemPaletteFor } from "@/app/components/idea-emblem";

describe("idea emblem geometry", () => {
  it("is deterministic for the same id", () => {
    expect(emblemBlocksFor("creatures-druhen")).toEqual(emblemBlocksFor("creatures-druhen"));
  });

  it("gives every real idea a non-empty, in-bounds block stack", () => {
    for (const idea of avaloriaIdeas) {
      const blocks = emblemBlocksFor(idea.id);
      expect(blocks.length, idea.id).toBeGreaterThan(0);
      for (const block of blocks) {
        expect(block.column, idea.id).toBeGreaterThanOrEqual(0);
        expect(block.column, idea.id).toBeLessThan(4);
        expect(block.height, idea.id).toBeGreaterThanOrEqual(1);
        expect(block.height, idea.id).toBeLessThanOrEqual(4);
      }
    }
  });

  it("does not hand the whole dataset the same picture", () => {
    // A constant "deterministic" function would satisfy every case above.
    const shapes = new Set(avaloriaIdeas.map((idea) => JSON.stringify(emblemBlocksFor(idea.id))));
    expect(shapes.size).toBeGreaterThan(avaloriaIdeas.length / 2);
  });

  it("has a distinct palette for every child status", () => {
    const palettes = allChildStatuses.map((status) => JSON.stringify(emblemPaletteFor(status)));
    expect(new Set(palettes).size).toBe(allChildStatuses.length);
  });

  it("has a palette for every status a real idea can reach", () => {
    for (const idea of avaloriaIdeas) {
      expect(emblemPaletteFor(childStatusFor(idea.truthStatus)).top).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
```

**Step 2: Run it and watch it fail**

```bash
npx vitest run tests/unit/idea-emblem.test.ts
```

Expected: FAIL — module not found.

**Step 3: Implement `src/app/components/idea-emblem.tsx`**

A pure geometry function + a pure palette lookup + a server component that draws isometric blocks. No `"use client"`. Own visual language: flat isometric cubes on a rounded pastel field, no textures, no scene, no creature.

**Step 4: Verify it passes**

```bash
npx vitest run tests/unit/idea-emblem.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/app/components/idea-emblem.tsx tests/unit/idea-emblem.test.ts
git commit -m "feat(MCL-47): draw a deterministic block emblem for every idea"
```

---

## Task 4: The whole tile becomes a link, category moves into the URL

**Files:**
- Modify: `src/app/page.tsx`
- Modify: `src/app/family-experience.tsx`
- Modify: `src/app/globals.css`

**Step 1 — page.tsx:** accept `searchParams`, resolve `thema` to a `CategoryFilter`, pass it as `selectedCategory` to `FamilyExperience`.

**Step 2 — family-experience.tsx:**
- new prop `selectedCategory: CategoryFilter`; delete the `useState` for it.
- chips call `router.replace(hrefFor(category), { scroll: false })`; `aria-pressed` unchanged.
- each card becomes `<Link className="idea-card" id={`idee-${idea.id}`} href={detailHref(idea, selectedCategory)}>` carrying the current filter slug.
- add a persistent affordance line inside the card: `<span className="idea-more">Mehr entdecken <span className="idea-more-arrow" aria-hidden="true">→</span></span>`.
- add the mount effect that focuses `#idee-<id>` when the hash names a card.

**Step 3 — globals.css:** `.idea-card` gets `text-decoration: none; color: inherit;` plus `:focus-visible` handled by the existing `a:focus-visible` rule; `.idea-more` styling; `.idea-more-arrow { transition: transform .18s ease }` and `.idea-card:hover .idea-more-arrow, .idea-card:focus-visible .idea-more-arrow { transform: translateX(5px) }`.

**Step 4:** `npm run lint && npm run typecheck && npm run test`. Expected: PASS.

**Step 5:** Commit `feat(MCL-47): make the whole world tile a real link and put the filter in the address`.

---

## Task 5: The detail route

**Files:**
- Create: `src/app/welt/[id]/page.tsx`
- Modify: `src/app/globals.css`
- Modify: `scripts/check-foundation.mjs` (add the new page to the required list)

Server component. `notFound()` for an unknown id. Renders: back link (`/?thema=<slug>#idee-<id>`), emblem + "Konzeptbild · noch nicht fest" badge, status badge + explanation, h1 title, summary, category, topic label, related open questions (with a "jetzt beantworten" link only when the question is the current focus question), related ideas as links. `generateMetadata` sets the tab title.

Gates: `npm run check:foundation && npm run lint && npm run typecheck && npm run build`.

Commit: `feat(MCL-47): serve a child-friendly detail page for every world tile`.

---

## Task 6: The E2E proof (A–H)

**Files:**
- Create: `tests/e2e/world-detail.spec.ts`

One test per lettered criterion:

- **A mouse** — click a card → detail page shows that idea's title as `h1`.
- **B keyboard** — reach the card with `Tab` from the preceding chip, assert `:focus-visible` outline is a real outline, press `Enter`, land on the detail page.
- **C mobile** — `viewport 390x844`, tap the card, detail page opens and its heading is in the viewport.
- **D back navigation** — pick "Geschichte & Welt", open a card, press "Zurück", assert: chip still pressed, grid still filtered to that category's count, the card is in the viewport and focused. Then repeat with `page.goBack()` and assert the category survives.
- **E status truth** — a STATED idea shows "Schon dabei"; a TENTATIVE idea shows "Eine Idee"; assert the pairs come from `childStatusFor`, not from retyped literals.
- **F open content** — an OPEN idea shows "Noch offen" + "Das ist noch nicht entschieden." and the page body never contains "Schon dabei".
- **G reduced motion** — the hover-affordance transition is > 0.1 s by default and < 0.001 s under `reducedMotion: "reduce"`. Both halves asserted, so removing the transition fails the test.
- **H accessibility** — the card exposes `role=link` with an accessible name containing the idea title; the detail page has exactly one `h1`; the whole detail page text passes `expectChildSafe`; body contains none of the franchise strings.

Run: `rm -rf .data && E2E_PORT=3199 npx playwright test`.

Commit: `test(MCL-47): prove the tile opens, reads true and comes back where it left`.

---

## Task 7: Mutation evidence (watch every new guard fail)

For each mutation: apply, run the named test, record the failure line, revert with `git checkout --`, re-run to confirm green.

| # | Mutation | Test that must fail |
|---|---|---|
| M1 | `<Link>` → `<div>` on the card | B keyboard |
| M2 | drop `?thema=` from the card href | D back navigation |
| M3 | hardcode "Schon dabei" on the detail page | F open content |
| M4 | delete the `.idea-more-arrow` transition | G reduced motion |
| M5 | delete the hash-focus effect | D back navigation (focus half) |
| M6 | `relatedIdeas` returns `avaloriaIdeas` unfiltered | Task 1 unit test |

---

## Task 8: Full gate run, push, PR, CI

```bash
source ~/.nvm/nvm.sh && nvm use 24.18.1
npm run check:foundation
npm run check:secrets
npm run lint
npm run typecheck
npm run test                                   # with MCL_TEST_DATABASE_URL set
npm run check:integration-ran                  # real PostgreSQL, no skips
npm run build
npm run check:client-secrets
rm -rf .data && E2E_PORT=3199 npx playwright test
npm audit --audit-level=high
```

Then push the branch, open the PR against `main` with the full evidence body, and wait for CI on the exact PR head. Do not merge.
