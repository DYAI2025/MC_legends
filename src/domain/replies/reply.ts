/**
 * MCL-74. What an adult writes back to a child about one submission.
 *
 * The shape is the product decision, not a formatting preference. A reply is exactly two
 * things - what was understood, and ONE question - because the loop this slice closes
 * depends on a child knowing what to answer. Two questions give a child a choice it did
 * not ask for and an adult a thread it cannot follow; none at all ends the exchange while
 * looking like a reply.
 *
 * Nothing here knows about HTTP, storage, or the child-unsafe vocabulary. Shape is a
 * domain rule because it is true of every reply that will ever exist; which WORDS are
 * unfit for a child is a content policy that changes without the shape changing, and it
 * lives one layer up in `composeReply`.
 */

/**
 * Who wrote it.
 *
 * `llm` exists in the type before anything produces one, and that is the point: MCL-76
 * swaps the author and reuses this whole contract rather than introducing a second kind
 * of reply that the child surface, the admin card and the store would each have to learn.
 */
export type ReplyAuthor = "human" | "llm";

/**
 * Whether the reply is the real thing.
 *
 * `fallback` is what a future automated path may write when it could not produce a proper
 * answer. `createReply` never produces one - a person who sat down and wrote two
 * sentences did not write a fallback - so today every stored reply is `ready`, and the
 * value is reserved rather than used.
 */
export type ReplyStatus = "ready" | "fallback";

/**
 * The id a follow-up answer is filed under.
 *
 * One prefix for every reply context, so the chain child → adult → child is a plain
 * equality query on a column that is already indexed. A template literal type rather
 * than `string`, so a call site cannot pass a raw submission id where the prefixed form
 * is meant and have it type-check.
 */
export type ReplyQuestionId = `reply:${string}`;

export type SubmissionReply = Readonly<{
  replyId: string;
  submissionId: string;
  understood: string;
  question: string;
  questionId: ReplyQuestionId;
  author: ReplyAuthor;
  status: ReplyStatus;
  /** ISO 8601, minted by the application. */
  createdAt: string;
}>;

export type CreateReplyInput = Readonly<{
  submissionId: string;
  understood: string;
  question: string;
  author: ReplyAuthor;
}>;

export type ReplyFactoryDependencies = Readonly<{
  createId: () => string;
  now: () => Date;
}>;

/**
 * Why a reply cannot be stored as written.
 *
 * A code rather than a sentence, because the two surfaces that render it need different
 * words: an adult gets a German sentence telling them what to change, and a child never
 * sees any of this at all. A shared message would have to be safe for both, and would
 * end up useful to neither.
 */
export type ReplyShapeReason =
  | "understood-blank"
  | "understood-too-long"
  | "understood-too-many-sentences"
  | "question-blank"
  | "question-too-long"
  | "question-not-single";

export class ReplyShapeError extends Error {
  constructor(
    readonly reason: ReplyShapeReason,
    message: string,
  ) {
    super(message);
    this.name = "ReplyShapeError";
  }
}

/** Mirrors `submission_reply_understood_len` in migration 0004. */
const MAX_UNDERSTOOD_LENGTH = 400;
/** Mirrors `submission_reply_question_len` in migration 0004. */
const MAX_QUESTION_LENGTH = 200;
/** Two sentences is what a child hears in one breath before the question arrives. */
const MAX_UNDERSTOOD_SENTENCES = 2;

export function replyQuestionId(submissionId: string): ReplyQuestionId {
  return `reply:${submissionId}`;
}

export function isReplyQuestionId(value: string): value is ReplyQuestionId {
  // `reply:` alone is not a reply context: it names no submission, and a card built from
  // it would offer a child a way to answer nothing.
  return value.startsWith("reply:") && value.length > "reply:".length;
}

/**
 * How many sentences the understood part is.
 *
 * Counts terminators followed by whitespace or the end of the text, so "Mugosh, Flammen-
 * wolf usw. gefallen dir." is one sentence and not two. An ellipsis is one terminator,
 * not three - a child who trails off has still only said one thing.
 */
function sentenceCount(text: string): number {
  const withoutEllipses = text.replaceAll("...", "…");
  const terminators = withoutEllipses.match(/[.!?…]+(?=\s|$)/gu);
  if (terminators === null) {
    // No terminator at all is still one sentence. Requiring punctuation would refuse a
    // perfectly good line an adult typed in a hurry, and refusing it helps nobody.
    return 1;
  }
  return terminators.length;
}

/**
 * Builds a reply or refuses it. Never repairs one.
 *
 * Trimming the ends is not repair - it is reading what was typed. Anything else (cutting
 * a third sentence, deleting a second question mark) would change what an adult said to
 * a child and then store it under their name.
 *
 * `status` is always `ready` here. A human reply is by construction not a fallback, and
 * a factory that could mint one would let an adult's own words be filed as a machine's
 * best effort.
 */
export function createReply(
  input: CreateReplyInput,
  dependencies: ReplyFactoryDependencies,
): SubmissionReply {
  const understood = input.understood.trim();
  const question = input.question.trim();

  if (understood.length === 0) {
    throw new ReplyShapeError("understood-blank", "the understood part must not be blank");
  }
  if (understood.length > MAX_UNDERSTOOD_LENGTH) {
    throw new ReplyShapeError(
      "understood-too-long",
      `the understood part must be at most ${MAX_UNDERSTOOD_LENGTH} characters`,
    );
  }
  if (sentenceCount(understood) > MAX_UNDERSTOOD_SENTENCES) {
    throw new ReplyShapeError(
      "understood-too-many-sentences",
      `the understood part must be at most ${MAX_UNDERSTOOD_SENTENCES} sentences`,
    );
  }

  if (question.length === 0) {
    throw new ReplyShapeError("question-blank", "the question must not be blank");
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    throw new ReplyShapeError(
      "question-too-long",
      `the question must be at most ${MAX_QUESTION_LENGTH} characters`,
    );
  }

  const questionMarks = question.match(/\?/gu)?.length ?? 0;
  if (questionMarks !== 1 || !question.endsWith("?")) {
    // Both halves matter. Two question marks are two questions; a question mark in the
    // middle is a question with a statement trailing after it, which a child reading
    // aloud will stop before ever reaching.
    throw new ReplyShapeError(
      "question-not-single",
      "the question must contain exactly one question mark and end with it",
    );
  }

  const submissionId = input.submissionId.trim();
  if (submissionId.length === 0) {
    throw new ReplyShapeError("question-blank", "a reply must name the submission it answers");
  }

  const replyId = dependencies.createId();
  if (replyId.trim().length === 0) {
    throw new Error("generated reply id must not be blank");
  }

  return Object.freeze({
    replyId,
    submissionId,
    understood,
    question,
    questionId: replyQuestionId(submissionId),
    author: input.author,
    status: "ready" as const,
    createdAt: dependencies.now().toISOString(),
  });
}
