import { expect, test, type Page } from "@playwright/test";
import {
  audioCaptureFailureMessage,
  audioCapturePhaseMessage,
} from "@/app/audio-capture-message";
import { audioSendFailureMessage, audioSendPhaseMessage } from "@/app/audio-send-message";
import { expectChildSafe } from "../support/child-safe";
import { signInAsFamily } from "../support/family-session";

/**
 * MCL-30A in a real browser, with the two media APIs replaced before any page script
 * runs. Stubs rather than hardware on purpose: a test that needed a microphone could
 * not run in CI at all, and the properties under test - which control is offered, what
 * the child is told, whether a preview appears - do not depend on real audio.
 *
 * What is still real here: React, the object URL, the audio element, the family gate -
 * and, since MCL-30B, the upload itself: the send cases below cross the real route into
 * the real store and read the real receipt back. Only getUserMedia and MediaRecorder are
 * stood in for, plus the transport in the cases that are about a transport failing.
 */

const recorderArea = "Antwort aufnehmen";
const startButton = "Aufnahme starten";
const stopButton = "Aufnahme stoppen";
const reRecordButton = "Neu aufnehmen";
const discardButton = "Aufnahme löschen";
const fileChooserLabel = "Oder such eine Tondatei aus";
const sendButton = "Aufnahme abschicken";
const resendButton = "Noch einmal abschicken";
const audioEndpoint = "**/api/inbox/submissions/audio";
/** Any topic chip: pressing one is the soft navigation an unsent recording has to survive. */
const topicChip = "Wesen & Figuren";

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

/** How many microphone tracks the stub has been asked to give back so far. */
function stoppedTracks(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __stoppedTracks: string[] }).__stoppedTracks.length,
  );
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

  /**
   * While a child re-records, the recording they already have keeps "Aufnahme löschen"
   * and the file chooser on the page. The three cases below are what those two controls
   * must do to the microphone that is running behind them.
   */
  test("gives the microphone back when a running recording is thrown away", async ({ page }) => {
    await stubMedia(page, "records");
    await signInAsFamily(page);
    await page.goto("/");

    const area = recorder(page);
    await area.getByRole("button", { name: startButton }).click();
    await area.getByRole("button", { name: stopButton }).click();
    await expect(player(page)).toBeVisible();

    await area.getByRole("button", { name: reRecordButton }).click();
    await expect(area.getByRole("button", { name: stopButton })).toBeVisible();

    await area.getByRole("button", { name: discardButton }).click();

    await expect(player(page)).toHaveCount(0);
    await expect(area.getByText(audioCapturePhaseMessage("ready"))).toBeVisible();
    // Two microphones were taken and two were handed back: the one that was stopped,
    // and the one that was still running when the child threw the recording away.
    await expect.poll(() => stoppedTracks(page)).toBe(2);

    // And the way back is open, on a microphone that is genuinely free again.
    await area.getByRole("button", { name: startButton }).click();
    await expect(area.getByRole("button", { name: stopButton })).toBeVisible();
  });

  test("gives the microphone back when a chosen file replaces a running recording", async ({
    page,
  }) => {
    await stubMedia(page, "records");
    await signInAsFamily(page);
    await page.goto("/");

    const area = recorder(page);
    await area.getByRole("button", { name: startButton }).click();
    await area.getByRole("button", { name: stopButton }).click();
    await expect(player(page)).toBeVisible();

    await area.getByRole("button", { name: reRecordButton }).click();
    await expect(area.getByRole("button", { name: stopButton })).toBeVisible();

    await page.setInputFiles("#audio-file", audioFileFixture);

    await expect(area.getByText(audioFileFixture.name)).toBeVisible();
    await expect(area.getByRole("button", { name: stopButton })).toHaveCount(0);
    await expect.poll(() => stoppedTracks(page)).toBe(2);
  });

  test("keeps the stop button while a refused file is turned away", async ({ page }) => {
    await stubMedia(page, "records");
    await signInAsFamily(page);
    await page.goto("/");

    const area = recorder(page);
    await area.getByRole("button", { name: startButton }).click();
    await expect(area.getByRole("button", { name: stopButton })).toBeVisible();

    await page.setInputFiles("#audio-file", imageFileFixture);

    await expect(area.getByRole("alert")).toHaveText(audioCaptureFailureMessage("file-not-audio"));
    await expect(area.getByText(audioCapturePhaseMessage("recording"))).toBeVisible();
    await expect(area.getByRole("button", { name: stopButton })).toBeVisible();
    expect(await stoppedTracks(page)).toBe(0);

    await area.getByRole("button", { name: stopButton }).click();
    await expect(player(page)).toBeVisible();
    await expect.poll(() => stoppedTracks(page)).toBe(1);
  });

  test("never claims the recording went anywhere before it has", async ({ page }) => {
    await stubMedia(page, "records");
    await signInAsFamily(page);
    await page.goto("/");

    const area = recorder(page);
    await area.getByRole("button", { name: startButton }).click();
    await area.getByRole("button", { name: stopButton }).click();
    await expect(player(page)).toBeVisible();

    // A finished recording that has not been sent. The button is an invitation, and
    // nothing on the page may read as an act that already happened.
    await expect(area.getByRole("button", { name: sendButton })).toBeVisible();

    const text = await area.innerText();
    expectChildSafe(text, "the recording area before sending");
    expect(text).toContain("bleibt auf diesem Gerät, bis du sie abschickst");
    for (const claim of ["angekommen", "gesendet", "geschickt", "hochgeladen", "gespeichert"]) {
      expect(text.toLowerCase(), `the recording area must not say "${claim}" yet`).not.toContain(
        claim,
      );
    }
  });
});

/**
 * MCL-30B: the recording actually leaving the device.
 *
 * These cases cross the real route into the real store, so what they prove is the whole
 * journey rather than a component's opinion of it. The rule under test is one sentence:
 * "angekommen" appears when, and only when, the project answered with a receipt.
 */
test.describe("child audio submission", () => {
  test("says the recording arrived only after the project has answered", async ({ page }) => {
    await stubMedia(page, "records");
    await signInAsFamily(page);
    await page.goto("/");

    // Held open until this test lets it go, so the in-flight moment is observable rather
    // than something that flickers past between two assertions.
    // Initialised rather than left null: assigning inside the executor narrows a
    // `null` initialiser to `never`, and the call below then does not typecheck.
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(audioEndpoint, async (route) => {
      await held;
      await route.continue();
    });

    const area = recorder(page);
    await area.getByRole("button", { name: startButton }).click();
    await area.getByRole("button", { name: stopButton }).click();
    await area.getByRole("button", { name: sendButton }).click();

    // In flight: the bytes have left the browser and nothing may say they arrived.
    await expect(area.getByText(audioSendPhaseMessage("sending"))).toBeVisible();
    await expect(area).not.toContainText("angekommen");
    await expect(area.getByRole("button", { name: sendButton })).toBeDisabled();

    release();

    // Only now, and only from the receipt the route minted.
    await expect(area.getByText(audioSendPhaseMessage("sent"))).toBeVisible();
    await expect(area.getByRole("button", { name: sendButton })).toHaveCount(0);
    expectChildSafe(await area.innerText(), "the recording area after a successful send");
  });

  test("keeps the recording when the project cannot be reached, and the retry works", async ({
    page,
  }) => {
    await stubMedia(page, "records");
    await signInAsFamily(page);
    await page.goto("/");

    const submissionIds: string[] = [];
    let attempts = 0;
    await page.route(audioEndpoint, async (route) => {
      attempts += 1;
      submissionIds.push(route.request().headers()["x-avaloria-submission-id"] ?? "");
      // The first attempt never produces an answer. The second goes to the real route.
      if (attempts === 1) await route.abort("connectionfailed");
      else await route.continue();
    });

    const area = recorder(page);
    await area.getByRole("button", { name: startButton }).click();
    await area.getByRole("button", { name: stopButton }).click();
    await area.getByRole("button", { name: sendButton }).click();

    await expect(area.getByRole("alert")).toHaveText(audioSendFailureMessage("transport"));
    await expect(area.getByText(audioSendPhaseMessage("failed"))).toBeVisible();
    // The recording is still here, and so is the way to send it - no re-recording needed.
    await expect(player(page)).toBeVisible();
    await expect(area.getByRole("button", { name: resendButton })).toBeEnabled();
    expectChildSafe(await area.innerText(), "the recording area after a failed send");

    await area.getByRole("button", { name: resendButton }).click();
    await expect(area.getByText(audioSendPhaseMessage("sent"))).toBeVisible();

    // The retry carried the SAME identity, which is what lets the route recognise an
    // attempt it may already have stored instead of filing a second answer.
    expect(attempts).toBe(2);
    expect(submissionIds[0]).toBe(submissionIds[1]);
    expect(submissionIds[0].length).toBeGreaterThan(0);
  });

  test("does not claim success when the project asks the child to slow down", async ({ page }) => {
    await stubMedia(page, "records");
    await signInAsFamily(page);
    await page.goto("/");

    await page.route(audioEndpoint, (route) =>
      route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({ acknowledged: false, error: "too-many-requests" }),
      }),
    );

    const area = recorder(page);
    await area.getByRole("button", { name: startButton }).click();
    await area.getByRole("button", { name: stopButton }).click();
    await area.getByRole("button", { name: sendButton }).click();

    await expect(area.getByRole("alert")).toHaveText(audioSendFailureMessage("rate-limited"));
    await expect(area).not.toContainText("angekommen");
    // Waiting is the next step, and it is still open: the button is there to press again.
    await expect(area.getByRole("button", { name: resendButton })).toBeEnabled();
    await expect(player(page)).toBeVisible();
  });

  test("recovers when the project's yes came back without its receipt", async ({ page }) => {
    await stubMedia(page, "records");
    await signInAsFamily(page);
    await page.goto("/");

    // MCL-30B review finding F1, in a real browser and against the real route.
    //
    // The request is NOT faked away: it reaches the handler, the recording is stored and a
    // real receipt is minted. Only the answer is damaged on its way back to the page -
    // still 201, still valid JSON, still saying yes, with the receipt fields removed, the
    // way a proxy or a response rewrite removes them. That shape has exactly two ways to
    // be wrong, and both would be invisible in a green happy path:
    //
    // - drawing "angekommen" from it, which would be a lie about a receipt nobody has; and
    // - calling it a refusal, which would ask this child to record something new when the
    //   project already holds what they said - one spoken answer, filed twice.
    const submissionIds: string[] = [];
    const statuses: number[] = [];
    let mintedOnFirstAttempt = "";
    let attempts = 0;
    // Recorded here and asserted in the test body rather than inside the handler: an
    // expectation that fails inside a route callback fails the run in a far less legible
    // place than one that fails where the story is being told.
    await page.route(audioEndpoint, async (route) => {
      attempts += 1;
      submissionIds.push(route.request().headers()["x-avaloria-submission-id"] ?? "");

      const answer = await route.fetch();
      statuses.push(answer.status());

      if (attempts > 1) {
        await route.fulfill({ response: answer });
        return;
      }

      const body = (await answer.json()) as { receiptId?: unknown };
      mintedOnFirstAttempt = typeof body.receiptId === "string" ? body.receiptId : "";

      await route.fulfill({
        status: answer.status(),
        contentType: "application/json",
        body: JSON.stringify({ acknowledged: true }),
      });
    });

    const area = recorder(page);
    await area.getByRole("button", { name: startButton }).click();
    await area.getByRole("button", { name: stopButton }).click();
    await area.getByRole("button", { name: sendButton }).click();

    // Retryable, and never arrival. The sentence is the transport one, which invites
    // another try - deliberately NOT the refusal sentence, which asks for a new recording.
    await expect(area.getByRole("alert")).toHaveText(audioSendFailureMessage("transport"));
    await expect(area.getByRole("alert")).not.toHaveText(audioSendFailureMessage("refused"));
    await expect(area).not.toContainText("angekommen");

    // The first attempt really was stored: a 201 carrying a real receipt, which this page
    // never got to see. Without this, the case above would be indistinguishable from a
    // route that had refused the recording outright - and proving the difference is the
    // entire reason this test drives the real handler instead of a stubbed answer.
    expect(statuses).toEqual([201]);
    expect(mintedOnFirstAttempt.length).toBeGreaterThan(0);

    // The recording survived, and the way to send it again is right there.
    await expect(player(page)).toBeVisible();
    await expect(area.getByRole("button", { name: resendButton })).toBeEnabled();
    expectChildSafe(await area.innerText(), "the recording area after a receipt-less yes");

    await area.getByRole("button", { name: resendButton }).click();

    // The retry carried the same identity into the same route, which answered with the
    // record it already held - so the child ends up at the receipt the first attempt
    // minted, and the project holds one answer rather than two.
    await expect(area.getByText(audioSendPhaseMessage("sent"))).toBeVisible();
    expect(attempts).toBe(2);
    expect(submissionIds[0]).toBe(submissionIds[1]);
    expect(submissionIds[0].length).toBeGreaterThan(0);
    // 200 and not a second 201: the route created nothing this time, it recognised the
    // submissionId and handed back the record it already had.
    expect(statuses).toEqual([201, 200]);
  });

  test("does not claim success when the project cannot store the recording", async ({ page }) => {
    await stubMedia(page, "records");
    await signInAsFamily(page);
    await page.goto("/");

    await page.route(audioEndpoint, (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ acknowledged: false, error: "inbox-unavailable" }),
      }),
    );

    const area = recorder(page);
    await area.getByRole("button", { name: startButton }).click();
    await area.getByRole("button", { name: stopButton }).click();
    await area.getByRole("button", { name: sendButton }).click();

    await expect(area.getByRole("alert")).toHaveText(audioSendFailureMessage("unavailable"));
    await expect(area).not.toContainText("angekommen");
    // Nothing of the outage reaches the child: no code, no path, no transport word.
    expectChildSafe(await area.innerText(), "the recording area after a storage failure");
    await expect(area).not.toContainText("503");
  });

  test("sends a chosen file when this browser cannot record at all", async ({ page }) => {
    await stubMedia(page, "absent");
    await signInAsFamily(page);
    await page.goto("/");

    const declaredTypes: string[] = [];
    await page.route(audioEndpoint, async (route) => {
      declaredTypes.push(route.request().headers()["content-type"] ?? "");
      await route.continue();
    });

    const area = recorder(page);
    await area.getByRole("button", { name: startButton }).click();
    await expect(
      area.getByText(audioCaptureFailureMessage("recording-unsupported")),
    ).toBeVisible();

    await page.setInputFiles("#audio-file", audioFileFixture);
    await expect(player(page)).toBeVisible();

    await area.getByRole("button", { name: sendButton }).click();
    await expect(area.getByText(audioSendPhaseMessage("sent"))).toBeVisible();

    // The same route, the same validation, the same receipt - there is no second path a
    // picked file could have taken. The declared type is what the bytes are, not the
    // label the file arrived with.
    expect(declaredTypes).toEqual(["audio/mpeg"]);
  });

  test("gives a fresh recording its own identity instead of reusing the sent one", async ({
    page,
  }) => {
    await stubMedia(page, "records");
    await signInAsFamily(page);
    await page.goto("/");

    const submissionIds: string[] = [];
    await page.route(audioEndpoint, async (route) => {
      submissionIds.push(route.request().headers()["x-avaloria-submission-id"] ?? "");
      await route.continue();
    });

    const area = recorder(page);
    await area.getByRole("button", { name: startButton }).click();
    await area.getByRole("button", { name: stopButton }).click();
    await area.getByRole("button", { name: sendButton }).click();
    await expect(area.getByText(audioSendPhaseMessage("sent"))).toBeVisible();

    // A second answer to the same question. Reusing the first id here would make the
    // route answer with the FIRST recording's receipt and quietly drop this one.
    await area.getByRole("button", { name: reRecordButton }).click();
    await area.getByRole("button", { name: stopButton }).click();
    await expect(area.getByRole("button", { name: sendButton })).toBeVisible();
    await area.getByRole("button", { name: sendButton }).click();
    await expect(area.getByText(audioSendPhaseMessage("sent"))).toBeVisible();

    expect(submissionIds).toHaveLength(2);
    expect(submissionIds[0]).not.toBe(submissionIds[1]);
  });

  test("keeps an unsent recording across a topic change on the same page", async ({ page }) => {
    await stubMedia(page, "records");
    await signInAsFamily(page);
    await page.goto("/");

    const area = recorder(page);
    await area.getByRole("button", { name: startButton }).click();
    await area.getByRole("button", { name: stopButton }).click();
    const source = await player(page).getAttribute("src");

    // A soft navigation a child makes all the time: picking a different topic replaces
    // the address without leaving the page. A recording that did not survive it would be
    // lost to a click that has nothing to do with recording.
    await page.getByRole("button", { name: topicChip }).click();
    await expect(page).toHaveURL(/thema=/u);

    await expect(player(page)).toBeVisible();
    expect(await player(page).getAttribute("src")).toBe(source);
    await expect(area.getByRole("button", { name: sendButton })).toBeEnabled();
  });
});
