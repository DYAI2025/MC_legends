import type { ChildStatus } from "@/content/content-source";

/**
 * A small abstract block picture for one idea. It is decoration with a job: every idea
 * gets its own recognisable shape, so a child who comes back to the overview finds the
 * card they opened by its picture and not only by its words.
 *
 * Deliberately abstract. Nothing here depicts a place, a creature or an event, because
 * the dataset has not decided what most of these things look like - a drawn dragon would
 * be new game lore smuggled in as artwork. Blocks in the project's own palette carry no
 * such claim, and the surrounding page keeps the "Konzeptbild" badge that says so.
 */

export type EmblemBlock = Readonly<{ column: number; height: number }>;

export type EmblemPalette = Readonly<{
  field: string;
  top: string;
  left: string;
  right: string;
}>;

/** How many stacks an emblem is built from. Exported so tests bound the geometry. */
export const emblemColumns = 4;

const maxBlockHeight = 4;

/**
 * FNV-1a. Chosen because it is short, has no dependencies and spreads the low bits -
 * the ids differ mostly in their tails ("world-kings-castle" / "world-dragon-caves"),
 * and a weaker sum would hand those two the same silhouette.
 */
function hashOf(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Same id, same picture - on the server, in the browser and across deployments. */
export function emblemBlocksFor(id: string): ReadonlyArray<EmblemBlock> {
  const hash = hashOf(id);
  return Array.from({ length: emblemColumns }, (_unused, column) => ({
    column,
    height: 1 + ((hash >>> (column * 5)) % maxBlockHeight),
  }));
}

/**
 * Total lookup: a new child status without a palette is a compile error. The colours are
 * the ones the status legend already teaches, so the picture and the badge above it
 * cannot tell a child two different things.
 */
const emblemPalettes = {
  "in-world": { field: "#e5f3d7", top: "#7bc46a", left: "#4f944e", right: "#3c7440" },
  idea: { field: "#fff1c7", top: "#f0c46a", left: "#c28b23", right: "#9a6d18" },
  open: { field: "#e0f1f5", top: "#6cc0d2", left: "#347f92", right: "#276574" },
  tryout: { field: "#eee4f7", top: "#a97fc6", left: "#80549d", right: "#64407c" },
} as const satisfies Record<ChildStatus, EmblemPalette>;

export function emblemPaletteFor(status: ChildStatus): EmblemPalette {
  return emblemPalettes[status];
}

/** Isometric projection constants, in viewBox units. */
const halfWidth = 30;
const halfDepth = 17;
const blockHeight = 34;
const originX = 46;
const originY = 92;

function cubeFaces(centreX: number, centreY: number) {
  return {
    top: `${centreX},${centreY - halfDepth} ${centreX + halfWidth},${centreY} ${centreX},${centreY + halfDepth} ${centreX - halfWidth},${centreY}`,
    left: `${centreX - halfWidth},${centreY} ${centreX},${centreY + halfDepth} ${centreX},${centreY + halfDepth + blockHeight} ${centreX - halfWidth},${centreY + blockHeight}`,
    right: `${centreX},${centreY + halfDepth} ${centreX + halfWidth},${centreY} ${centreX + halfWidth},${centreY + blockHeight} ${centreX},${centreY + halfDepth + blockHeight}`,
  };
}

export type IdeaEmblemProps = Readonly<{
  ideaId: string;
  status: ChildStatus;
  /** What a screen reader says. The caller knows which idea is being read. */
  label: string;
  className?: string;
}>;

export function IdeaEmblem({ ideaId, status, label, className }: IdeaEmblemProps) {
  const palette = emblemPaletteFor(status);
  const blocks = emblemBlocksFor(ideaId);
  const hash = hashOf(ideaId);

  return (
    <svg
      className={className}
      viewBox="0 0 192 224"
      role="img"
      aria-label={label}
      focusable="false"
    >
      <rect width="192" height="224" rx="22" fill={palette.field} />

      {/* Three small lights, placed from the same hash so they belong to this idea too.
          The motif is the hero art's, so the two pictures read as one world. */}
      <g fill="#fff8dc" opacity="0.9">
        {[0, 1, 2].map((spark) => (
          <rect
            key={spark}
            x={22 + ((hash >>> (spark * 7)) % 140)}
            y={16 + ((hash >>> (spark * 3 + 2)) % 34)}
            width={5 + (spark % 2)}
            height={5 + (spark % 2)}
          />
        ))}
      </g>

      {/* Front-to-back: each column sits one step nearer than the one before it, so a
          later column has to paint over its neighbour. Within a column, bottom first. */}
      {blocks.map((block) => {
        const columnX = originX + block.column * halfWidth;
        const columnY = originY + block.column * halfDepth;
        return (
          <g key={block.column}>
            {Array.from({ length: block.height }, (_unused, level) => {
              const faces = cubeFaces(columnX, columnY - level * blockHeight);
              return (
                <g key={level}>
                  <polygon points={faces.left} fill={palette.left} />
                  <polygon points={faces.right} fill={palette.right} />
                  <polygon points={faces.top} fill={palette.top} />
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}
