import { jiraSource, type InternalCategory, type SourceReference } from "./content-source";

/**
 * MCL-35 will later close, rotate and archive questions. The state field and the
 * focus flag exist now so that rotation needs no data-model rebuild.
 */
export type QuestionState = "open" | "closed";

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
 * The parameter exists so the guard below can be exercised against a failing set.
 * Production callers pass nothing and always get the checked real dataset.
 */
export function focusQuestion(questions: ReadonlyArray<OpenQuestion> = openQuestions): OpenQuestion {
  const focused = questions.filter((question) => question.state === "open" && question.focus);
  if (focused.length !== 1) {
    throw new Error(`exactly one open question must be in focus, found ${focused.length}`);
  }
  return focused[0];
}

export function otherOpenQuestions(): ReadonlyArray<OpenQuestion> {
  return openQuestions.filter((question) => question.state === "open" && !question.focus);
}
