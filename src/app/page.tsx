"use client";

import { type FormEvent, useState } from "react";
import { submitText } from "@/application/submissions/submit-text";
import { createBrowserSubmissionRepository } from "@/composition/browser";
import { AvaloriaHeroArt } from "@/app/components/avaloria-hero-art";
import { childStatusMeta, currentQuestion } from "@/content/avaloria-content";

const repository = createBrowserSubmissionRepository();

export default function HomePage() {
  const [answer, setAnswer] = useState("");
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  async function handleAnswerSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (answer.trim().length === 0 || isSaving) return;

    setIsSaving(true);
    setSavedMessage(null);
    try {
      await submitText(
        { questionId: currentQuestion.id, originalText: answer },
        repository,
        { createId: () => crypto.randomUUID(), now: () => new Date() },
      );
      setSavedMessage("Deine Antwort ist nur auf diesem Gerät gespeichert.");
      setAnswer("");
    } catch {
      setSavedMessage("Das hat noch nicht geklappt. Versuch es bitte noch einmal.");
    } finally {
      setIsSaving(false);
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
        <a className="profile-button" href="#frage">Mein Bereich</a>
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
          {childStatusMeta.map((status) => (
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
        <div>
          <p className="section-kicker">Die Welt wächst</p>
          <h2 id="ideas-heading">Hier findest du bald alle Ideen.</h2>
        </div>
        <p>Schau dich um und entdecke, welche Orte, Wesen und Abenteuer schon auf dich warten.</p>
      </section>

      <section className="answer-section content-width" id="frage" aria-labelledby="question-heading">
        <div className="question-card">
          <div className="question-art" aria-hidden="true"><span>?</span></div>
          <div className="question-copy">
            <p className="section-kicker">Eine offene Frage</p>
            <h2 id="question-heading">{currentQuestion.title}</h2>
            <p>{currentQuestion.prompt}</p>
            <form onSubmit={handleAnswerSubmit}>
              <label htmlFor="answer">Deine Antwort</label>
              <textarea
                id="answer"
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                placeholder="Ich stelle mir den Fluss so vor ..."
                rows={4}
              />
              <div className="form-footer">
                <button className="button button-primary" disabled={isSaving || answer.trim().length === 0} type="submit">
                  {isSaving ? "Wird gespeichert …" : "Antwort speichern"} <span aria-hidden="true">→</span>
                </button>
                <span className="local-note"><span aria-hidden="true">▣</span> Nur auf deinem Gerät gespeichert</span>
              </div>
              {savedMessage ? <p className="form-message" role="status">{savedMessage}</p> : null}
            </form>
          </div>
        </div>
      </section>

      <footer className="footer content-width">
        <span>✦ Avaloria</span>
        <span>Eine Welt, die gemeinsam wächst.</span>
      </footer>
    </main>
  );
}
