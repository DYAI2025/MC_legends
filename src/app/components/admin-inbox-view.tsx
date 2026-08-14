"use client";

import { useCallback, useEffect, useState } from "react";
import { buildInboxQuery, EMPTY_FILTERS, type AdminFilterState } from "@/app/admin-inbox-query";
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
    try {
      const result = await inboxClient.list(buildInboxQuery(active));

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
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(filters);
  }, [filters, load]);

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
            value={filters.questionId}
            onChange={(event) =>
              applyFilters((current) => ({ ...current, questionId: event.target.value }))
            }
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
          onClick={() => applyFilters(() => ({ ...EMPTY_FILTERS }))}
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
        <p role="status">{failure === null ? "Wird geladen …" : ""}</p>
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
        The child's words, alone in their own labelled region and rendered as text.
        `white-space: pre-wrap` in the stylesheet keeps the leading, trailing and
        repeated spaces the store preserved byte for byte - collapsing them here would
        display something the child did not write.
      */}
      <section className="admin-original" aria-label="Originaltext">
        <h3>Originaltext</h3>
        <p className="admin-original-text">{entry.originalText}</p>
      </section>

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
