"use client";

import { type ChangeEvent, useEffect, useState, useSyncExternalStore } from "react";
import type { AudioCapturePhase } from "@/adapters/media/audio-capture-controller";
import {
  audioCaptureFailureMessage,
  audioCapturePhaseMessage,
} from "@/app/audio-capture-message";
import { createBrowserAudioCaptureController } from "@/composition/browser";

/**
 * MCL-30A. The child-facing recording area: start, stop, listen, throw away, record
 * again - or pick a file when the microphone is not available.
 *
 * Only the drawing lives here. Every rule about microphone tracks, object URLs and
 * failure reasons lives in the controller, which is why this component holds no state
 * of its own beyond the controller instance: two copies of "is it recording" would be
 * two chances for the button and the microphone to disagree.
 *
 * What this area must never say: that the recording was sent, kept, or received. It
 * cannot be sent - there is no server path for audio in this slice (MCL-49) - so the
 * note under the heading states plainly what actually happens to it.
 */

const phaseIcons = {
  ready: "🎙",
  "requesting-permission": "…",
  recording: "●",
  recorded: "✓",
  error: "!",
} as const satisfies Record<AudioCapturePhase, string>;

export function AudioAnswerRecorder() {
  // Created once per mounted component, never shared: two children of this component
  // would otherwise fight over one microphone.
  const [controller] = useState(createBrowserAudioCaptureController);
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);

  // The one thing that must happen even when the child simply navigates away: the
  // microphone is handed back and the preview URL is released. Under StrictMode React
  // runs this cleanup once right after the first mount too, which is why release()
  // leaves the controller usable rather than dead.
  useEffect(() => controller.release, [controller]);

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Reset the field, so choosing the same file twice is still a choice the child can
    // make after discarding the first attempt.
    event.target.value = "";
    if (file !== undefined) controller.chooseFile(file);
  }

  const isRecording = state.phase === "recording";
  const hasRecording = state.recording !== null;

  return (
    <section className="audio-answer" aria-labelledby="audio-answer-heading">
      <h3 id="audio-answer-heading">Antwort aufnehmen</h3>
      {/*
        The honest sentence this whole slice is built around. Written before the
        buttons, not under them, so a child reads what will happen to the recording
        before they make one.
      */}
      <p className="audio-answer-note">
        Deine Aufnahme bleibt nur auf diesem Gerät, solange die Seite offen ist. Abschicken
        kannst du sie noch nicht - das kommt später.
      </p>

      <div className="audio-answer-controls">
        {isRecording ? (
          <button className="button button-primary" onClick={controller.stopRecording} type="button">
            <span aria-hidden="true">⏹</span> Aufnahme stoppen
          </button>
        ) : (
          <button
            className="button button-primary"
            disabled={state.phase === "requesting-permission"}
            onClick={() => void controller.startRecording()}
            type="button"
          >
            <span aria-hidden="true">🎙</span>{" "}
            {hasRecording ? "Neu aufnehmen" : "Aufnahme starten"}
          </button>
        )}
        {hasRecording ? (
          <button className="button button-secondary" onClick={controller.discard} type="button">
            <span aria-hidden="true">✕</span> Aufnahme löschen
          </button>
        ) : null}
      </div>

      {/*
        One live region that is always in the document, so a change to it is announced
        instead of arriving as a whole new area. The icon is decorative: the sentence
        alone already says which state this is, and so does the border - the red dot
        while recording is a help, never the message itself.
      */}
      <p className={`audio-answer-state audio-answer-state-${state.phase}`} role="status">
        <span aria-hidden="true">{phaseIcons[state.phase]}</span>{" "}
        {audioCapturePhaseMessage(state.phase)}
      </p>

      {state.failure === null ? null : (
        <p className="audio-answer-problem" role="alert">
          {audioCaptureFailureMessage(state.failure)}
        </p>
      )}

      {state.recording === null ? null : (
        <div className="audio-answer-preview">
          {/*
            The captured bytes themselves. `key` on the URL so replacing a recording
            gives the element a new source rather than asking the browser to swap the
            src of something it is already holding open.
          */}
          <audio
            aria-label="Deine Aufnahme anhören"
            className="audio-answer-player"
            controls
            key={state.recording.previewUrl}
            src={state.recording.previewUrl}
          />
          {state.recording.fileName === null ? null : (
            <p className="audio-answer-filename">Ausgewählt: {state.recording.fileName}</p>
          )}
        </div>
      )}

      {/*
        Always offered, not only after the microphone has failed: a child whose device
        cannot record should not have to press a button and be told no before they are
        shown the way that works.
      */}
      <div className="audio-answer-file">
        <label htmlFor="audio-file">Oder such eine Tondatei aus</label>
        <input accept="audio/*" id="audio-file" onChange={chooseFile} type="file" />
      </div>
    </section>
  );
}
