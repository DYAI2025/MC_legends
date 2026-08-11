export type ChildStatus = "in-world" | "idea" | "open" | "tryout";

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
