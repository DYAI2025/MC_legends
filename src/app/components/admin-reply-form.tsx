"use client";

import { useEffect, useState } from "react";
import type { AdminReplyClient } from "@/application/replies/admin-reply-client";
import type { SubmissionReply } from "@/domain/replies/reply";
import {
  replyMissingSubmissionSentence,
  replyRefusalSentence,
  replySendFailedSentence,
} from "@/app/reply-message";

/**
 * MCL-74. Where an adult writes back.
 *
 * The counters are not decoration. The limits they show are the same numbers the domain
 * and migration 0004 enforce, and the failure they prevent is specific: writing three
 * careful sentences, pressing send, and being told to start again. The form refuses
 * nothing on its own - the server is the authority and its reason is what is displayed -
 * but it shows the boundary while there is still time to stay inside it.
 *
 * The history is loaded lazily, once per expanded card rather than once per page. An
 * inbox of two hundred submissions must not open two hundred requests to show a list
 * nobody has scrolled to.
 */

const MAX_UNDERSTOOD = 400;
const MAX_QUESTION = 200;

export type AdminReplyFormProps = Readonly<{
  client: AdminReplyClient;
  submissionId: string;
}>;

export function AdminReplyForm({ client, submissionId }: AdminReplyFormProps) {
  const [history, setHistory] = useState<readonly SubmissionReply[]>([]);
  const [understood, setUnderstood] = useState("");
  const [question, setQuestion] = useState("");
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void client.list(submissionId).then((result) => {
      if (cancelled || result.outcome !== "granted") return;
      setHistory(result.replies);
    });

    return () => {
      cancelled = true;
    };
  }, [client, submissionId]);

  async function send(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSending(true);
    setMessage(null);

    const result = await client.post(submissionId, { understood, question });

    setSending(false);

    if (result.outcome === "created") {
      // Prepended locally rather than re-fetched: the server just told us exactly what it
      // stored, and a second request would only be a slower way to learn the same thing.
      setHistory((current) => [...current, result.reply]);
      setUnderstood("");
      setQuestion("");
      return;
    }

    if (result.outcome === "invalid") {
      setMessage(replyRefusalSentence(result.reason));
      return;
    }

    if (result.outcome === "unknown-submission") {
      setMessage(replyMissingSubmissionSentence());
      return;
    }

    setMessage(replySendFailedSentence());
  }

  return (
    <div className="admin-reply">
      <h4>Antwort an das Kind</h4>

      {history.length === 0 ? null : (
        <ul className="admin-reply-history">
          {history.map((reply) => (
            <li key={reply.replyId}>
              <p className="admin-reply-understood">{reply.understood}</p>
              <p className="admin-reply-question">{reply.question}</p>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={(event) => void send(event)}>
        <label htmlFor={`understood-${submissionId}`}>Verstanden (höchstens 2 Sätze)</label>
        <textarea
          id={`understood-${submissionId}`}
          maxLength={MAX_UNDERSTOOD}
          onChange={(event) => setUnderstood(event.target.value)}
          value={understood}
        />
        <p className="admin-reply-counter">
          {understood.length} / {MAX_UNDERSTOOD}
        </p>

        <label htmlFor={`question-${submissionId}`}>
          Eine Frage an dich (genau ein Fragezeichen, am Ende)
        </label>
        <textarea
          id={`question-${submissionId}`}
          maxLength={MAX_QUESTION}
          onChange={(event) => setQuestion(event.target.value)}
          value={question}
        />
        <p className="admin-reply-counter">
          {question.length} / {MAX_QUESTION}
        </p>

        <div className="form-footer">
          <button className="button" disabled={sending} type="submit">
            {sending ? "Wird gesendet …" : "Antwort senden"}
          </button>
        </div>
      </form>

      {message === null ? null : (
        // role="status" rather than an alert: a refusal is information an adult acts on,
        // not an emergency, and this panel already sits where they are looking.
        <p className="admin-reply-message" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
