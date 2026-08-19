import type {
  AudioCaptureFailureReason,
  AudioCapturePhase,
} from "@/adapters/media/audio-capture-controller";

/**
 * MCL-30A. Every sentence the recording area says to a child, kept out of the
 * component so it can be read and tested on its own, and written as total tables so a
 * new phase or a new failure reason is a compile error here rather than an empty line
 * on the page.
 *
 * Two rules these sentences exist to keep:
 *
 * - Nothing here may claim the recording was sent, kept, or received. There is no
 *   server path for audio yet, so the only honest promise is "it is on this device,
 *   for as long as this page is open".
 * - No browser vocabulary. A child reads what happened and what they can do next; the
 *   error name that caused it stays inside the adapter.
 */

const phaseMessages = {
  ready: "Bereit. Drücke auf Aufnahme starten.",
  "requesting-permission": "Wir fragen kurz, ob wir das Mikrofon benutzen dürfen …",
  recording: "Aufnahme läuft.",
  recorded: "Fertig. Du kannst deine Aufnahme jetzt anhören.",
  error: "Aufnehmen geht hier gerade nicht.",
} as const satisfies Record<AudioCapturePhase, string>;

const failureMessages = {
  "recording-unsupported":
    "Auf diesem Gerät können wir leider nicht aufnehmen. Du kannst stattdessen eine Tondatei aussuchen.",
  "microphone-unavailable":
    "Wir haben kein Mikrofon gefunden. Du kannst stattdessen eine Tondatei aussuchen.",
  "permission-denied":
    "Wir dürfen das Mikrofon gerade nicht benutzen. Frag eine erwachsene Person, ob sie es erlaubt - oder such eine Tondatei aus.",
  "recording-failed": "Die Aufnahme hat nicht geklappt. Probier es bitte noch einmal.",
  "empty-recording": "Wir haben nichts gehört. Sprich bitte etwas lauter und probier es noch einmal.",
  "file-not-audio": "Das war keine Tondatei. Such bitte eine Datei mit Musik oder Sprache aus.",
} as const satisfies Record<AudioCaptureFailureReason, string>;

/** What the child reads about where they are in a recording. */
export function audioCapturePhaseMessage(phase: AudioCapturePhase): string {
  return phaseMessages[phase];
}

/** What the child reads about something that went wrong, and what to do next. */
export function audioCaptureFailureMessage(reason: AudioCaptureFailureReason): string {
  return failureMessages[reason];
}
