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
] as const satisfies ReadonlyArray<string>;
