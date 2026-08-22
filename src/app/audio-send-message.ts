import type {
  AudioSendFailureReason,
  AudioSendPhase,
} from "@/adapters/media/audio-answer-sender";

/**
 * MCL-30B. Every sentence a child reads about sending a recording, kept out of the
 * component and written as total tables so a new phase or a new failure reason is a
 * compile error here rather than a blank line on the page.
 *
 * Three rules these sentences exist to keep:
 *
 * - Only `sent` may say the recording arrived, and the sender reaches that phase only
 *   from a real server receipt. No sentence here is reachable from "the button was
 *   pressed", "the bytes left the browser" or "the answer looked positive".
 * - Every failure says the recording is still here. A child who has just spoken into a
 *   microphone needs to know their words were not thrown away before they need to know
 *   what to do next, so that reassurance comes first in the sentence, not last.
 * - No engineering vocabulary and no status numbers. What went wrong is named by what
 *   the child can do about it; the reason that caused it stays inside the adapter.
 */

const phaseMessages = {
  idle: "Deine Aufnahme ist fertig. Du kannst sie jetzt abschicken.",
  // "unterwegs", never "wird abgeschickt": the second reads as a completed act to an
  // eight-year-old, and at this moment nothing is completed - the bytes are in flight and
  // the project has not answered. The distinction is asserted in the message test.
  sending: "Deine Aufnahme ist unterwegs zum Projekt …",
  // The one arrival claim in this file, and the whole reason the sender has a receipt.
  sent: "Deine Aufnahme ist im Projekt angekommen.",
  // Deliberately not "it did not work": what a child most needs to read here is that the
  // recording survived. The reason below says what to do next.
  failed: "Deine Aufnahme ist noch da.",
} as const satisfies Record<AudioSendPhase, string>;

const failureMessages = {
  transport: "Wir konnten das Projekt gerade nicht erreichen. Probier es gleich noch einmal.",
  unavailable:
    "Das Projekt kann deine Aufnahme gerade nicht annehmen. Probier es später noch einmal.",
  "rate-limited":
    "Das war ein bisschen schnell hintereinander. Warte kurz und probier es dann noch einmal.",
  // The only one that sends a child to an adult, for the same reason the sign-in panel
  // does: nobody at the keyboard can fix it alone.
  unauthorized:
    "Wir sind gerade nicht mehr angemeldet. Frag bitte eine erwachsene Person nach dem Familien-Code und probier es dann noch einmal.",
  // The one failure that a retry cannot fix, so it does not invite one.
  refused:
    "Das Projekt konnte diese Aufnahme nicht annehmen. Nimm bitte etwas Neues auf oder such eine andere Tondatei aus.",
  "audio-too-large": "Deine Aufnahme ist zu lang. Nimm bitte etwas Kürzeres auf.",
  "audio-type-unsupported":
    "Diese Datei können wir nicht als Ton lesen. Such bitte eine andere Tondatei aus oder nimm selbst etwas auf.",
  "audio-unreadable":
    "Wir konnten die Datei nicht mehr öffnen. Such sie bitte noch einmal aus.",
} as const satisfies Record<AudioSendFailureReason, string>;

/** What the child reads about where their recording is on its way to the project. */
export function audioSendPhaseMessage(phase: AudioSendPhase): string {
  return phaseMessages[phase];
}

/** What the child reads about something that went wrong, and what to do next. */
export function audioSendFailureMessage(reason: AudioSendFailureReason): string {
  return failureMessages[reason];
}
