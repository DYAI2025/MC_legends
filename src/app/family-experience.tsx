"use client";

import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { deliverSubmission } from "@/application/submissions/deliver-submission";
import { submitText } from "@/application/submissions/submit-text";
import {
  createBrowserSubmissionInbox,
  createBrowserSubmissionRepository,
} from "@/composition/browser";
import {
  hasArrivedInProject,
  submissionStatusLabel,
  type TextSubmission,
} from "@/domain/submissions/submission";
import { childFailureMessage, childMessageFor } from "@/app/child-submission-message";
import { AvaloriaHeroArt } from "@/app/components/avaloria-hero-art";
import { FamilyAccessGate } from "@/app/components/family-access-gate";
import {
  avaloriaIdeas,
  childCategories,
  type ChildCategory,
} from "@/content/avaloria-content";
import {
  childStatusFor,
  childStatusLegend,
  childStatusPresentationFor,
  childTopicLabelFor,
} from "@/content/content-source";
import { focusQuestion, otherOpenQuestions } from "@/content/open-questions";

const repository = createBrowserSubmissionRepository();
const inbox = createBrowserSubmissionInbox();
const question = focusQuestion();
const upcomingQuestions = otherOpenQuestions();

export type FamilyExperienceProps = Readonly<{
  /**
   * Whether this browser already holds a valid family session, as decided by the
   * server. A prop rather than something this component works out, because a client
   * cannot see the HttpOnly cookie and must not be the one deciding who may write.
   * It only chooses what is *shown*: the write path is protected on the server whether
   * this flag is right or not.
   */
  familySessionActive: boolean;
}>;

export function FamilyExperience({ familySessionActive }: FamilyExperienceProps) {
  const [selectedCategory, setSelectedCategory] = useState<ChildCategory | "Alle Ideen">("Alle Ideen");
  const [answer, setAnswer] = useState("");
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [submissions, setSubmissions] = useState<readonly TextSubmission[]>([]);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  // Keyed by submission id so a retry's outcome is shown at the entry it belongs to,
  // not in the form's status line far above the button the child actually pressed.
  const [retryMessages, setRetryMessages] = useState<Readonly<Record<string, string | undefined>>>(
    {},
  );
  const visibleIdeas = useMemo(
    () =>
      selectedCategory === "Alle Ideen"
        ? avaloriaIdeas
        : avaloriaIdeas.filter((idea) => idea.childCategory === selectedCategory),
    [selectedCategory],
  );

  const refreshSubmissions = useCallback(
    () =>
      repository.list().then(
        (stored) => setSubmissions(stored),
        // A failed local read must never break the page for a child. An empty list is
        // the only honest thing to show: this device cannot say what it holds.
        () => setSubmissions([]),
      ),
    [],
  );

  useEffect(() => {
    void refreshSubmissions();
  }, [refreshSubmissions]);

  async function handleAnswerSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (answer.trim().length === 0 || isSaving) return;

    setIsSaving(true);
    setSavedMessage(null);
    try {
      const saved = await submitText(
        { questionId: question.id, originalText: answer },
        repository,
        { createId: () => crypto.randomUUID(), now: () => new Date() },
      );
      setAnswer("");
      setSavedMessage("Deine Antwort ist gespeichert.");

      // Only the outcome of a real delivery attempt may change that sentence.
      setSavedMessage(childMessageFor(await deliverSubmission(saved, repository, inbox)));
    } catch {
      // submitText threw, so nothing was stored - the one case where a child must not
      // be told their answer is safe here.
      setSavedMessage(childFailureMessage("not-saved"));
    } finally {
      setIsSaving(false);
      await refreshSubmissions();
    }
  }

  async function handleRetry(submission: TextSubmission) {
    // One attempt at a time, so a second click cannot race the first and overwrite
    // its message with an older outcome.
    if (retryingId !== null) return;

    setRetryingId(submission.id);
    // Drop the previous outcome first, so a stale sentence cannot sit under the
    // button while the new attempt is still running.
    setRetryMessages((previous) =>
      Object.fromEntries(Object.entries(previous).filter(([id]) => id !== submission.id)),
    );

    try {
      const message = childMessageFor(await deliverSubmission(submission, repository, inbox));
      setRetryMessages((previous) => ({ ...previous, [submission.id]: message }));
    } catch {
      // deliverSubmission catches its own failures today, so nothing should reach
      // here - but that is a property of a different module, not of this call site. A
      // failure nobody can name is still a failure a child has to be told about, and
      // the answer is genuinely still stored, because it was listed from there.
      setRetryMessages((previous) => ({
        ...previous,
        [submission.id]: childMessageFor({ delivered: false, submission }),
      }));
    } finally {
      setRetryingId(null);
      await refreshSubmissions();
    }
  }

  return (
    <main className="site-shell">
      <nav className="topbar" aria-label="Hauptnavigation">
        <a className="brand" href="#start" aria-label="Avaloria Startseite">
          <span className="brand-mark" aria-hidden="true">A</span>
          <span>Avaloria</span>
        </a>
        <div className="topbar-links">
          <a href="#ideen">Ideen ansehen</a>
          <a href="#frage">Frage beantworten</a>
        </div>
        {/*
          "Mein Bereich" predated any personal area existing and pointed at the
          question form. Now that "Meine Ideen" is that area, one name and one target -
          two differently worded links to the same promise read as two places to an
          eight-year-old. This one stays in the top bar because .topbar-links is hidden
          on small screens, so it is the only route to the section on a phone.
        */}
        <a className="profile-button" href="#meine-ideen">Meine Ideen</a>
      </nav>

      <section className="hero" id="start" aria-labelledby="page-title">
        <div className="hero-copy">
          <p className="hero-kicker"><span aria-hidden="true">✦</span> Eine Welt zum Mitdenken</p>
          <h1 id="page-title">Deine Ideen machen Avaloria größer.</h1>
          <p className="hero-intro">
            Entdecke eine Welt aus grünen Tälern, mutigen Wesen und neuen Wegen. Du kannst eigene
            Ideen teilen und offene Fragen beantworten.
          </p>
          <div className="hero-actions">
            <a className="button button-primary" href="#ideen">Idee teilen <span aria-hidden="true">→</span></a>
            <a className="button button-secondary" href="#frage">Frage beantworten <span aria-hidden="true">→</span></a>
          </div>
          <p className="hero-note"><span aria-hidden="true">●</span> Für neugierige Entdeckerinnen und Entdecker von 8 bis 11</p>
        </div>
        <div className="hero-visual" aria-label="Konzeptbild von Avaloria">
          <div className="concept-badge">Konzeptbild · noch nicht fest</div>
          <AvaloriaHeroArt />
          <div className="visual-caption"><span aria-hidden="true">✦</span> Das helle Tal von Avaloria</div>
        </div>
      </section>

      <section className="status-section content-width" aria-labelledby="status-heading">
        <div className="section-heading">
          <div>
            <p className="section-kicker">So lesen wir Ideen</p>
            <h2 id="status-heading">Vier Zeichen zeigen dir, wo eine Idee steht.</h2>
          </div>
          <p className="section-support">Jede Karte erklärt sich selbst. Die Farbe ist nur eine Hilfe.</p>
        </div>
        <div className="status-grid">
          {childStatusLegend.map((status) => (
            <article className={`status-card status-${status.id}`} key={status.id}>
              <span className="status-icon" aria-hidden="true">{status.icon}</span>
              <div>
                <h3>{status.label}</h3>
                <p>{status.explanation}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="ideas-intro-section content-width" id="ideen" aria-labelledby="ideas-heading">
        <div className="section-heading ideas-heading">
          <div>
            <p className="section-kicker">Die Welt wächst</p>
            <h2 id="ideas-heading">Was möchtest du entdecken?</h2>
          </div>
          <p className="section-support">Wähle ein Thema. Die kleinen Karten zeigen dir die passenden Ideen.</p>
        </div>
        <div className="category-row" aria-label="Themen auswählen">
          <button
            className={`category-chip ${selectedCategory === "Alle Ideen" ? "is-selected" : ""}`}
            aria-pressed={selectedCategory === "Alle Ideen"}
            onClick={() => setSelectedCategory("Alle Ideen")}
            type="button"
          >
            Alle Ideen
          </button>
          {childCategories.map((category) => (
            <button
              className={`category-chip ${selectedCategory === category.label ? "is-selected" : ""}`}
              aria-pressed={selectedCategory === category.label}
              key={category.label}
              onClick={() => setSelectedCategory(category.label)}
              type="button"
            >
              <span aria-hidden="true">{category.icon}</span> {category.label}
            </button>
          ))}
        </div>
        <div className="idea-grid">
          {visibleIdeas.map((idea) => {
            const status = childStatusPresentationFor(childStatusFor(idea.truthStatus));
            return (
              <article className="idea-card" key={idea.id}>
                <div className="idea-card-topline">
                  <span className={`idea-status status-${status.id}`}>
                    <span aria-hidden="true">{status.icon}</span> {status.label}
                  </span>
                  <span className="idea-category">{idea.childCategory}</span>
                </div>
                <h3>{idea.title}</h3>
                <p>{idea.summary}</p>
                <span className="idea-owner">Thema: {childTopicLabelFor(idea.internalCategory)}</span>
              </article>
            );
          })}
        </div>
      </section>

      <section className="answer-section content-width" id="frage" aria-labelledby="question-heading">
        <div className="question-card">
          <div className="question-art" aria-hidden="true"><span>?</span></div>
          <div className="question-copy">
            <p className="section-kicker">Eine offene Frage</p>
            <h2 id="question-heading">{question.title}</h2>
            <p>{question.prompt}</p>
            {/*
              The question and the world stay readable for everyone; only writing is
              behind the family gate. The form is not merely disabled without a
              session - it is not rendered, so there is no field inviting an answer
              this browser is not yet allowed to send.
            */}
            {familySessionActive ? (
              <form onSubmit={handleAnswerSubmit}>
                <label htmlFor="answer">Deine Antwort</label>
                <textarea
                  id="answer"
                  value={answer}
                  onChange={(event) => setAnswer(event.target.value)}
                  placeholder={question.placeholder}
                  rows={4}
                />
                <div className="form-footer">
                  <button className="button button-primary" disabled={isSaving || answer.trim().length === 0} type="submit">
                    {isSaving ? "Wird gespeichert …" : "Antwort speichern"} <span aria-hidden="true">→</span>
                  </button>
                </div>
                {savedMessage ? <p className="form-message" role="status">{savedMessage}</p> : null}
              </form>
            ) : (
              <FamilyAccessGate />
            )}
          </div>
        </div>

        <div className="upcoming-questions" aria-labelledby="upcoming-heading">
          <h3 id="upcoming-heading">Diese Fragen kommen später dran</h3>
          <ul>
            {upcomingQuestions.map((upcoming) => (
              <li key={upcoming.id}>{upcoming.title}</li>
            ))}
          </ul>
        </div>
      </section>

      <section className="my-ideas-section content-width" id="meine-ideen" aria-labelledby="my-ideas-heading">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Meine Ideen</p>
            <h2 id="my-ideas-heading">Das hast du schon geschickt.</h2>
          </div>
          <p className="section-support">Hier siehst du, wo jede Antwort gerade ist.</p>
        </div>
        {submissions.length === 0 ? (
          <p className="my-ideas-empty">Noch keine Antwort. Deine erste Idee kommt hier hin.</p>
        ) : (
          <ul className="my-ideas-list">
            {submissions.map((submission) => {
              // The one rule this whole slice exists for: the arrived wording comes
              // from the stored status, which only a real receipt can produce.
              const arrived = hasArrivedInProject(submission.status);
              return (
                <li className="my-idea" key={submission.id}>
                  <p className="my-idea-text">{submission.originalText}</p>
                  {/*
                    Deliberately not the legend's status-* classes or icons. Those
                    signs are taught above as facts about Avaloria ("Schon dabei"), and
                    a submission wearing one would claim exactly what this slice keeps
                    unfakeable. Filled versus outlined, so the two read apart without
                    relying on colour.
                  */}
                  <p className={`my-idea-status ${arrived ? "my-idea-arrived" : "my-idea-local"}`}>
                    {submissionStatusLabel(submission.status)}
                  </p>
                  {arrived ? null : (
                    <button
                      className="button button-secondary"
                      disabled={retryingId !== null}
                      onClick={() => void handleRetry(submission)}
                      type="button"
                    >
                      {retryingId === submission.id ? "Wird gesendet …" : "Noch einmal senden"}
                    </button>
                  )}
                  {arrived || retryMessages[submission.id] === undefined ? null : (
                    // Only an entry that is still here needs a sentence explaining
                    // why. Once it arrived, the status above says so on its own, and
                    // repeating it would state the same thing twice.
                    <p className="my-idea-message" role="status">
                      {retryMessages[submission.id]}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <footer className="footer content-width">
        <span>✦ Avaloria</span>
        <span>Eine Welt, die gemeinsam wächst.</span>
      </footer>
    </main>
  );
}
