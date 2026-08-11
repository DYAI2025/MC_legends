import { AvaloriaHeroArt } from "@/app/components/avaloria-hero-art";
import { childStatusMeta } from "@/content/avaloria-content";

export default function HomePage() {
  return (
    <main className="site-shell">
      <nav className="topbar" aria-label="Hauptnavigation">
        <a className="brand" href="#start" aria-label="Avaloria Startseite">
          <span className="brand-mark" aria-hidden="true">A</span>
          <span>Avaloria</span>
        </a>
        <div className="topbar-links">
          <a href="#status-heading">Ideen ansehen</a>
          <a href="#frage">Frage beantworten</a>
        </div>
        <a className="profile-button" href="#frage">Mein Bereich</a>
      </nav>
      <section className="hero" id="start" aria-labelledby="page-title">
        <div className="hero-copy">
          <p className="hero-kicker"><span aria-hidden="true">✦</span> Avaloria · Konzept</p>
          <h1 id="page-title">Willkommen in Avaloria.</h1>
          <p className="hero-intro">
            Eine eigene Blockwelt mit grünen Tälern, hellen Türmen und neuen Wegen zum Entdecken.
          </p>
          <div className="hero-actions">
            <a className="button button-primary" href="#ideen">Idee teilen <span aria-hidden="true">→</span></a>
            <a className="button button-secondary" href="#frage">Frage beantworten <span aria-hidden="true">→</span></a>
          </div>
          <p className="hero-note"><span aria-hidden="true">●</span> Dieses Bild ist ein Konzept für die Website.</p>
        </div>
        <div className="hero-visual" aria-label="Konzeptbild von Avaloria">
          <div className="concept-badge">Konzeptbild · noch nicht fest</div>
          <AvaloriaHeroArt />
          <div className="visual-caption"><span aria-hidden="true">✦</span> Das helle Tal von Avaloria</div>
        </div>
      </section>
      <section className="status-section" aria-labelledby="status-heading">
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
    </main>
  );
}
