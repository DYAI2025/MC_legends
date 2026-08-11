import { childUnsafeVocabulary } from "@/content/content-source";

/**
 * Technical language that is not project vocabulary but must not reach a child
 * either: transport words, status codes and failure-report nouns. Kept here rather
 * than in src, because it describes what a test must never find - the product has no
 * reason to know these words at all.
 */
const technicalVocabulary = ["HTTP", "500", "503", "fetch", "Timeout", "Stack"] as const;

/** The single list every child-facing surface is checked against. */
export const childForbiddenVocabulary: ReadonlyArray<string> = [
  ...childUnsafeVocabulary,
  ...technicalVocabulary,
];

/**
 * Word boundaries, not substrings: German "Papier" contains "api" and would otherwise
 * condemn a perfectly good sentence. Case-insensitive, because these are authored
 * German sentences in which "server" is exactly as unfit as "Server".
 */
export function childUnsafeMentions(text: string): ReadonlyArray<string> {
  return childForbiddenVocabulary.filter((word) => new RegExp(`\\b${word}\\b`, "iu").test(text));
}

/**
 * Throws rather than asserting, so the same policy runs unchanged under Vitest and
 * under Playwright. A thrown error fails a test in both; importing either runner's
 * `expect` here would tie the rule to one of them.
 */
export function expectChildSafe(text: string, context: string): void {
  const mentions = childUnsafeMentions(text);
  if (mentions.length > 0) {
    throw new Error(
      `${context} must not expose ${mentions.join(", ")} - found in ${JSON.stringify(text)}`,
    );
  }
}
