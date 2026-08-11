/**
 * Truth vocabulary used by the canonical design SSoT
 * (Confluence MLOA page 20250626 "02 - Game Design SSoT and Open Decisions").
 * Only values that page actually carries are allowed here.
 */
export type TruthStatus = "STATED" | "TENTATIVE" | "AMBIGUOUS" | "CONFLICT" | "OPEN";

export type SourceSystem = "jira" | "confluence";

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

export function jiraSource(key: string, note: string): SourceReference {
  return {
    system: "jira",
    ref: key,
    url: `https://dyai2026.atlassian.net/browse/${key}`,
    note,
  };
}
