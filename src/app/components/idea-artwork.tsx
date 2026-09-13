import Image from "next/image";
import type { ArtworkRef } from "@/content/content-source";

/**
 * MCL-71 / D1. The approved concept picture for one element of the world.
 *
 * A server component with no state and no hooks: the picture is a fact of the dataset,
 * not something the page decides at runtime, so nothing here needs to reach the client
 * as JavaScript.
 *
 * The counterpart of `IdeaEmblem`, not a replacement for it. The emblem is what an
 * element without approved artwork keeps wearing - deliberately abstract, so it makes
 * no claim about what the thing looks like. This component makes the opposite move: it
 * shows a picture the project has actually approved, and only ever for an element whose
 * dataset entry carries the provenance record that says so.
 *
 * The surrounding page keeps its "Konzeptbild" badge either way. These files are
 * approved *concept* anchors (MLOA:22544386, "Konzeptbild versus Runtime"), not final
 * game art, and dropping the badge because a picture looks finished would be the page
 * claiming a decision the project has not made.
 */

export type IdeaArtworkProps = Readonly<{
  artwork: ArtworkRef;
  variant: "card" | "hero";
  className?: string;
}>;

/**
 * What the browser is told the picture will occupy, so it can pick a source width
 * before layout runs. Card tiles sit in a responsive grid that tops out around a third
 * of the content column; the hero on a detail page is the content column.
 */
const sizesFor = {
  card: "(max-width: 640px) 92vw, (max-width: 1024px) 45vw, 30vw",
  hero: "(max-width: 900px) 92vw, 640px",
} as const satisfies Record<IdeaArtworkProps["variant"], string>;

export function IdeaArtwork({ artwork, variant, className }: IdeaArtworkProps) {
  const source = variant === "hero" ? artwork.hero : artwork;

  return (
    <Image
      alt={artwork.alt}
      className={className === undefined ? "idea-artwork" : `idea-artwork ${className}`}
      height={source.height}
      /*
        Cards are below the fold on every screen this site is used on, and a child
        scrolling the overview should not wait for pictures they have not reached. The
        hero is the first thing on its own page, so it is not deferred.
      */
      loading={variant === "card" ? "lazy" : "eager"}
      sizes={sizesFor[variant]}
      src={source.src}
      width={source.width}
    />
  );
}
