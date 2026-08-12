/**
 * Truth vocabulary used by the canonical design SSoT
 * (Confluence MLOA page 20250626 "02 - Game Design SSoT and Open Decisions").
 * Only values that page actually carries are allowed here.
 */
export type TruthStatus = "STATED" | "TENTATIVE" | "AMBIGUOUS" | "CONFLICT" | "OPEN";

export type SourceSystem = "jira" | "confluence";

/** Every Jira issue in this project lives in the MCL project. Malformed keys must not compile. */
export type JiraIssueKey = `MCL-${number}`;

export type SourceReference = Readonly<{
  system: SourceSystem;
  /** Jira issue key (MCL-7) or Confluence page id (20250626). */
  ref: string;
  url: string;
  /** Which statement on that source backs this entry. */
  note: string;
}>;

export const designSsotPage: SourceReference = {
  system: "confluence",
  ref: "20250626",
  url: "https://dyai2026.atlassian.net/wiki/spaces/MLOA/pages/20250626/02+Game+Design+SSoT+and+Open+Decisions",
  note: "Kanonische Begriffe und Leitplanken",
};

export function jiraSource(key: JiraIssueKey, note: string): SourceReference {
  return {
    system: "jira",
    ref: key,
    url: `https://dyai2026.atlassian.net/browse/${key}`,
    note,
  };
}

/**
 * The four states a child is ever shown. Shared by every content dataset in this
 * folder so no dataset has to import the child vocabulary from a sibling dataset.
 */
export type ChildStatus = "in-world" | "idea" | "open" | "tryout";

export type ChildStatusPresentation = Readonly<{
  id: ChildStatus;
  label: string;
  explanation: string;
  icon: string;
}>;

/**
 * Total lookup: a child status without a presentation is a compile error. There is
 * deliberately no fallback entry - defaulting an unknown status to "Schon dabei"
 * would tell a child that an undecided idea is already part of Avaloria.
 * Key order is the reading order of the child-facing legend.
 */
const childStatusPresentations = {
  "in-world": { id: "in-world", label: "Schon dabei", explanation: "Das gehört schon zu Avaloria.", icon: "✦" },
  idea: { id: "idea", label: "Eine Idee", explanation: "Das könnte später in Avaloria sein.", icon: "✎" },
  open: { id: "open", label: "Noch offen", explanation: "Das ist noch nicht entschieden.", icon: "?" },
  tryout: { id: "tryout", label: "Zum Ausprobieren", explanation: "Das können wir gemeinsam testen.", icon: "➜" },
} as const satisfies Record<ChildStatus, ChildStatusPresentation>;

export function childStatusPresentationFor(status: ChildStatus): ChildStatusPresentation {
  return childStatusPresentations[status];
}

/** Derived from the presentation table, so it can never fall out of sync with ChildStatus. */
export const allChildStatuses = Object.keys(childStatusPresentations) as ReadonlyArray<ChildStatus>;

/** The four status cards of the child-facing legend, in reading order. */
export const childStatusLegend: ReadonlyArray<ChildStatusPresentation> =
  Object.values(childStatusPresentations);

/**
 * The child view never shows the internal truth vocabulary. AMBIGUOUS and CONFLICT
 * both read as "noch offen" for a child: the project has not decided yet.
 * Only STATED may ever map to "in-world" - see the pinned mapping table in
 * tests/unit/avaloria-content.test.ts.
 */
export function childStatusFor(truthStatus: TruthStatus): ChildStatus {
  switch (truthStatus) {
    case "STATED":
      return "in-world";
    case "TENTATIVE":
      return "idea";
    case "AMBIGUOUS":
    case "CONFLICT":
    case "OPEN":
      return "open";
  }
}

/**
 * Internal owner taxonomy shared by every content dataset in this folder.
 * Stays finer-grained than the child view on purpose: MCL-19/MCL-29 require the
 * simplified child grouping to lose no owner information.
 * "prologue" and "main-story" must never be merged.
 */
export type InternalCategory =
  | "prologue"
  | "main-story"
  | "world-geography"
  | "creatures"
  | "progression"
  | "orders-and-roles"
  | "crafting"
  | "persistent-world";

/**
 * Total lookup: a new internal category without a child-facing topic label is a
 * compile error, and the label text stays free of project jargon.
 */
const childTopicLabels = {
  prologue: "Anfang der Geschichte",
  "main-story": "Hauptgeschichte",
  "world-geography": "Orte in Avaloria",
  creatures: "Wesen und Tiere",
  progression: "Größer werden",
  "orders-and-roles": "Gruppen und Rollen",
  crafting: "Bauen und Sammeln",
  "persistent-world": "Gemeinsame Welt",
} as const satisfies Record<InternalCategory, string>;

/** Derived from the label table, so it can never fall out of sync with InternalCategory. */
export const allInternalCategories = Object.keys(childTopicLabels) as ReadonlyArray<InternalCategory>;

/** Child-facing "Thema: ..." text for an internal owner category. */
export function childTopicLabelFor(internalCategory: InternalCategory): string {
  return childTopicLabels[internalCategory];
}

/**
 * Single product policy for language that must never reach a child: internal truth
 * vocabulary, delivery/engineering jargon and project tooling names. Every content
 * dataset in this folder is checked against this one list so the policy cannot drift
 * into per-dataset copies.
 */
export const childUnsafeVocabulary = [
  "Canon",
  "SSoT",
  "Divergenz",
  "IndexedDB",
  "Sync",
  "STATED",
  "TENTATIVE",
  "API",
  "Datenbank",
  "Hosting",
  "CI",
  "Security",
  "Jira",
  "Architektur",
  "Framework",
  "Server",
  "Deployment",
  "Backend",
  "Supabase",
  "Sprint",
] as const;
