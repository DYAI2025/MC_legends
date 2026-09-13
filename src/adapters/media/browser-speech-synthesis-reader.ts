import type { SpokenTextReader } from "@/application/media/spoken-text-reader";

/**
 * Reading a reply out loud with the browser's own voice (MCL-74).
 *
 * Feature-detected at construction rather than at call time, because the surface has to
 * decide whether the button exists at all while it renders - and a button that appears
 * and then does nothing is worse, for a child who cannot read yet, than no button.
 *
 * No autoplay. Nothing here speaks unless a child pressed something; a page that started
 * talking on its own would be a page a child cannot open quietly.
 */
export class BrowserSpeechSynthesisReader implements SpokenTextReader {
  readonly supported: boolean;

  constructor(private readonly synthesis: SpeechSynthesis | null = resolveSynthesis()) {
    this.supported = synthesis !== null;
  }

  speak(text: string, lang: "de-DE"): void {
    if (this.synthesis === null) return;

    // Cancel first: pressing "Vorlesen" on a second card while the first is still
    // speaking should read the card that was pressed, not queue behind it.
    this.synthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    this.synthesis.speak(utterance);
  }

  cancel(): void {
    this.synthesis?.cancel();
  }
}

/**
 * `window` is absent during server rendering and `speechSynthesis` is absent on a device
 * with no voices, so both are checked. A constructor that touched `window` directly would
 * throw where this module is imported rather than where it is used.
 */
function resolveSynthesis(): SpeechSynthesis | null {
  if (typeof window === "undefined") return null;
  return typeof window.speechSynthesis === "undefined" ? null : window.speechSynthesis;
}
