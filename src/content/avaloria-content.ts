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
