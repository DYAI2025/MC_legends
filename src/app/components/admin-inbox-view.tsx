"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildInboxQuery,
  createLatestOnly,
  EMPTY_FILTERS,
  QUESTION_FILTER_DEBOUNCE_MS,
  type AdminFilterState,
} from "@/app/admin-inbox-query";
import type { AdminInboxResult } from "@/application/submissions/admin-inbox-client";
import type { InboxEntry, InboxPage } from "@/application/submissions/submission-inbox-reader";
import { createBrowserAdminInboxClient } from "@/composition/browser";

const inboxClient = createBrowserAdminInboxClient();

/**
 * What an adult reads when a read fails. A total table over the non-granted outcomes,
 * so a new one is a compile error here rather than a blank screen.
 */
const failureMessages = {
  denied: "Die Anmeldung gilt nicht mehr. Bitte neu anmelden.",
  "invalid-query": "Diese Filterkombination ist nicht gültig. Bitte die Auswahl ändern.",
  "rate-limited": "Zu viele Abfragen. Bitte einen Moment warten.",
  unavailable: "Das Postfach ist gerade nicht erreichbar.",
  transport: "Das Postfach konnte gerade nicht geladen werden.",
} as const satisfies Record<Exclude<AdminInboxResult["outcome"], "granted">, string>;

/**
 * The protected read surface (MCL-50).
 *
 * Read-only by construction: there is no control here that writes, and the route it
 * reads from exports no mutation verb. Nothing on this screen can change a child's
 * original answer.
 *
 * The original artifact and everything derived from it are kept in separate, separately
 * labelled regions. AGENTS.md requires that separation, and a card that mixed the
 * child's words with system metadata would erase it exactly where somebody is about to
 * read those words and decide what they are. Today the derived side is only what the
 * system itself recorded - receipt, status, timestamps - and no transcript or model
 * output exists yet; the structure is here so that when one does, there is an obvious
 * place for it that is not next to the original.
 */
export function AdminInboxView() {
  const [filters, setFilters] = useState<AdminFilterState>(EMPTY_FILTERS);
  const [page, setPage] = useState<InboxPage | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  /**
   * What the question box currently shows, which runs ahead of the committed filter
   * while somebody is still typing. `filters` stays the query the list actually answers,
   * so the two never disagree about what is on screen: the list always shows the results
   * of the committed filter, and the only window where the box is ahead of the list is
   * the debounce interval itself.
   */
  const [questionDraft, setQuestionDraft] = useState(EMPTY_FILTERS.questionId);

  const router = useRouter();

  /**
   * One sequence per mounted view, so a read issued here can only be superseded by a
   * later read from this same view.
   *
   * `useState` with the factory itself rather than `useRef(createLatestOnly())`: React
   * invokes a lazy initialiser once per mount, so exactly one sequence is created as well
   * as used. The `useRef` form evaluates the factory on every render and throws the result
   * away, which made the comment above true of what was used and false of what was built.
   */
  const [sequence] = useState(createLatestOnly);

  /**
   * Whether this view has already asked the server to re-decide who is signed in.
   *
   * A denied read means the server will now render the sign-in panel instead of this view,
   * so the fix is to ask it to: `router.refresh()` re-runs the server component that chose
   * this branch. Without it an adult reads "bitte neu anmelden" on a screen carrying
   * nothing to sign in with, and has to work out for themselves that a reload is needed.
   *
   * Scope of this guard, stated precisely because it is easy to overclaim: it is a ref, so
   * it is per-MOUNT. It stops two concurrent denied reads from both calling refresh within
   * one mount. It does NOT bound a mount -> refresh -> mount cycle, because a refresh
   * remounts this view and the ref starts over.
   *
   * What actually guarantees termination is time, not this ref. The page and the route
   * verify the same cookie through the same gate, so they disagree only in the instant
   * around expiry - page still granted, route already denied. The next server render is
   * later than the one that granted, so it lands past the boundary and renders the sign-in
   * panel, which unmounts this view and ends the sequence. If a loop is ever observed here,
   * the bug is that the page and the route disagree persistently, and that is a finding to
   * report rather than something to paper over with a retry counter.
   */
  const hasRequestedReauth = useRef(false);

  /**
   * Moves the controls and marks the list as loading in the same event.
   *
   * The "loading" flag is raised here rather than at the top of `load`, because a
   * setState that runs synchronously inside an effect body is a cascading render the
   * lint gate rejects (react-hooks/set-state-in-effect) - `family-experience.tsx` keeps
   * to the same rule by only ever setting state from a promise callback. Raising it
   * where the filter actually changes is also the more honest place: the list becomes
   * stale the moment an adult moves a control, not once a request happens to start.
   */
  const applyFilters = useCallback(
    (next: (current: AdminFilterState) => AdminFilterState) => {
      setIsLoading(true);
      setFilters(next);
    },
    [],
  );

  const load = useCallback(async (active: AdminFilterState) => {
    const ticket = sequence.issue();

    try {
      const result = await inboxClient.list(buildInboxQuery(active));

      // A superseded read is discarded in silence - including a superseded failure, so a
      // stale `transport` error cannot replace the fresh page that overtook it. Reads can
      // resolve in any order, and the newest filter is the only question being asked.
      if (!sequence.isLatest(ticket)) return;

      if (result.outcome === "granted") {
        setFailure(null);
        setPage(result.page);
        return;
      }

      // The stale page is dropped rather than left on screen: a list that keeps showing
      // the previous filter's results under the new filter's controls is worse than an
      // empty screen, because it looks like an answer.
      setPage(null);
      setFailure(failureMessages[result.outcome]);

      // Only `denied`. The other outcomes do not mean the session is gone, and refreshing
      // on `rate-limited` in particular would add load to the exact condition that caused
      // it. `unavailable`, `invalid-query` and `transport` are all states an adult can act
      // on from this screen; a lapsed session is the one that needs a different screen.
      if (result.outcome === "denied" && !hasRequestedReauth.current) {
        hasRequestedReauth.current = true;
        router.refresh();
      }
    } finally {
      // Guarded too. An older read finishing must not lower the flag while the newest is
      // still running, or the page underneath would be presented as the finished answer.
      if (sequence.isLatest(ticket)) setIsLoading(false);
    }
  }, [router, sequence]);

  useEffect(() => {
    void load(filters);
  }, [filters, load]);

  /**
   * Commits the typed question once typing pauses.
   *
   * Only this one control is debounced; the selects and the reset button call
   * `applyFilters` directly and commit at once. Committing produces a fresh filter object,
   * so the read effect above always re-runs and always clears the loading flag - the
   * early return here is safe precisely because a keystroke does not raise that flag.
   */
  useEffect(() => {
    if (questionDraft === filters.questionId) return;

    const timer = setTimeout(() => {
      applyFilters((current) => ({ ...current, questionId: questionDraft }));
    }, QUESTION_FILTER_DEBOUNCE_MS);

    // Runs on unmount as well as before the next keystroke, so a pending timer can never
    // set state on a view that is no longer on screen.
    return () => clearTimeout(timer);
  }, [questionDraft, filters.questionId, applyFilters]);

  return (
    <section className="admin-inbox" aria-label="Eingegangene Antworten">
      <form
        className="admin-filters"
        aria-label="Filter"
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="admin-filter">
          <label htmlFor="filter-status">Status</label>
          <select
            id="filter-status"
            value={filters.status}
            onChange={(event) =>
              applyFilters((current) => ({
                ...current,
                status: event.target.value as AdminFilterState["status"],
              }))
            }
          >
            <option value="">Alle</option>
            <option value="RECEIVED">RECEIVED</option>
          </select>
        </div>

        <div className="admin-filter">
          <label htmlFor="filter-kind">Art</label>
          <select
            id="filter-kind"
            value={filters.kind}
            onChange={(event) =>
              applyFilters((current) => ({
                ...current,
                kind: event.target.value as AdminFilterState["kind"],
              }))
            }
          >
            <option value="">Alle</option>
            <option value="text">text</option>
          </select>
        </div>

        <div className="admin-filter">
          <label htmlFor="filter-question">Frage</label>
          <input
            id="filter-question"
            type="text"
            autoComplete="off"
            value={questionDraft}
            onChange={(event) => setQuestionDraft(event.target.value)}
          />
        </div>

        <button
          className="button"
          type="button"
          // A fresh object, never the EMPTY_FILTERS constant itself. Resetting when
          // nothing was filtered would otherwise hand useState the reference it already
          // holds, React would keep the state identical, and the effect - keyed on that
          // reference - would never re-run to clear the loading flag this click just
          // raised. The list would sit behind "Wird geladen …" with no request in
          // flight. The other controls cannot hit this: they spread into a new object.
          // Clears the box as well as the query, so no pending keystroke can commit
          // itself after the reset and quietly re-filter the list.
          onClick={() => {
            setQuestionDraft(EMPTY_FILTERS.questionId);
            applyFilters(() => ({ ...EMPTY_FILTERS }));
          }}
        >
          Filter zurücksetzen
        </button>
      </form>

      {failure === null ? null : (
        <p className="form-message" role="status">
          {failure}
        </p>
      )}

      {isLoading || page === null ? (
        // Nothing rather than an empty live region. An empty `role="status"` announces
        // nothing, so a second one competing with the failure message above is pure noise
        // for a screen reader - and it made `getByRole("status")`, a strict locator, match
        // two elements and throw instead of failing usefully. When a failure is showing,
        // that message is left as the only thing speaking.
        failure === null ? <p role="status">Wird geladen …</p> : null
      ) : (
        <>
          <p className="admin-count" role="status">
            {page.total === 0
              ? "Keine Antworten für diese Auswahl."
              : `${page.entries.length} von ${page.total} Antworten`}
          </p>
          <ol className="admin-entries">
            {page.entries.map((entry) => (
              <AdminInboxCard entry={entry} key={entry.submissionId} />
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

function AdminInboxCard({ entry }: { entry: InboxEntry }) {
  return (
    <li className="admin-entry">
      {/*
        The child's own answer, alone in its own labelled region.

        Branched on `kind` rather than reading one field that might hold either. A spoken
        answer's original is the recording, and MCL-49 keeps the bytes out of this payload
        entirely - so the audio branch shows what was recorded about it and reaches the
        recording itself through the separate authorized route, never through a URL carried
        in the listing.
      */}
      {entry.kind === "text" ? (
        <section className="admin-original" aria-label="Originaltext">
          <h3>Originaltext</h3>
          {/*
            Rendered as text. `white-space: pre-wrap` in the stylesheet keeps the leading,
            trailing and repeated spaces the store preserved byte for byte - collapsing
            them here would display something the child did not write.
          */}
          <p className="admin-original-text">{entry.originalText}</p>
        </section>
      ) : (
        <section className="admin-original" aria-label="Originalaufnahme">
          <h3>Originalaufnahme</h3>
          <dl className="admin-original-audio">
            <dt>Format</dt>
            <dd>{entry.audio.mimeType}</dd>
            <dt>Groesse</dt>
            <dd>{entry.audio.sizeBytes} Bytes</dd>
            {/*
              The hash, so an adult can check a stored file against what the database says
              it should be. The object key is deliberately NOT shown: it is a filesystem
              path, and a path on screen is a path in a screenshot.
            */}
            <dt>SHA-256</dt>
            <dd className="admin-original-hash">{entry.audio.sha256}</dd>
          </dl>
        </section>
      )}

      {/* Everything the system recorded about that text - never the text itself. */}
      <section className="admin-derived" aria-label="Systemangaben">
        <h3>Systemangaben</h3>
        <dl>
          <dt>Frage</dt>
          <dd>{entry.questionId}</dd>
          <dt>Art</dt>
          <dd>{entry.kind}</dd>
          <dt>Status</dt>
          <dd>{entry.status}</dd>
          <dt>Geschrieben am</dt>
          <dd>{entry.createdAt}</dd>
          <dt>Eingegangen am</dt>
          <dd>{entry.receivedAt}</dd>
          <dt>Quittung</dt>
          <dd>{entry.receiptId}</dd>
          <dt>Einsendung</dt>
          <dd>{entry.submissionId}</dd>
        </dl>
      </section>
    </li>
  );
}
