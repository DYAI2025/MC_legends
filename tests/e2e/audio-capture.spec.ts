import { expect, test, type Page } from "@playwright/test";
import {
  audioCaptureFailureMessage,
  audioCapturePhaseMessage,
} from "@/app/audio-capture-message";
import { expectChildSafe } from "../support/child-safe";
import { signInAsFamily } from "../support/family-session";

/**
 * MCL-30A in a real browser, with the two media APIs replaced before any page script
 * runs. Stubs rather than hardware on purpose: a test that needed a microphone could
 * not run in CI at all, and the properties under test - which control is offered, what
 * the child is told, whether a preview appears - do not depend on real audio.
 *
 * What is still real here: React, the object URL, the audio element, and the family
 * gate. Only getUserMedia and MediaRecorder are stood in for.
 */

const recorderArea = "Antwort aufnehmen";
const startButton = "Aufnahme starten";
const stopButton = "Aufnahme stoppen";
const discardButton = "Aufnahme löschen";
const fileChooserLabel = "Oder such eine Tondatei aus";

type MicrophoneBehaviour = "records" | "denied" | "absent";

/**
 * Installs the fake media stack. `records` hands back one stream whose track counts
 * its own stop() calls, and a recorder that produces a four-byte chunk when stopped.
 */
async function stubMedia(page: Page, behaviour: MicrophoneBehaviour): Promise<void> {
  await page.addInitScript((mode: MicrophoneBehaviour) => {
    const stoppedTracks: string[] = [];
    Object.defineProperty(window, "__stoppedTracks", { get: () => stoppedTracks });

    if (mode === "absent") {
      Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
      Reflect.deleteProperty(window, "MediaRecorder");
      return;
    }

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          if (mode === "denied") {
            const error = new Error("stubbed refusal");
            error.name = "NotAllowedError";
            throw error;
          }
          return {
            getTracks: () => [
              {
                stop() {
                  stoppedTracks.push("audio");
                },
              },
            ],
          };
        },
      },
    });

    class StubRecorder {
      static isTypeSupported() {
        return true;
      }
      state = "inactive";
      mimeType = "audio/webm";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({
          data: new Blob([new Uint8Array([26, 69, 223, 163])], { type: "audio/webm" }),
        });
        this.onstop?.();
      }
    }

    Object.defineProperty(window, "MediaRecorder", { configurable: true, value: StubRecorder });
  }, behaviour);
}

function recorder(page: Page) {
  return page.getByRole("region", { name: recorderArea });
}

function player(page: Page) {
  return page.getByLabel("Deine Aufnahme anhören");
}

/** The four bytes below are a WebM header; the file is never decoded, only accepted. */
const audioFileFixture = {
  name: "meine-stimme.mp3",
  mimeType: "audio/mpeg",
  buffer: Buffer.from([0x49, 0x44, 0x33, 0x03]),
};

const imageFileFixture = {
  name: "katze.png",
  mimeType: "image/png",
  buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
};

test.describe("child audio capture", () => {
  test("is not offered to a browser without a family session", async ({ page }) => {
    await stubMedia(page, "records");
    await page.goto("/");

    await expect(page.getByRole("button", { name: startButton })).toHaveCount(0);
    await expect(page.getByText(recorderArea, { exact: true })).toHaveCount(0);
    await expect(page.getByLabel(fileChooserLabel)).toHaveCount(0);
  });

  test("records, previews, discards and records again", async ({ page }) => {
    await stubMedia(page, "records");
    await signInAsFamily(page);
    await page.goto("/");

    const area = recorder(page);
    await expect(area).toBeVisible();
    await expect(area.getByText(audioCapturePhaseMessage("ready"))).toBeVisible();
    await expect(player(page)).toHaveCount(0);

    await area.getByRole("button", { name: startButton }).click();
    await expect(area.getByText(audioCapturePhaseMessage("recording"))).toBeVisible();
    await area.getByRole("button", { name: stopButton }).click();
    await expect(area.getByText(audioCapturePhaseMessage("recorded"))).toBeVisible();

    const source = await player(page).getAttribute("src");
    expect(source, "the preview plays the captured bytes from this browser").toMatch(/^blob:/);

    await area.getByRole("button", { name: discardButton }).click();
    await expect(player(page)).toHaveCount(0);
    await expect(area.getByText(audioCapturePhaseMessage("ready"))).toBeVisible();

    await area.getByRole("button", { name: startButton }).click();
    await area.getByRole("button", { name: stopButton }).click();
    const replacement = await player(page).getAttribute("src");
    expect(replacement).toMatch(/^blob:/);
    expect(replacement).not.toBe(source);

    // Every track handed over by the fake microphone was given back: once per recording.
    expect(await page.evaluate(() => (window as unknown as { __stoppedTracks: string[] }).__stoppedTracks.length)).toBe(2);
  });

  test("keeps the microphone controls usable from the keyboard", async ({ page }) => {
    await stubMedia(page, "records");
    await signInAsFamily(page);
    await page.goto("/");

    const area = recorder(page);
    await area.getByRole("button", { name: startButton }).focus();
    await page.keyboard.press("Enter");
    await expect(area.getByRole("button", { name: stopButton })).toBeVisible();

    await area.getByRole("button", { name: stopButton }).focus();
    await page.keyboard.press("Enter");
    await expect(player(page)).toBeVisible();
  });

  test("falls back to a file when this browser cannot record at all", async ({ page }) => {
    await stubMedia(page, "absent");
    await signInAsFamily(page);
    await page.goto("/");

    const area = recorder(page);
    await area.getByRole("button", { name: startButton }).click();
    await expect(
      area.getByText(audioCaptureFailureMessage("recording-unsupported")),
    ).toBeVisible();

    await page.setInputFiles("#audio-file", audioFileFixture);
    await expect(player(page)).toBeVisible();
    await expect(area.getByText(audioFileFixture.name)).toBeVisible();
  });

  test("says why the microphone stayed silent when it was refused", async ({ page }) => {
    await stubMedia(page, "denied");
    await signInAsFamily(page);
    await page.goto("/");

    const area = recorder(page);
    await area.getByRole("button", { name: startButton }).click();

    const problem = area.getByRole("alert");
    await expect(problem).toHaveText(audioCaptureFailureMessage("permission-denied"));
    expectChildSafe(await problem.innerText(), "the refused-microphone message");
    // Nothing of the browser's own error may surface.
    await expect(area).not.toContainText("NotAllowedError");
    await expect(area).not.toContainText("Error");
    await expect(player(page)).toHaveCount(0);
  });

  test("refuses a chosen file that is not audio, without offering a preview", async ({ page }) => {
    await stubMedia(page, "records");
    await signInAsFamily(page);
    await page.goto("/");

    const area = recorder(page);
    await page.setInputFiles("#audio-file", imageFileFixture);

    await expect(area.getByRole("alert")).toHaveText(audioCaptureFailureMessage("file-not-audio"));
    await expect(player(page)).toHaveCount(0);

    // And the way back is still open: a real audio file is accepted right after.
    await page.setInputFiles("#audio-file", audioFileFixture);
    await expect(player(page)).toBeVisible();
  });

  test("never claims the recording went anywhere", async ({ page }) => {
    await stubMedia(page, "records");
    await signInAsFamily(page);
    await page.goto("/");

    const area = recorder(page);
    await area.getByRole("button", { name: startButton }).click();
    await area.getByRole("button", { name: stopButton }).click();
    await expect(player(page)).toBeVisible();

    const text = await area.innerText();
    expectChildSafe(text, "the recording area");
    expect(text).toContain("Abschicken kannst du sie noch nicht");
    for (const claim of ["angekommen", "gesendet", "geschickt", "hochgeladen"]) {
      expect(text.toLowerCase(), `the recording area must not say "${claim}"`).not.toContain(claim);
    }
  });
});
