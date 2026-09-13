import { describe, expect, it } from "vitest";
import { composeReply } from "@/application/replies/compose-reply";
import { avaloriaIdeas } from "@/content/avaloria-content";
import { childUnsafeVocabulary } from "@/content/content-source";

/**
 * MCL-74. The last gate before an adult's words become something a child reads back.
 *
 * Two failures are pinned here that no schema and no type can catch. The first is an
 * adult writing a real name into a reply, which the store would accept and the card
 * would read aloud. The second is the filter itself misfiring: a blocked name matched as
 * a substring would silently refuse every reply containing an ordinary German word, and
 * an adult would experience that as "the form is broken" with nothing on screen to say
 * why.
 *
 * Every name in this file is invented. No real child's name appears in any fixture, and
 * that is not a style rule - it is what the fixtures are testing the absence of.
 */

const BLOCKED = ["Testkind", "Musterkind"] as const;

function compose(overrides: { understood?: string; question?: string; blockedNames?: readonly string[] } = {}) {
  return composeReply(
    {
      submissionId: "sub-1",
      understood: overrides.understood ?? "Du möchtest, dass der Wolf leuchtet.",
      question: overrides.question ?? "Welche Farbe soll das Leuchten haben?",
      author: "human",
    },
    {
      forbiddenVocabulary: childUnsafeVocabulary,
      blockedNames: overrides.blockedNames ?? BLOCKED,
      createId: () => "reply-1",
      now: () => new Date("2026-09-14T18:30:00.000Z"),
    },
  );
}

describe("composeReply", () => {
  it("passes a reply that is well shaped and says nothing it should not", () => {
    const result = compose();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reply.questionId).toBe("reply:sub-1");
      expect(result.reply.author).toBe("human");
    }
  });

  it("refuses a reply that names a blocked name, in either half", () => {
    expect(compose({ understood: "Testkind hat das gesagt." })).toEqual({
      ok: false,
      reason: "blocked-name",
    });
    expect(compose({ question: "Was meint Musterkind dazu?" })).toEqual({
      ok: false,
      reason: "blocked-name",
    });
  });

  it("matches a blocked name case-insensitively", () => {
    expect(compose({ understood: "TESTKIND mag den Wolf." }).ok).toBe(false);
  });

  it("matches whole words only, so an ordinary word is not condemned by a name inside it", () => {
    // "Ente" sits inside "Entenhausen"; a substring filter would refuse a sentence that
    // never names anybody, and an adult would see a form that refuses for no visible
    // reason.
    const result = compose({
      understood: "Die Entenhausen-Idee gefällt mir.",
      blockedNames: ["Ente"],
    });
    expect(result.ok).toBe(true);
  });

  it("treats an operator's list entry as literal text, never as a pattern", () => {
    // A stray "." or "|" in the environment variable must not turn into a wildcard that
    // silently blocks far more than was intended.
    expect(compose({ understood: "Der Wolf leuchtet blau.", blockedNames: ["a.c"] }).ok).toBe(true);
    expect(compose({ understood: "Hier steht a.c im Satz.", blockedNames: ["a.c"] }).ok).toBe(false);
  });

  it("ignores blank entries in the list instead of blocking everything", () => {
    // A trailing comma in the environment variable yields an empty entry. A naive
    // implementation turns that into a pattern matching every string, and the reply form
    // stops working with no error anybody can read.
    expect(compose({ blockedNames: ["", "   ", "Testkind"] }).ok).toBe(true);
  });

  it("refuses project jargon reaching a child", () => {
    // "Sprint" is on the shared list in content-source.ts; the point is the mechanism,
    // so the fixture uses a word that list actually carries rather than one that sounds
    // like it should.
    expect(compose({ understood: "Die Idee kommt in den nächsten Sprint." })).toEqual({
      ok: false,
      reason: "unsafe-vocabulary",
    });
  });

  it("reports the shape problem when the words are fine", () => {
    expect(compose({ question: "Welche Farbe? Und welche Größe?" })).toEqual({
      ok: false,
      reason: "question-not-single",
    });
    expect(compose({ understood: "Eins. Zwei. Drei." })).toEqual({
      ok: false,
      reason: "understood-too-many-sentences",
    });
  });

  it("reports the name first when a reply is wrong in both ways", () => {
    // The name is the finding that matters. Sending an adult away to fix punctuation and
    // only then telling them about the name would be the wrong order to learn it in.
    expect(compose({ understood: "Testkind. Zwei. Drei." })).toEqual({
      ok: false,
      reason: "blocked-name",
    });
  });

  it("never blocks on a creature this project actually writes about", () => {
    // The names in the dataset are the subject of almost every reply an adult will type.
    // If one of them were ever added to the blocked list, replies about that creature
    // would become impossible to write and the reason would be invisible.
    for (const idea of avaloriaIdeas) {
      const result = compose({
        understood: `Du möchtest mehr über ${idea.title} wissen.`,
        blockedNames: BLOCKED,
      });
      expect(result.ok, `${idea.id} must remain writable about`).toBe(true);
    }
  });
});
