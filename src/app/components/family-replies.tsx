"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { FamilyReplyClient } from "@/application/replies/family-reply-client";
import type { ReplyView } from "@/application/replies/submission-reply-reader";
import type { SpokenTextReader } from "@/application/media/spoken-text-reader";
import { AudioAnswerRecorder } from "@/app/components/audio-answer-recorder";
import {
  replyEmptyMessage,
  replyForSpokenIdea,
  replyForWrittenIdea,
  replyLoadingMessage,
  replyQuestionLead,
  replyAnswerFieldLabel,
  replyAnswerToggleLabel,
  replyReadAloudLabel,
  replySectionHeading,
  replyStatusPill,
  replyUnderstoodLead,
} from "@/app/reply-message";

/**
 * MCL-74. What came back, on the child's own page.
 *
 * Three decisions are visible in this file and none of them is a style choice:
 *
 * - A failed read shows NOTHING new. Not an error, not an empty list, not a retry
 *   button. The list a child can already see stays exactly as it was, because the only
 *   honest thing to say about a poll that missed is nothing - and an apology every sixty
 *   seconds would teach a child the project is broken when the tablet simply lost the
 *   wifi for four seconds.
 * - The poll pauses while the tab is hidden. A page left open overnight must not spend a
 *   household's rate-limit allowance on a screen nobody is looking at.
 * - "Vorlesen" is absent, never disabled, where the device has no voice. A greyed-out
 *   control is a thing a child will keep pressing.
 *
 * Replies are read per HOUSEHOLD, not per child (decision 4, Confluence 13B): the family
 * session is one code for the family, so both children see every reply. That is a
 * documented limit of the Family MVP, and the card carries the original excerpt or the
 * day of the recording so a child can tell which of these is theirs.
 */

/** Long enough that a household's allowance is never the binding constraint. */
const POLL_INTERVAL_MS = 60_000;

export type FamilyRepliesProps = Readonly<{
  client: FamilyReplyClient;
  reader: SpokenTextReader;
  /** Overridable so a test does not have to wait a minute to prove the poll runs. */
  pollIntervalMs?: number;
  /**
   * MCL-75. Sends a typed answer back under the reply's own questionId.
   *
   * A callback rather than this component owning the submission path: the repository,
   * the inbox port and the child-facing delivery messages already live one level up,
   * and a second copy of that flow here would be a second place for "angekommen" to
   * mean something slightly different.
   */
  onAnswer?: (questionId: string, text: string) => Promise<string>;
}>;

export function FamilyReplies({ client, reader, pollIntervalMs, onAnswer }: FamilyRepliesProps) {
  // Which card is open, which one is sending, and what it was told. Keyed by reply id so
  // two cards cannot share a state - opening the second must not close the first or
  // move the first card's message under it.
  const [openCard, setOpenCard] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [answerMessages, setAnswerMessages] = useState<Record<string, string>>({});
  const [replies, setReplies] = useState<readonly ReplyView[] | null>(null);
  const interval = pollIntervalMs ?? POLL_INTERVAL_MS;

  const refresh = useCallback(async () => {
    const result = await client.list();

    if (result.outcome !== "granted") {
      // Deliberately nothing. See the note at the top of this file: a miss is silence.
      return;
    }

    setReplies(result.replies);
  }, [client]);

  useEffect(() => {
    let cancelled = false;

    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      void refresh().catch(() => {
        // The port promises it never throws; this is belt and braces so a future adapter
        // cannot turn a missed poll into an unhandled rejection on a child's page.
      });
    };

    /*
      The first read is scheduled rather than awaited inline. Not a lint workaround: a
      render that kicks off its own state update synchronously is a render that can
      commit twice for one mount, and on a page a child reloads all day that shows up as
      the reply list flickering in. Scheduling it puts the first read on the same footing
      as every later one.
    */
    const initial = setTimeout(tick, 0);
    const timer = setInterval(tick, interval);

    // A tab coming back to the front should not wait up to a minute to catch up.
    const onVisible = () => {
      if (!cancelled && typeof document !== "undefined" && !document.hidden) tick();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      clearTimeout(initial);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      // A card that leaves the screen stops talking.
      reader.cancel();
    };
  }, [interval, reader, refresh]);

  async function sendAnswer(event: FormEvent<HTMLFormElement>, replyId: string, questionId: string) {
    event.preventDefault();
    if (onAnswer === undefined || sendingId !== null) return;

    const text = answers[replyId] ?? "";
    if (text.trim().length === 0) return;

    setSendingId(replyId);
    // Drop the previous outcome first, so a stale sentence cannot sit under the button
    // while the new attempt is still running.
    setAnswerMessages((previous) =>
      Object.fromEntries(Object.entries(previous).filter(([id]) => id !== replyId)),
    );

    const message = await onAnswer(questionId, text);

    setSendingId(null);
    setAnswerMessages((previous) => ({ ...previous, [replyId]: message }));
    setAnswers((previous) => ({ ...previous, [replyId]: "" }));
  }

  return (
    <section className="reply-section content-width" id="antworten" aria-labelledby="replies-heading">
      <h2 id="replies-heading">{replySectionHeading()}</h2>

      {replies === null ? (
        // Static text rather than a spinner: nothing animates here, so `prefers-reduced-
        // motion` needs no special case and a slow connection needs no explanation.
        <p className="reply-empty">{replyLoadingMessage()}</p>
      ) : replies.length === 0 ? (
        <p className="reply-empty">{replyEmptyMessage()}</p>
      ) : (
        <ul className="reply-list">
          {replies.map((view) => (
            <li className="reply-card" id={`antwort-${view.reply.submissionId}`} key={view.reply.replyId}>
              {/*
                Built from the idea vocabulary and deliberately NOT wearing the legend's
                status-* classes. Those signs are taught elsewhere as facts about
                Avaloria; a reply is somebody having read an idea, not the project having
                taken it, and a card that borrowed the badge would make the one status a
                child trusts most fakeable.
              */}
              <p className="reply-pill">{replyStatusPill()}</p>

              <p className="reply-origin">
                {view.submission.kind === "audio"
                  ? replyForSpokenIdea(view.submission.createdAt)
                  : replyForWrittenIdea()}
              </p>
              {view.submission.originalTextExcerpt === null ? null : (
                <p className="reply-origin-text">{view.submission.originalTextExcerpt}</p>
              )}

              <p className="reply-lead">{replyUnderstoodLead()}</p>
              <p className="reply-understood">{view.reply.understood}</p>

              <p className="reply-lead">{replyQuestionLead()}</p>
              <p className="reply-question">{view.reply.question}</p>

              <div className="reply-actions">
                {reader.supported ? (
                  <button
                    className="button button-secondary"
                    onClick={() =>
                      reader.speak(`${view.reply.understood} ${view.reply.question}`, "de-DE")
                    }
                    type="button"
                  >
                    {replyReadAloudLabel()}
                  </button>
                ) : null}

                {onAnswer === undefined ? null : (
                  <button
                    aria-expanded={openCard === view.reply.replyId}
                    className="button"
                    onClick={() =>
                      setOpenCard((current) =>
                        current === view.reply.replyId ? null : view.reply.replyId,
                      )
                    }
                    type="button"
                  >
                    {replyAnswerToggleLabel()}
                  </button>
                )}
              </div>

              {/*
                MCL-75. Both ways back, bound to the reply's own questionId.

                The recorder is the same component the focus question uses, given a
                different id - which is the whole reason `reply:<submissionId>` is one
                prefix and not a second format: the write routes already accept it, so
                answering an adult's question needed no new endpoint and no new shape.

                Revealed rather than always present: a child looking at three replies
                should see three answers, not three forms.
              */}
              {onAnswer !== undefined && openCard === view.reply.replyId ? (
                <div className="reply-answer">
                  <form onSubmit={(event) => void sendAnswer(event, view.reply.replyId, view.reply.questionId)}>
                    <label htmlFor={`antwort-text-${view.reply.replyId}`}>
                      {replyAnswerFieldLabel()}
                    </label>
                    <textarea
                      id={`antwort-text-${view.reply.replyId}`}
                      onChange={(event) =>
                        setAnswers((previous) => ({
                          ...previous,
                          [view.reply.replyId]: event.target.value,
                        }))
                      }
                      value={answers[view.reply.replyId] ?? ""}
                    />
                    <div className="form-footer">
                      <button className="button" disabled={sendingId !== null} type="submit">
                        {sendingId === view.reply.replyId ? "Wird gesendet …" : "Antwort speichern"}
                      </button>
                    </div>
                  </form>

                  <AudioAnswerRecorder questionId={view.reply.questionId} />

                  {answerMessages[view.reply.replyId] === undefined ? null : (
                    <p className="reply-answer-message" role="status">
                      {answerMessages[view.reply.replyId]}
                    </p>
                  )}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
