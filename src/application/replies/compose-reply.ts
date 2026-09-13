import {
  createReply,
  ReplyShapeError,
  type CreateReplyInput,
  type ReplyShapeReason,
  type SubmissionReply,
} from "@/domain/replies/reply";

/**
 * MCL-74. The one place a reply is checked before anything durable happens to it.
 *
 * Shape is a domain rule and lives in `createReply`; WORDS are a content policy and live
 * here. The split is not tidiness: the shape of a reply is true of every reply that will
 * ever exist, while the list of words unfit for a child is a dataset that changes without
 * the shape changing - and a domain that imported it would have to be redeployed to add
 * one noun.
 *
 * Both lists arrive as parameters rather than imports. That keeps this module free of
 * `src/content` (the layering rule) and, more usefully, makes the blocked names a value
 * the composition root reads from the environment - which is also why the variable that
 * holds them is not named here: it is a secret, and secrets are named in exactly one
 * module in this project.
 *
 * This is the last gate before the store. The child-facing route never sees a refused
 * reply, because a refused reply is never written.
 */

export type ComposeReplyRefusal = ReplyShapeReason | "unsafe-vocabulary" | "blocked-name";

export type ComposeReplyResult =
  | Readonly<{ ok: true; reply: SubmissionReply }>
  | Readonly<{ ok: false; reason: ComposeReplyRefusal }>;

export type ComposeReplyDependencies = Readonly<{
  /** Project jargon and technical language no child surface may carry. */
  forbiddenVocabulary: readonly string[];
  /** Real names that must never be written into something a child reads back. */
  blockedNames: readonly string[];
  createId: () => string;
  now: () => Date;
}>;

/**
 * Word boundaries, case-insensitive - the same matching `childUnsafeMentions` uses in
 * the test support helper, and deliberately the same shape rather than a similar one:
 * a reply is checked by exactly the rule every other child-facing string is checked by,
 * or the guarantee is only as good as whichever copy is weaker.
 *
 * Boundaries matter for both lists. Substring matching would let German "Papier" trip on
 * "api", and - the reason this is not a detail - a blocked child's name that happens to
 * sit inside an ordinary word would refuse every reply containing that word, until an
 * adult gave up and wrote around a filter nobody could see.
 */
function mentions(text: string, words: readonly string[]): boolean {
  return words.some((word) => {
    const trimmed = word.trim();
    if (trimmed.length === 0) return false;
    return new RegExp(`\\b${escapeForRegExp(trimmed)}\\b`, "iu").test(text);
  });
}

/** The list is operator-supplied, so it is matched literally and never as a pattern. */
function escapeForRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function composeReply(
  input: CreateReplyInput,
  dependencies: ComposeReplyDependencies,
): ComposeReplyResult {
  const text = `${input.understood} ${input.question}`;

  // Vocabulary before shape, deliberately. An adult who wrote a real name into a reply
  // should be told that first - it is the finding that matters - rather than being sent
  // away to fix a second question mark and only then learning the rest.
  if (mentions(text, dependencies.blockedNames)) {
    return { ok: false, reason: "blocked-name" };
  }
  if (mentions(text, dependencies.forbiddenVocabulary)) {
    return { ok: false, reason: "unsafe-vocabulary" };
  }

  try {
    return {
      ok: true,
      reply: createReply(input, { createId: dependencies.createId, now: dependencies.now }),
    };
  } catch (error) {
    if (error instanceof ReplyShapeError) {
      return { ok: false, reason: error.reason };
    }
    throw error;
  }
}
