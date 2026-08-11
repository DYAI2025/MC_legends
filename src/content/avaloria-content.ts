import {
  designSsotPage,
  jiraSource,
  type InternalCategory,
  type SourceReference,
  type TruthStatus,
} from "./content-source";

export type ChildCategory =
  | "Geschichte & Welt"
  | "Wesen & Figuren"
  | "Quests & Abenteuer"
  | "Ausrüstung & Bauen"
  | "Gemeinsam spielen"
  | "Offene Ideen";

export type AvaloriaIdea = Readonly<{
  id: string;
  title: string;
  summary: string;
  truthStatus: TruthStatus;
  childCategory: ChildCategory;
  internalCategory: InternalCategory;
  source: SourceReference;
}>;

export const childCategories = [
  { label: "Geschichte & Welt", icon: "✦", description: "Orte, Reisen und die große Geschichte" },
  { label: "Wesen & Figuren", icon: "◈", description: "Freunde, Tiere und andere Wesen" },
  { label: "Quests & Abenteuer", icon: "⚑", description: "Aufgaben, Rätsel und spannende Wege" },
  { label: "Ausrüstung & Bauen", icon: "⬡", description: "Sachen, Häuser und eigene Plätze" },
  { label: "Gemeinsam spielen", icon: "♢", description: "Ideen, die mit anderen Spaß machen" },
  { label: "Offene Ideen", icon: "?", description: "Fragen, die wir noch entscheiden" },
] as const satisfies ReadonlyArray<{ label: ChildCategory; icon: string; description: string }>;

/**
 * Every entry restates something the project has already written down.
 * Nothing here is invented for the website. Truth status follows the SSoT page,
 * which documents the decision space - so almost everything is TENTATIVE or OPEN.
 */
export const avaloriaIdeas: ReadonlyArray<AvaloriaIdea> = [
  {
    id: "prologue-rebuilding",
    title: "Zwanzig Jahre Wiederaufbau",
    summary: "Vor der Geschichte liegt eine lange Zeit, in der alles wieder aufgebaut wurde.",
    truthStatus: "TENTATIVE",
    childCategory: "Geschichte & Welt",
    internalCategory: "prologue",
    source: jiraSource("MCL-2", "Prolog, 20-jähriger Wiederaufbau chronologisch konsistent machen"),
  },
  {
    id: "prologue-alliance-break",
    title: "Der Bruch des Bündnisses",
    summary: "Im Prolog zerbricht ein Bündnis. Wie genau, ist noch nicht festgelegt.",
    truthStatus: "AMBIGUOUS",
    childCategory: "Geschichte & Welt",
    internalCategory: "prologue",
    source: jiraSource("MCL-2", "Bündnisbruch chronologisch konsistent machen"),
  },
  {
    id: "main-story-druhen-escalation",
    title: "Die Druhen werden stärker",
    summary: "In der Hauptgeschichte breiten sich die Druhen immer weiter aus.",
    truthStatus: "TENTATIVE",
    childCategory: "Geschichte & Welt",
    internalCategory: "main-story",
    source: jiraSource("MCL-2", "Druhen-Eskalation chronologisch konsistent machen"),
  },
  {
    id: "main-story-perspectives",
    title: "Wer erzählt die Geschichte?",
    summary: "Spielerfigur, König und die Sicht im Prolog sollen klar getrennt bleiben.",
    truthStatus: "AMBIGUOUS",
    childCategory: "Geschichte & Welt",
    internalCategory: "main-story",
    source: jiraSource("MCL-4", "Spielerfigur, König und Prolog-Perspektive eindeutig trennen"),
  },
  {
    id: "world-kings-castle",
    title: "Die Königsburg",
    summary: "Eine Burg, ein Berg, ein Dorf und ein Wald gehören zur Karte von Avaloria.",
    truthStatus: "TENTATIVE",
    childCategory: "Geschichte & Welt",
    internalCategory: "world-geography",
    source: jiraSource("MCL-3", "Königsburg, Berg, Dorf, Wald geografisch kanonisieren"),
  },
  {
    id: "world-dragon-caves",
    title: "Die Drachenhöhlen",
    summary: "Tief im Fels gibt es Höhlen, in denen Drachen leben.",
    truthStatus: "TENTATIVE",
    childCategory: "Geschichte & Welt",
    internalCategory: "world-geography",
    source: jiraSource("MCL-3", "Drachenhöhlen geografisch kanonisieren"),
  },
  {
    id: "creatures-druhen",
    title: "Die Druhen",
    summary: "Die Druhen sind die Gegner in Avaloria. So heißen sie überall im Projekt.",
    truthStatus: "STATED",
    childCategory: "Wesen & Figuren",
    internalCategory: "creatures",
    source: designSsotPage,
  },
  {
    id: "creatures-stone-wolves",
    title: "Steinwölfe und Druhenwölfe",
    summary: "Zwei Wolfsarten sollen sich klar voneinander unterscheiden.",
    truthStatus: "TENTATIVE",
    childCategory: "Wesen & Figuren",
    internalCategory: "creatures",
    source: jiraSource("MCL-7", "Steinwölfe und Druhenwölfe als konsistente Kreaturenökologie definieren"),
  },
  {
    id: "progression-druhen-protection",
    title: "Licht gegen die Versteinerung",
    summary: "Licht und Schutzmittel sollen gegen die Druhen helfen. Die Regeln fehlen noch.",
    truthStatus: "OPEN",
    childCategory: "Quests & Abenteuer",
    internalCategory: "progression",
    source: jiraSource("MCL-6", "Druhen, Versteinerung, Licht und Schutzmittel in ein Regelmodell bringen"),
  },
  {
    id: "progression-dragon-riding",
    title: "Drachen aufziehen und reiten",
    summary: "Vom kleinen Drachen bis zum Drachenritt soll es einen langen Weg geben.",
    truthStatus: "TENTATIVE",
    childCategory: "Quests & Abenteuer",
    internalCategory: "progression",
    source: jiraSource("MCL-8", "Drachenzucht, Flügel und Drachenreiten als abgestuften Progressionspfad definieren"),
  },
  {
    id: "orders-four-paths",
    title: "Die vier Orden",
    summary: "Magier, Krieger, Wächter und Naturorden sollen unterschiedliche Wege sein.",
    truthStatus: "TENTATIVE",
    childCategory: "Quests & Abenteuer",
    internalCategory: "orders-and-roles",
    source: jiraSource("MCL-9", "Magier-, Krieger-, Wächter- und Naturorden abgrenzen"),
  },
  {
    id: "crafting-elemental-swords",
    title: "Die vier Elementschwerter",
    summary: "Es gibt genau vier Grundelemente: Feuer, Wasser, Erde und Luft.",
    truthStatus: "STATED",
    childCategory: "Ausrüstung & Bauen",
    internalCategory: "crafting",
    source: designSsotPage,
  },
  {
    id: "crafting-scrolls-amulets",
    title: "Schriftrollen und Amulette",
    summary: "Gesammeltes soll sich zu Schriftrollen und Amuletten verbinden lassen.",
    truthStatus: "TENTATIVE",
    childCategory: "Ausrüstung & Bauen",
    internalCategory: "crafting",
    source: jiraSource("MCL-10", "Crafting, Schriftrollen, Amulette und Ressourcenketten konsolidieren"),
  },
  {
    id: "persistent-shared-map",
    title: "Eine Karte für alle",
    summary: "Alle sollen dieselbe Karte sehen und Orte gemeinsam entdecken.",
    truthStatus: "TENTATIVE",
    childCategory: "Gemeinsam spielen",
    internalCategory: "persistent-world",
    source: jiraSource("MCL-12", "Karte, Sichtbarkeit, Teleport und Kooperation regeln"),
  },
  {
    id: "persistent-together-rules",
    title: "Gemeinsam statt gegeneinander",
    summary: "Wie viel Streit im Spiel erlaubt ist, ist noch nicht entschieden.",
    truthStatus: "OPEN",
    childCategory: "Gemeinsam spielen",
    internalCategory: "persistent-world",
    source: jiraSource("MCL-12", "Kooperations- und PvP-Regeln offen"),
  },
  {
    id: "world-great-wall",
    title: "Die große Mauer",
    summary: "Eine große Mauer gehört zur Welt. Was dahinter liegt, ist noch offen.",
    truthStatus: "OPEN",
    childCategory: "Offene Ideen",
    internalCategory: "world-geography",
    source: jiraSource("MCL-3", "Große Mauer geografisch kanonisieren"),
  },
  {
    id: "creatures-pets",
    title: "Haustiere in Avaloria",
    summary: "Welche Tiere dich begleiten dürfen, ist noch nicht entschieden.",
    truthStatus: "OPEN",
    childCategory: "Offene Ideen",
    internalCategory: "creatures",
    source: jiraSource("MCL-7", "Haustiere als konsistente Kreaturenökologie definieren"),
  },
  {
    id: "persistent-calendar",
    title: "Ein Kalender für alle",
    summary: "Ob es feste Termine und große Ereignisse gibt, ist noch offen.",
    truthStatus: "OPEN",
    childCategory: "Offene Ideen",
    internalCategory: "persistent-world",
    source: jiraSource("MCL-11", "Echtzeitkalender, globale Events und Offline-Fairness"),
  },
];
