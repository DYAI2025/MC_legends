export type ChildStatus = "in-world" | "idea" | "open" | "tryout";

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
  status: ChildStatus;
  childCategory: ChildCategory;
  /** Keeps the complete internal owner while the child view uses childCategory. */
  internalCategory: "prologue" | "main-story" | "creatures" | "building" | "co-op" | "open-question";
}>;

export const childStatusMeta: ReadonlyArray<{
  id: ChildStatus;
  label: string;
  explanation: string;
  icon: string;
}> = [
  { id: "in-world", label: "Schon dabei", explanation: "Das gehört schon zu Avaloria.", icon: "✦" },
  { id: "idea", label: "Eine Idee", explanation: "Das könnte später in Avaloria sein.", icon: "✎" },
  { id: "open", label: "Noch offen", explanation: "Das ist noch nicht entschieden.", icon: "?" },
  { id: "tryout", label: "Zum Ausprobieren", explanation: "Das können wir gemeinsam testen.", icon: "➜" },
];

export const currentQuestion = {
  id: "river-color",
  title: "Welche Farbe soll der Fluss haben?",
  prompt: "Wie sieht der Fluss in deiner Fantasie aus? Schreib uns deine Idee.",
} as const;

export const childCategories: ReadonlyArray<{
  label: ChildCategory;
  icon: string;
  description: string;
}> = [
  { label: "Geschichte & Welt", icon: "✦", description: "Orte, Reisen und die große Geschichte" },
  { label: "Wesen & Figuren", icon: "◈", description: "Freunde, Tiere und andere Wesen" },
  { label: "Quests & Abenteuer", icon: "⚑", description: "Aufgaben, Rätsel und spannende Wege" },
  { label: "Ausrüstung & Bauen", icon: "⬡", description: "Sachen, Häuser und eigene Plätze" },
  { label: "Gemeinsam spielen", icon: "♢", description: "Ideen, die mit anderen Spaß machen" },
  { label: "Offene Ideen", icon: "?", description: "Fragen, die wir noch entscheiden" },
];

export const avaloriaIdeas: ReadonlyArray<AvaloriaIdea> = [
  {
    id: "prologue-gate",
    title: "Das Tor ins grüne Tal",
    summary: "Die erste Reise führt über eine alte Brücke in ein helles Tal.",
    status: "in-world",
    childCategory: "Geschichte & Welt",
    internalCategory: "prologue",
  },
  {
    id: "main-story-lanterns",
    title: "Die Lichter von Avaloria",
    summary: "Eine Spur aus kleinen Lichtern zeigt den Weg durch die Nacht.",
    status: "idea",
    childCategory: "Geschichte & Welt",
    internalCategory: "main-story",
  },
  {
    id: "bridge-helper",
    title: "Der Brückenhüter",
    summary: "Ein freundliches Wesen kennt jeden sicheren Weg über den Fluss.",
    status: "tryout",
    childCategory: "Wesen & Figuren",
    internalCategory: "creatures",
  },
  {
    id: "treehouse-workshop",
    title: "Die Werkstatt im Baum",
    summary: "Hier kannst du Dinge bauen und deine eigenen Ideen ausprobieren.",
    status: "idea",
    childCategory: "Ausrüstung & Bauen",
    internalCategory: "building",
  },
  {
    id: "shared-map",
    title: "Eine Karte für alle",
    summary: "Gemeinsam markieren wir Orte, die andere entdecken können.",
    status: "open",
    childCategory: "Gemeinsam spielen",
    internalCategory: "co-op",
  },
  {
    id: "question-colors",
    title: "Welche Farbe soll der Fluss haben?",
    summary: "Blau, grün oder etwas ganz anderes? Das ist noch offen.",
    status: "open",
    childCategory: "Offene Ideen",
    internalCategory: "open-question",
  },
];
