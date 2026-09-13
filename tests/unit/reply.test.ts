import { describe, expect, it } from "vitest";
import {
  createReply,
  isReplyQuestionId,
  replyQuestionId,
  ReplyShapeError,
  type CreateReplyInput,
} from "@/domain/replies/reply";

/**
 * MCL-74. Pins the shape rules that keep a reply answerable.
 *
 * The failure these guard against is not a crash: every rule below has a "wrong" value
 * that stores perfectly and reaches a child as a card they cannot act on - two questions
 * to pick between, a question mark in the middle with text trailing after it, or four
 * sentences of preamble before the one thing they were asked. The store would accept all
 * of them. This is where they stop.
 */

const deps = {
  createId: () => "reply-1",
  now: () => new Date("2026-09-14T18:30:00.000Z"),
};

function input(overrides: Partial<CreateReplyInput> = {}): CreateReplyInput {
  return {
    submissionId: "sub-1",
    understood: "Du möchtest, dass der Wolf im Dunkeln leuchtet.",
    question: "Welche Farbe soll das Leuchten haben?",
    author: "human",
    ...overrides,
  };
}

function reasonOf(overrides: Partial<CreateReplyInput>): string {
  try {
    createReply(input(overrides), deps);
  } catch (error) {
    if (error instanceof ReplyShapeError) return error.reason;
    throw error;
  }
  throw new Error("expected createReply to refuse this input");
}

describe("reply question ids", () => {
  it("files every reply context under one prefix", () => {
    expect(replyQuestionId("abc")).toBe("reply:abc");
  });

  it("recognises a reply context and nothing else", () => {
    expect(isReplyQuestionId("reply:abc")).toBe(true);
    expect(isReplyQuestionId("frage-farben")).toBe(false);
    // The bare prefix names no submission: a card built from it would offer a child a
    // way to answer nothing at all.
    expect(isReplyQuestionId("reply:")).toBe(false);
  });
});

describe("createReply", () => {
  it("builds a frozen reply that names the submission it answers", () => {
    const reply = createReply(input(), deps);

    expect(reply.replyId).toBe("reply-1");
    expect(reply.submissionId).toBe("sub-1");
    expect(reply.questionId).toBe("reply:sub-1");
    expect(reply.author).toBe("human");
    expect(reply.createdAt).toBe("2026-09-14T18:30:00.000Z");
    expect(Object.isFrozen(reply)).toBe(true);
  });

  it("always files a human reply as ready, never as a fallback", () => {
    // A person who sat down and wrote two sentences did not write a fallback. Only the
    // future automated path may use that status.
    expect(createReply(input(), deps).status).toBe("ready");
  });

  it("reads what was typed without repairing it", () => {
    const reply = createReply(
      input({ understood: "  Du magst den Wolf.  ", question: "  Wie heißt er?  " }),
      deps,
    );
    expect(reply.understood).toBe("Du magst den Wolf.");
    expect(reply.question).toBe("Wie heißt er?");
  });

  it("accepts up to two sentences and refuses a third", () => {
    expect(
      createReply(input({ understood: "Das ist eine Idee. Sie gefällt mir." }), deps).understood,
    ).toBe("Das ist eine Idee. Sie gefällt mir.");
    expect(reasonOf({ understood: "Eins. Zwei. Drei." })).toBe("understood-too-many-sentences");
  });

  it("counts an abbreviation's dot as part of its sentence, not as a new one", () => {
    // "usw." mid-sentence would otherwise make one honest line read as two and refuse a
    // reply that is perfectly fine.
    const reply = createReply(
      input({ understood: "Wölfe, Drachen usw. gefallen dir am meisten." }),
      deps,
    );
    expect(reply.understood).toBe("Wölfe, Drachen usw. gefallen dir am meisten.");
  });

  it("treats a trailing ellipsis as one ending, not three", () => {
    const reply = createReply(input({ understood: "Du überlegst noch..." }), deps);
    expect(reply.understood).toBe("Du überlegst noch...");
  });

  it("accepts a line without any punctuation as one sentence", () => {
    expect(createReply(input({ understood: "Du magst den Wolf" }), deps).understood).toBe(
      "Du magst den Wolf",
    );
  });

  it("refuses a blank or over-long understood part", () => {
    expect(reasonOf({ understood: "   " })).toBe("understood-blank");
    expect(reasonOf({ understood: `${"a".repeat(401)}` })).toBe("understood-too-long");
  });

  it("accepts exactly the longest understood part the database will hold", () => {
    expect(createReply(input({ understood: "a".repeat(400) }), deps).understood.length).toBe(400);
  });

  it("refuses a blank or over-long question", () => {
    expect(reasonOf({ question: "   " })).toBe("question-blank");
    expect(reasonOf({ question: `${"a".repeat(200)}?` })).toBe("question-too-long");
  });

  it("insists on exactly one question, ending the sentence", () => {
    expect(reasonOf({ question: "Welche Farbe? Und welche Größe?" })).toBe("question-not-single");
    expect(reasonOf({ question: "Wie heißt er? Schreib es auf." })).toBe("question-not-single");
    expect(reasonOf({ question: "Das ist keine Frage." })).toBe("question-not-single");
  });

  it("refuses a reply that names no submission", () => {
    expect(() => createReply(input({ submissionId: "  " }), deps)).toThrow(ReplyShapeError);
  });

  it("refuses to mint a reply with a blank id", () => {
    expect(() => createReply(input(), { ...deps, createId: () => "  " })).toThrow(
      "generated reply id must not be blank",
    );
  });
});
