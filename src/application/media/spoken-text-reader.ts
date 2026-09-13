/**
 * MCL-74. Reading a reply out loud.
 *
 * A port, because speech synthesis is a browser capability and this project does not let
 * application or UI code reach for one directly. It is also a capability that genuinely
 * may not be there: a device with no voice installed, a browser that has removed the API,
 * a page served where it is disabled by policy.
 *
 * `supported` is a value rather than a promise deliberately. The surface has to decide
 * whether to render the button *while* it renders the card, and a button that appears
 * and then turns out to do nothing is worse for a child who cannot read yet than no
 * button at all. Absent, not disabled: a greyed-out control is a thing a child will keep
 * pressing.
 *
 * `speak` returns nothing and never throws. There is no outcome a child could act on -
 * if the voice does not come, the words are still on the screen.
 */
export interface SpokenTextReader {
  readonly supported: boolean;
  /** German only: everything this reads is German child copy. */
  speak(text: string, lang: "de-DE"): void;
  /** Called on unmount, so a card that leaves the screen stops talking. */
  cancel(): void;
}
