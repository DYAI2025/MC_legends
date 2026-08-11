import { AvaloriaHeroArt } from "@/app/components/avaloria-hero-art";

export default function HomePage() {
  return (
    <main className="site-shell">
      <section className="hero" aria-labelledby="page-title">
        <div className="hero-copy">
          <p className="hero-kicker"><span aria-hidden="true">✦</span> Avaloria · Konzept</p>
          <h1 id="page-title">Willkommen in Avaloria.</h1>
          <p className="hero-intro">
            Eine eigene Blockwelt mit grünen Tälern, hellen Türmen und neuen Wegen zum Entdecken.
          </p>
          <p className="hero-note"><span aria-hidden="true">●</span> Dieses Bild ist ein Konzept für die Website.</p>
        </div>
        <div className="hero-visual" aria-label="Konzeptbild von Avaloria">
          <div className="concept-badge">Konzeptbild · noch nicht fest</div>
          <AvaloriaHeroArt />
          <div className="visual-caption"><span aria-hidden="true">✦</span> Das helle Tal von Avaloria</div>
        </div>
      </section>
    </main>
  );
}
