"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  QuestionBoardEntry,
  QuestionBoardPage,
  QuestionBoardResult,
  QuestionChangeResult,
} from "@/application/questions/question-board-client";
import type {
  QuestionLifecycleAction,
  QuestionState,
} from "@/domain/questions/question-lifecycle";
import { createBrowserQuestionBoardClient } from "@/composition/browser";

const boardClient = createBrowserQuestionBoardClient();

/**
 * The protected question board (MCL-35).
 *
 * Two verbs and nothing else: close a question, reopen one. There is deliberately no
 * control here that edits wording, reorders questions or removes one - the wording is
 * content that is reviewed and deployed, and a question is never removed because the
 * archive below is the point.
 *
 * Every button sends the state it is currently RENDERING as `expectedState`. That is the
 * whole optimistic-concurrency contract seen from this end: an adult acting on a board
 * they loaded an hour ago is refused with 409 and shown what actually holds, instead of
 * quietly undoing whatever happened in between.
 */

/**
 * What an adult reads when a read fails. A total table over the non-granted outcomes, so
 * a new one is a compile error here rather than a blank screen.
 */
const readFailureMessages = {
  denied: "Die Anmeldung gilt nicht mehr. Bitte neu anmelden.",
  "rate-limited": "Zu viele Abfragen. Bitte einen Moment warten.",
  unavailable: "Die Fragen sind gerade nicht erreichbar.",
  transport: "Die Fragen konnten gerade nicht geladen werden.",
} as const satisfies Record<Exclude<QuestionBoardResult["outcome"], "granted">, string>;

/**
 * What an adult reads when a change did not happen.
 *
 * `stale` is not in this table: it is answered with the state the server reported, so the
 * sentence can name it. A fixed string would tell somebody the board moved without
 * telling them where to.
 */
const changeFailureMessages = {
  denied: "Die Anmeldung gilt nicht mehr. Bitte neu anmelden.",
  "invalid-request": "Diese Änderung war nicht gültig. Bitte die Seite neu laden.",
  "rate-limited": "Zu viele Änderungen hintereinander. Bitte einen Moment warten.",
  unavailable: "Die Fragen sind gerade nicht erreichbar. Es wurde nichts geändert.",
  transport: "Die Änderung konnte nicht gesendet werden. Es wurde vielleicht nichts geändert.",
} as const satisfies Record<
  Exclude<QuestionChangeResult["outcome"], "applied" | "stale">,
  string
>;

const stateLabels = {
  open: "Offen",
  closed: "Geschlossen",
} as const satisfies Record<QuestionState, string>;

const actionLabels = {
  closed: "geschlossen",
  reopened: "wieder geöffnet",
} as const satisfies Record<QuestionLifecycleAction, string>;

export function AdminQuestionBoard() {
  const [page, setPage] = useState<QuestionBoardPage | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  /**
   * Which question has a change in flight, so one press cannot race another. One at a
   * time rather than one per question: two changes landing out of order would leave the
   * board showing an older answer as the newer one.
   */
  const [pendingId, setPendingId] = useState<string | null>(null);

  /**
   * Written as a `.then` rather than as an awaiting async body on purpose: every state
   * update has to happen in a promise callback, or the lint gate rejects the effect below
   * as a cascading render (react-hooks/set-state-in-effect). `family-experience.tsx`
   * keeps to the same rule for the same reason.
   */
  const load = useCallback(
    () =>
      boardClient.list().then((result) => {
        if (result.outcome === "granted") {
          setFailure(null);
          setPage(result.page);
        } else {
          // The stale board is dropped rather than left on screen: a list that keeps
          // showing the previous read under a failure message looks like an answer.
          setPage(null);
          setFailure(readFailureMessages[result.outcome]);
        }

        setIsLoading(false);
      }),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function change(entry: QuestionBoardEntry) {
    if (pendingId !== null) return;

    setPendingId(entry.id);
    setNotice(null);

    // The state this row is currently rendering, not one derived a second time: what the
    // adult saw is what the server is asked to check against.
    const nextState: QuestionState = entry.state === "open" ? "closed" : "open";
    const result = await boardClient.change(entry.id, nextState, entry.state);

    if (result.outcome === "stale") {
      setNotice(
        `Diese Frage ist inzwischen ${stateLabels[result.currentState].toLowerCase()}. Es wurde nichts geändert.`,
      );
    } else if (result.outcome !== "applied") {
      setNotice(changeFailureMessages[result.outcome]);
    }

    setPendingId(null);
    // Re-read in every case, including the failures: after a `transport` outcome nobody
    // knows whether the change landed, and the only honest next screen is what the server
    // says now.
    await load();
  }

  if (isLoading) {
    return (
      <section className="admin-questions" aria-label="Offene Fragen">
        <h2>Fragen</h2>
        <p role="status">Wird geladen …</p>
      </section>
    );
  }

  return (
    <section className="admin-questions" aria-label="Offene Fragen">
      <h2>Fragen</h2>

      {failure === null ? null : (
        <p className="form-message" role="status">
          {failure}
        </p>
      )}

      {notice === null ? null : (
        <p className="form-message" role="status">
          {notice}
        </p>
      )}

      {page === null ? null : (
        <>
          <ol className="admin-question-list">
            {page.questions.map((entry) => (
              <li className="admin-question" key={entry.id}>
                <div className="admin-question-copy">
                  <p className="admin-question-title">{entry.title}</p>
                  <p className={`admin-question-state admin-question-state-${entry.state}`}>
                    {entry.active ? "Wird gerade gefragt" : stateLabels[entry.state]}
                  </p>
                </div>
                <button
                  className="button button-secondary"
                  disabled={pendingId !== null}
                  onClick={() => void change(entry)}
                  type="button"
                >
                  {entry.state === "open" ? "Frage schließen" : "Wieder öffnen"}
                </button>
              </li>
            ))}
          </ol>

          <section className="admin-question-archive" aria-label="Verlauf">
            <h3>Verlauf</h3>
            {page.history.length === 0 ? (
              <p>Noch keine Frage geschlossen oder wieder geöffnet.</p>
            ) : (
              <>
                <ol className="admin-question-history">
                  {page.history.map((entry) => (
                    <li key={`${entry.questionId}-${entry.revision}`}>
                      {/*
                        The wording, or - for an event whose question is no longer in the
                        dataset - a plain statement that it is gone. Never the id: an
                        internal identifier on a screen is one in a screenshot.
                      */}
                      <span className="admin-question-history-title">
                        {entry.title ?? "Eine Frage, die es nicht mehr gibt"}
                      </span>{" "}
                      <span className="admin-question-history-action">
                        {actionLabels[entry.action]}
                      </span>{" "}
                      <span className="admin-question-history-when">{entry.occurredAt}</span>
                    </li>
                  ))}
                </ol>
                {page.historyTotal > page.history.length ? (
                  // Said out loud rather than implied: a truncated list nobody is told
                  // about reads as the whole archive.
                  <p className="admin-question-history-more">
                    {page.history.length} von {page.historyTotal} Einträgen. Ältere werden hier
                    nicht angezeigt.
                  </p>
                ) : null}
              </>
            )}
          </section>
        </>
      )}
    </section>
  );
}
