import { childForbiddenVocabulary as sharedForbiddenVocabulary } from "@/content/content-source";

/**
 * The single list every child-facing surface is checked against.
 *
 * Re-exported from src/content rather than assembled here. It used to be assembled here,
 * with the technical words kept out of the product on purpose - but MCL-74 lets an adult
 * type a reply a child hears read aloud, so the product has to apply the same list at
 * write time. Two assemblies would mean the weaker one decides.
 */
export const childForbiddenVocabulary: ReadonlyArray<string> = sharedForbiddenVocabulary;

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
