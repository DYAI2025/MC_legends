import type { Route } from "next";
import {
  ideaDetailHref,
  overviewHref,
  type CategoryFilter,
} from "@/content/avaloria-content";

/**
 * The addresses of MCL-47, typed for `typedRoutes`.
 *
 * The content layer owns what these addresses say - which parameter carries the topic,
 * which anchor names a card - and it may not import from `next` (see the architecture
 * boundary test), so the widening to Next's `Route` happens here instead: once, at the
 * delivery boundary, rather than as a cast repeated at every `<Link>`.
 *
 * A cast is a promise the compiler stops checking, so the promise is kept elsewhere: the
 * shape of every string below is pinned in tests/unit/world-detail-content.test.ts, and
 * tests/e2e/world-detail.spec.ts follows each of them in a real browser. A wrong address
 * fails there, which is the only place it would actually hurt a child.
 */

export function overviewRoute(filter: CategoryFilter, anchorIdeaId?: string): Route {
  return overviewHref(filter, anchorIdeaId) as Route;
}

export function ideaDetailRoute(ideaId: string, filter: CategoryFilter): Route {
  return ideaDetailHref(ideaId, filter) as Route;
}

/** The overview, scrolled to the question a child can answer right now. */
export function focusQuestionRoute(filter: CategoryFilter): Route {
  return `${overviewHref(filter)}#frage` as Route;
}
