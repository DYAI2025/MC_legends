import { jiraSource, type InternalCategory, type SourceReference } from "./content-source";
import type {
  QuestionLifecycleSnapshot,
  QuestionState,
} from "@/domain/questions/question-lifecycle";

/**
 * MCL-35 closes, rotates and archives questions. The state field and the focus flag are
 * the SEEDED start of that lifecycle: what the project decided before anyone had a way
 * to change it from the outside. Once the lifecycle store holds an event for a question,
 * that event decides - see `rotateQuestions`.
 */
export type { QuestionState };

export type OpenQuestion = Readonly<{
  id: string;
  /** Child-facing wording. No project jargon, no admin vocabulary. */
  title: string;
  prompt: string;
  placeholder: string;
  internalCategory: InternalCategory;
  state: QuestionState;
  /** Exactly one open question carries focus at a time. */
  focus: boolean;
  source: SourceReference;
}>;

/**
 * Every question restates a decision the project has recorded as still open.
 * Nothing here is invented for the website, and nothing technical or
 * project-management shaped is ever put to a child.
 *
 * The ARRAY ORDER is load-bearing since MCL-35: it is the rotation order, so the
 * question after the one being answered is the next entry here whose effective state is
 * still open. Reordering this list reorders what children are asked.
 */
export const openQuestions: ReadonlyArray<OpenQuestion> = [
  {
    id: "companion-animal",
    title: "Welches Tier soll dich in Avaloria begleiten?",
    prompt: "Stell dir dein Tier vor. Wie sieht es aus und was kann es besonders gut?",
    placeholder: "Mein Tier ist ...",
    internalCategory: "creatures",
    state: "open",
    focus: true,
    source: jiraSource("MCL-7", "Haustiere als Teil der Kreaturenökologie noch nicht definiert"),
  },
  {
    id: "druhen-protection",
    title: "Was schützt am besten vor den Druhen?",
    prompt: "Licht, ein besonderer Gegenstand oder etwas ganz anderes? Erzähl es uns.",
    placeholder: "Ich glaube, am besten hilft ...",
    internalCategory: "progression",
    state: "open",
    focus: false,
    source: jiraSource("MCL-6", "Licht und Schutzmittel gegen Versteinerung noch ohne Regelmodell"),
  },
  {
    id: "dragon-path",
    title: "Wie wird man in Avaloria Drachenreiterin oder Drachenreiter?",
    prompt: "Was muss man dafür schaffen? Schreib deinen Weg auf.",
    placeholder: "Zuerst muss man ...",
    internalCategory: "progression",
    state: "open",
    focus: false,
    source: jiraSource("MCL-8", "Drachenzucht und Drachenreiten als Progressionspfad noch offen"),
  },
  {
    id: "behind-the-wall",
    title: "Was liegt hinter der großen Mauer?",
    prompt: "Niemand hat es bisher festgelegt. Was findest du dort?",
    placeholder: "Hinter der Mauer gibt es ...",
    internalCategory: "world-geography",
    state: "open",
    focus: false,
    source: jiraSource("MCL-3", "Große Mauer geografisch noch nicht kanonisiert"),
  },
  {
    id: "amulet-power",
    title: "Was soll ein Amulett können?",
    prompt: "Amulette und Schriftrollen sind noch nicht entschieden. Was wäre deins?",
    placeholder: "Mein Amulett kann ...",
    internalCategory: "crafting",
    state: "open",
    focus: false,
    source: jiraSource("MCL-10", "Amulette und Schriftrollen noch nicht konsolidiert"),
  },
];

/**
 * Both selectors take the question set as an optional parameter so their filters can
 * be exercised against a set that breaks the invariant. Production callers pass
 * nothing and always get the checked real dataset.
 *
 * These two read the SEEDED dataset only and know nothing about the lifecycle store.
 * They are what pins the starting point that `rotateQuestions({})` has to agree with;
 * the running child surface reads `rotateQuestions` instead.
 */
export function focusQuestion(questions: ReadonlyArray<OpenQuestion> = openQuestions): OpenQuestion {
  const focused = questions.filter((question) => question.state === "open" && question.focus);
  if (focused.length !== 1) {
    throw new Error(`exactly one open question must be in focus, found ${focused.length}`);
  }
  return focused[0];
}

export function otherOpenQuestions(
  questions: ReadonlyArray<OpenQuestion> = openQuestions,
): ReadonlyArray<OpenQuestion> {
  return questions.filter((question) => question.state === "open" && !question.focus);
}

/** One question by id, or null. Never throws: an id can come from stored data. */
export function questionById(
  id: string,
  questions: ReadonlyArray<OpenQuestion> = openQuestions,
): OpenQuestion | null {
  return questions.find((question) => question.id === id) ?? null;
}

/**
 * The effective state of one question: what the lifecycle store recorded, or the seeded
 * state when it recorded nothing.
 */
function effectiveState(
  question: OpenQuestion,
  snapshot: QuestionLifecycleSnapshot,
): QuestionState {
  return snapshot[question.id]?.state ?? question.state;
}

/**
 * The still-open questions the project files under the same owner topic as an element.
 * This is the only way a detail page is allowed to claim that a question belongs to what
 * a child is reading: both datasets already carry the topic, so the link is a fact the
 * project wrote down, not a connection invented for the page.
 *
 * Takes the lifecycle snapshot since MCL-35, defaulting to "nothing was ever closed", so
 * a closed question cannot keep appearing on a detail page after an adult retired it.
 */
export function openQuestionsAbout(
  internalCategory: InternalCategory,
  snapshot: QuestionLifecycleSnapshot = {},
  questions: ReadonlyArray<OpenQuestion> = openQuestions,
): ReadonlyArray<OpenQuestion> {
  return questions.filter(
    (question) =>
      effectiveState(question, snapshot) === "open" &&
      question.internalCategory === internalCategory,
  );
}

/**
 * Which question is being asked right now, which ones are waiting, and which ones are
 * finished.
 *
 * `active === null` is a real answer, not a failure: with every question closed there is
 * nothing to ask, and the child surface has a state for that. This function therefore
 * never throws - unlike `focusQuestion`, whose throw is a guard on the SOURCE dataset and
 * stays exactly as strict as it was.
 */
export type QuestionRotation = Readonly<{
  active: OpenQuestion | null;
  /** Open, in turn order, excluding the active one. */
  upcoming: readonly OpenQuestion[];
  /** Closed, in dataset order. Nothing is deleted, so nothing disappears from here. */
  archived: readonly OpenQuestion[];
}>;

/**
 * The turn order.
 *
 * A question that has never left the rotation keeps its dataset position. A question the
 * store has moved BACK to open goes behind all of them, ordered among other reopened
 * questions by when each was reopened.
 *
 * That second rule is the whole of "reopening must not steal the turn". Position alone
 * would mean reopening the first question in the dataset instantly takes the turn away
 * from whatever a child is currently being asked - the answer they are halfway through
 * typing would be to a question the page no longer shows. Recency alone would be worse in
 * the other direction: it would make the dataset order meaningless as soon as anything was
 * ever reopened. Two groups, each internally ordered by a value that cannot tie, gives one
 * deterministic order that respects both.
 *
 * Snapshot keys naming no known question are ignored, so a question deleted from the
 * dataset cannot be resurrected by an old event, and an event log from a newer deployment
 * cannot make an older one render something it has no wording for.
 */
export function rotateQuestions(
  snapshot: QuestionLifecycleSnapshot,
  questions: ReadonlyArray<OpenQuestion> = openQuestions,
): QuestionRotation {
  const open: Array<{ question: OpenQuestion; group: number; key: number }> = [];
  const archived: OpenQuestion[] = [];

  questions.forEach((question, index) => {
    const fact = snapshot[question.id];
    const state = fact?.state ?? question.state;

    if (state === "closed") {
      archived.push(question);
      return;
    }

    // Group 1 is "was closed and has been reopened": the only way a question can carry a
    // recorded fact and still be open. Group 0 keeps the dataset position.
    open.push(
      fact === undefined
        ? { question, group: 0, key: index }
        : { question, group: 1, key: fact.sequence },
    );
  });

  open.sort((left, right) => left.group - right.group || left.key - right.key);

  const [first, ...rest] = open;

  return {
    active: first?.question ?? null,
    upcoming: rest.map((entry) => entry.question),
    archived,
  };
}
