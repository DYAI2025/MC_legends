import { describe, expect, it } from "vitest";
import {
  answerToReplyMessage,
  FAMILY_REPLIER_LABEL,
  replyAnswerFieldLabel,
  replyAnswerToggleLabel,
  replyEmptyMessage,
  replyForSpokenIdea,
  replyForWrittenIdea,
  replyJumpLabel,
  replyLoadingMessage,
  replyQuestionLead,
  replyReadAloudLabel,
  replyRefusalSentence,
  replySectionHeading,
  replyStatusPill,
  replyUnderstoodLead,
} from "@/app/reply-message";
import type { ComposeReplyRefusal } from "@/application/replies/compose-reply";
import { expectChildSafe } from "../support/child-safe";

/**
 * MCL-74. The copy, checked without rendering anything.
 *
 * Two rules are pinned here that a reviewer would otherwise have to hold in their head
 * every time this file is edited: nothing a child reads may promise a time, and nothing
 * a child reads may claim the project adopted their idea. Both are easy to break with a
 * word that sounds friendlier.
 */

const childFacing: ReadonlyArray<[string, string]> = [
  ["understood lead", replyUnderstoodLead()],
  ["question lead", replyQuestionLead()],
  ["status pill", replyStatusPill()],
  ["empty message", replyEmptyMessage()],
  ["loading message", replyLoadingMessage()],
  ["written idea lead", replyForWrittenIdea()],
  ["spoken idea lead", replyForSpokenIdea("2026-09-14T18:30:00.000Z")],
  ["read aloud label", replyReadAloudLabel()],
  ["section heading", replySectionHeading()],
  ["jump label", replyJumpLabel()],
  ["answer toggle", replyAnswerToggleLabel()],
  ["answer field label", replyAnswerFieldLabel()],
  ["answer to reply label", answerToReplyMessage()],
];

describe("reply copy for children", () => {
  it("keeps every sentence free of project jargon", () => {
    for (const [name, text] of childFacing) {
      expectChildSafe(text, name);
    }
  });

  it("promises no timescale anywhere", () => {
    // "bald", "gleich", "in Kürze", "sofort", "morgen": each one is a promise about a
    // person's evening that this page has no way to keep.
    for (const [name, text] of childFacing) {
      expect(text, `${name} must not promise a time`).not.toMatch(
        /\b(bald|gleich|sofort|morgen|in Kürze|Minuten|Stunden)\b/iu,
      );
    }
  });

  it("never tells a child the project adopted their idea", () => {
    // "Schon dabei" is the legend's word for something that is really in Avaloria. A
    // reply is somebody having read an idea, not the project having taken it.
    for (const [name, text] of childFacing) {
      expect(text, `${name} must not claim adoption`).not.toContain("Schon dabei");
    }
    expect(replyStatusPill()).toContain("Eine Idee");
  });

  it("names the one person who answers", () => {
    expect(FAMILY_REPLIER_LABEL).toBe("Papa");
    expect(replyUnderstoodLead()).toContain(FAMILY_REPLIER_LABEL);
    expect(replyStatusPill()).toContain(FAMILY_REPLIER_LABEL);
  });

  it("offers a day for a spoken idea and quotes nothing of what was said", () => {
    const text = replyForSpokenIdea("2026-09-14T18:30:00.000Z");
    expect(text).toContain("14. September");
    expect(text).toContain("gesprochenen");
  });
});

describe("reply refusals for adults", () => {
  const reasons: ReadonlyArray<ComposeReplyRefusal> = [
    "understood-blank",
    "understood-too-long",
    "understood-too-many-sentences",
    "question-blank",
    "question-too-long",
    "question-not-single",
    "unsafe-vocabulary",
    "blocked-name",
  ];

  it("has a sentence for every reason, and each one says what to change", () => {
    for (const reason of reasons) {
      const sentence = replyRefusalSentence(reason);
      expect(sentence.trim(), reason).not.toBe("");
      expect(sentence, reason).not.toContain(reason);
    }
  });

  it("never repeats the offending name back to anybody", () => {
    // The check exists so the name stops travelling. An error message is travel.
    expect(replyRefusalSentence("blocked-name")).toMatch(/Name/u);
    expect(replyRefusalSentence("blocked-name").length).toBeLessThan(120);
  });
});

describe("MCL-75 reply-context label", () => {
  it("names whose question the answer belongs to", () => {
    expect(answerToReplyMessage()).toContain(FAMILY_REPLIER_LABEL);
  });

  it("never calls the answer orphaned", () => {
    // The failure this replaces: an answer to a reply falls through to the "belongs to
    // an earlier question" sentence, because no project question has a reply: id.
    expect(answerToReplyMessage()).not.toMatch(/früher|vorher|nicht mehr/iu);
  });
});
