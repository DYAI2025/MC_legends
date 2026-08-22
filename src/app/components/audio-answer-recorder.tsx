"use client";

import { type ChangeEvent, useEffect, useState, useSyncExternalStore } from "react";
import type { AudioCapturePhase } from "@/adapters/media/audio-capture-controller";
import { idleSendState } from "@/adapters/media/audio-answer-sender";
import {
  audioCaptureFailureMessage,
  audioCapturePhaseMessage,
} from "@/app/audio-capture-message";
import { audioSendFailureMessage, audioSendPhaseMessage } from "@/app/audio-send-message";
import {
  createBrowserAudioAnswerSender,
  createBrowserAudioCaptureController,
} from "@/composition/browser";

/**
 * MCL-30A/MCL-30B. The child-facing recording area: start, stop, listen, throw away,
 * record again - or pick a file when the microphone is not available - and then send it.
 *
 * Only the drawing lives here. Every rule about microphone tracks and object URLs lives
 * in the capture controller; every rule about identity, attempts and receipts lives in
 * the sender. This component holds no state of its own beyond the two instances: two
 * copies of "is it recording" or "did it arrive" would be two chances for the page and
 * the truth to disagree.
 *
 * The one sentence this area may not say without a server receipt is "angekommen", and it
 * cannot: the word appears once, in the sender's `sent` message, and the sender reaches
 * that phase only by resolving an inbox call that produced a receipt.
 */

const phaseIcons = {
  ready: "🎙",
  "requesting-permission": "…",
  recording: "●",
  recorded: "✓",
  error: "!",
} as const satisfies Record<AudioCapturePhase, string>;

export type AudioAnswerRecorderProps = Readonly<{
  /**
   * Which open question this recording answers. A prop rather than something read here,
   * for the same reason the text form takes it from the page: the question a child is
   * looking at is the page's decision, and two places choosing it would be two answers.
   */
  questionId: string;
}>;

export function AudioAnswerRecorder({ questionId }: AudioAnswerRecorderProps) {
  // Created once per mounted component, never shared: two children of this component
  // would otherwise fight over one microphone.
  const [controller] = useState(createBrowserAudioCaptureController);
  const [sender] = useState(createBrowserAudioAnswerSender);
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const sent = useSyncExternalStore(sender.subscribe, sender.snapshot, sender.snapshot);

  // The one thing that must happen even when the child simply navigates away: the
  // microphone is handed back and the preview URL is released. Under StrictMode React
  // runs this cleanup once right after the first mount too, which is why release()
  // leaves the controller usable rather than dead.
  //
  // The dependency list is the recording's survival: it names only the controller, which
  // never changes, so an ordinary re-render - a category chip, a state update elsewhere
  // on the page - cannot run this cleanup and cannot take a finished recording away.
  useEffect(() => controller.release, [controller]);

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Reset the field, so choosing the same file twice is still a choice the child can
    // make after discarding the first attempt.
    event.target.value = "";
    if (file !== undefined) controller.chooseFile(file);
  }

  const isRecording = state.phase === "recording";
  const recording = state.recording;
  const hasRecording = recording !== null;

  /*
    The send state belongs to the recording it was published for. Comparing identities
    rather than subscribing the sender to the capture controller keeps the two apart and
    makes "throw it away and record again" reset this area for free: the new recording is
    a different object, so there is nothing here that could still be claiming the old one
    arrived. No effect, no second copy of "which recording is current".
  */
  const send = sent.recording === recording ? sent : idleSendState;
  const isSending = send.phase === "sending";
  const hasArrived = send.phase === "sent";

  return (
    <section className="audio-answer" aria-labelledby="audio-answer-heading">
      <h3 id="audio-answer-heading">Antwort aufnehmen</h3>
      {/*
        The honest sentence this area is built around, written before the buttons rather
        than under them, so a child reads what happens to a recording before they make
        one. Both halves are true and both matter: nothing leaves this device until the
        child presses send, and a recording that has not been sent does not survive a
        reload - it lives in this page's memory and nowhere else.
      */}
      <p className="audio-answer-note">
        Deine Aufnahme bleibt auf diesem Gerät, bis du sie abschickst. Wenn du die Seite
        vorher neu lädst, ist sie weg.
      </p>

      <div className="audio-answer-controls">
        {isRecording ? (
          <button className="button button-primary" onClick={controller.stopRecording} type="button">
            <span aria-hidden="true">⏹</span> Aufnahme stoppen
          </button>
        ) : (
          <button
            className="button button-primary"
            disabled={state.phase === "requesting-permission" || isSending}
            onClick={() => void controller.startRecording()}
            type="button"
          >
            <span aria-hidden="true">🎙</span>{" "}
            {hasRecording ? "Neu aufnehmen" : "Aufnahme starten"}
          </button>
        )}
        {hasRecording ? (
          <button
            className="button button-secondary"
            disabled={isSending}
            onClick={controller.discard}
            type="button"
          >
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

      {recording === null ? null : (
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
            key={recording.previewUrl}
            src={recording.previewUrl}
          />
          {recording.fileName === null ? null : (
            <p className="audio-answer-filename">Ausgewählt: {recording.fileName}</p>
          )}
        </div>
      )}

      {/*
        MCL-30B. Sending is a deliberate press of its own, never a consequence of stopping
        a recording: a child has to be able to listen to what they made and decide.

        The buttons above stay usable while a recording is on its way, except the two that
        would take it away mid-flight. Recording again or discarding during an upload is
        possible only after it settles - the bytes may already have reached the project by
        then, and a page that let a child think discarding un-sends them would be lying.
      */}
      <div className="audio-answer-send">
        {hasRecording && !hasArrived ? (
          <button
            className="button button-primary"
            disabled={isSending}
            onClick={() => void sender.send(recording, questionId)}
            type="button"
          >
            <span aria-hidden="true">→</span>{" "}
            {send.phase === "failed" ? "Noch einmal abschicken" : "Aufnahme abschicken"}
          </button>
        ) : null}

        {/*
          Always in the document for the same reason the capture state is: a live region
          added to the page at the moment its text appears is a region most assistive
          technology never announces. Empty until there is a recording to say something
          about - "you can send it now" would be a claim about a recording that does not
          exist yet.
        */}
        <p
          className={`audio-answer-send-state audio-answer-send-state-${send.phase}`}
          role="status"
        >
          {hasRecording ? audioSendPhaseMessage(send.phase) : ""}
        </p>

        {send.failure === null ? null : (
          <p className="audio-answer-send-problem" role="alert">
            {audioSendFailureMessage(send.failure)}
          </p>
        )}
      </div>

      {/*
        Always offered, not only after the microphone has failed: a child whose device
        cannot record should not have to press a button and be told no before they are
        shown the way that works. The chosen file takes exactly the same road as a
        recording - same sniffing, same route, same receipt - so there is no second
        delivery path that could behave differently.
      */}
      <div className="audio-answer-file">
        <label htmlFor="audio-file">Oder such eine Tondatei aus</label>
        <input accept="audio/*" disabled={isSending} id="audio-file" onChange={chooseFile} type="file" />
      </div>
    </section>
  );
}
