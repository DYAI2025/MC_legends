import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { IdeaEmblem } from "@/app/components/idea-emblem";
import {
  categoryFilterFromSlug,
  ideaById,
  relatedIdeas,
  THEMA_PARAM,
} from "@/content/avaloria-content";
import { focusQuestionRoute, ideaDetailRoute, overviewRoute } from "@/app/world-routes";
import {
  childStatusFor,
  childStatusPresentationFor,
  childTopicLabelFor,
} from "@/content/content-source";
import { openQuestionsAbout, rotateQuestions } from "@/content/open-questions";
import { questionUnavailableMessage } from "@/app/question-message";
import { readQuestionSnapshot } from "@/app/question-rotation-source";

type DetailProps = Readonly<{
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>;

/**
 * MCL-47. One page per element of the world, rendered on the server from the same
 * dataset the overview reads. Nothing on this page is authored for it: the title, the
 * sentence, the status and the topic all come from `src/content`, and the only strings
 * this file adds are the ones that operate it - a way back, and headings that name what
 * is already there.
 *
 * A server component on purpose. There is no interaction to hold state for, so the page
 * a child bookmarks or reloads is complete in the first response.
 */
async function readSelection({ params, searchParams }: DetailProps) {
  const { id } = await params;
  const idea = ideaById(id);
  // Not a redirect to the overview: a wrong address is a wrong address, and quietly
  // landing a child somewhere else would hide that the thing they followed is gone.
  if (idea === undefined) notFound();

  const thema = (await searchParams)[THEMA_PARAM];
  return {
    idea,
    /** Where the child came from, so the way back is not a guess. */
    filter: categoryFilterFromSlug(typeof thema === "string" ? thema : undefined),
  };
}

export async function generateMetadata(props: DetailProps): Promise<Metadata> {
  const { id } = await props.params;
  const idea = ideaById(id);
  return { title: idea === undefined ? "Avaloria" : `${idea.title} · Avaloria` };
}

export default async function WorldDetailPage(props: DetailProps) {
  const { idea, filter } = await readSelection(props);
  const status = childStatusPresentationFor(childStatusFor(idea.truthStatus));
  const backHref = overviewRoute(filter, idea.id);
  const neighbours = relatedIdeas(idea);

  /*
    MCL-35. Which questions about this element are still open is runtime state, and this
    page has to read it for the same reason the overview does: without it, a detail page
    would keep listing a question an adult retired and keep offering a button that leads
    to a form for a different question entirely.

    A store that cannot be read is NOT drawn as "nothing is open here" and NOT drawn from
    the seeded dataset. Both would be this page inventing a fact out of its own failure.
  */
  const snapshot = await readQuestionSnapshot();
  const rotation = snapshot === null ? null : rotateQuestions(snapshot);
  const questions = snapshot === null ? [] : openQuestionsAbout(idea.internalCategory, snapshot);
  const activeQuestionId = rotation?.active?.id ?? null;

  return (
    <main className="site-shell">
      <nav className="topbar" aria-label="Hauptnavigation">
        <Link className="brand" href={overviewRoute(filter)} aria-label="Avaloria Startseite">
          <span className="brand-mark" aria-hidden="true">A</span>
          <span>Avaloria</span>
        </Link>
        {/*
          The way back is in the top bar as well as above the title, because .topbar-links
          is hidden on small screens and a phone must not be the one place the route home
          is missing. Both point at the same address: the topic the child was looking at,
          scrolled to the card they opened.
        */}
        <Link className="profile-button" href={backHref}>
          <span aria-hidden="true">←</span> Zurück zu den Ideen
        </Link>
      </nav>

      <article className="detail content-width" aria-labelledby="detail-title">
        <p className="detail-back">
          <Link href={backHref}>
            <span aria-hidden="true">←</span> Zurück zu den Ideen
          </Link>
        </p>

        <div className="detail-head">
          <div className="detail-visual">
            <span className="concept-badge">Konzeptbild · noch nicht fest</span>
            <IdeaEmblem
              className="detail-emblem"
              ideaId={idea.id}
              label={`Blockbild zu ${idea.title}`}
              status={status.id}
            />
          </div>
          <div className="detail-copy">
            <p className="section-kicker">{idea.childCategory}</p>
            <h1 id="detail-title">{idea.title}</h1>
            <p className="detail-summary">{idea.summary}</p>
            {/*
              The status and its own explanation, side by side and never separated. The
              badge alone is a sign a child has to remember; the sentence under it is the
              legend's own wording, so an undecided idea says out loud that it is undecided
              instead of relying on a colour to carry that.
            */}
            <p className={`detail-status status-${status.id}`}>
              <span aria-hidden="true">{status.icon}</span> {status.label}
            </p>
            <p className="detail-status-explanation">{status.explanation}</p>
          </div>
        </div>

        <section className="detail-facts" aria-labelledby="facts-heading">
          <h2 id="facts-heading">Auf einen Blick</h2>
          <dl>
            <dt>Gruppe</dt>
            <dd>{idea.childCategory}</dd>
            <dt>Thema</dt>
            <dd>{childTopicLabelFor(idea.internalCategory)}</dd>
            <dt>Wie sicher</dt>
            <dd>
              {status.label} - {status.explanation}
            </dd>
          </dl>
        </section>

        {/*
          Only shown where both datasets already agree on the owner topic. Nothing is
          invented to give an element a question, so an element without one simply has no
          such section - an empty box promising a question that does not exist would be
          the same kind of lie this project keeps out of the status badges.
        */}
        {snapshot === null ? (
          <section className="detail-questions" aria-labelledby="questions-heading">
            <h2 id="questions-heading">{questionUnavailableMessage().title}</h2>
            <p>{questionUnavailableMessage().body}</p>
          </section>
        ) : questions.length === 0 ? null : (
          <section className="detail-questions" aria-labelledby="questions-heading">
            <h2 id="questions-heading">Dazu ist noch etwas offen</h2>
            <ul>
              {questions.map((question) => (
                <li key={question.id}>
                  <p className="detail-question-title">{question.title}</p>
                  {/*
                    Only the question that is currently in focus has an answer form on the
                    overview. Offering the others a button would send a child to a place
                    where nothing is waiting for them.
                  */}
                  {question.id === activeQuestionId ? (
                    <Link className="button button-secondary" href={focusQuestionRoute(filter)}>
                      Diese Frage beantworten <span aria-hidden="true">→</span>
                    </Link>
                  ) : (
                    <p className="detail-question-later">Diese Frage kommt später dran.</p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {neighbours.length === 0 ? null : (
          <section className="detail-related" aria-labelledby="related-heading">
            <h2 id="related-heading">Das gehört zum selben Thema</h2>
            <ul className="detail-related-list">
              {neighbours.map((neighbour) => {
                const neighbourStatus = childStatusPresentationFor(
                  childStatusFor(neighbour.truthStatus),
                );
                return (
                  <li key={neighbour.id}>
                    <Link
                      className="detail-related-card"
                      href={ideaDetailRoute(neighbour.id, filter)}
                    >
                      <span className={`idea-status status-${neighbourStatus.id}`}>
                        <span aria-hidden="true">{neighbourStatus.icon}</span>{" "}
                        {neighbourStatus.label}
                      </span>
                      <span className="detail-related-title">{neighbour.title}</span>
                      <span className="idea-more">
                        Mehr entdecken <span className="idea-more-arrow" aria-hidden="true">→</span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </article>

      <footer className="footer content-width">
        <span>✦ Avaloria</span>
        <span>Eine Welt, die gemeinsam wächst.</span>
      </footer>
    </main>
  );
}
