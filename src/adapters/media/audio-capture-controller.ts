/**
 * MCL-30A: the browser side of a child recording an answer. Everything the recording
 * experience knows lives here, framework-free and with its browser APIs injected, so
 * the two rules that actually protect a device - every microphone track is stopped,
 * every object URL is revoked - are provable without a microphone and without React.
 *
 * What this module deliberately does NOT do: send anything. There is no server path
 * for audio yet (MCL-49 owns that), so a recording here is exactly what it says it is -
 * bytes held by this page for as long as it is open. Nothing in this file may grow a
 * delivery, a receipt, or a status that reads like arrival.
 */

/** What the child is currently doing, in the order they can move through it. */
export type AudioCapturePhase =
  | "ready"
  | "requesting-permission"
  | "recording"
  | "recorded"
  | "error";

/**
 * Every way capturing can fail, as a closed set - the child-facing table in
 * `@/app/audio-capture-message` is `satisfies Record<AudioCaptureFailureReason, …>`,
 * so a new reason is a compile error there rather than an unexplained silence here.
 *
 * "recording-unsupported" and "microphone-unavailable" are kept apart because the
 * advice differs: the first browser will never record, the second one might once a
 * microphone exists.
 */
export type AudioCaptureFailureReason =
  | "recording-unsupported"
  | "microphone-unavailable"
  | "permission-denied"
  | "recording-failed"
  | "empty-recording"
  | "file-not-audio";

export type CapturedAudio = Readonly<{
  /** The original bytes: the recorder's own output, or the chosen file itself. */
  blob: Blob;
  /** Object URL for the audio element. Owned by this controller, revoked by it. */
  previewUrl: string;
  source: "microphone" | "file";
  /** Only a chosen file has a name worth showing back. */
  fileName: string | null;
}>;

export type AudioCaptureState = Readonly<{
  phase: AudioCapturePhase;
  recording: CapturedAudio | null;
  failure: AudioCaptureFailureReason | null;
}>;

/** The part of MediaRecorder this controller uses, so a test can stand in for it. */
export type MediaRecorderLike = {
  readonly mimeType: string;
  readonly state: string;
  start(): void;
  stop(): void;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
};

export type MediaStreamTrackLike = Readonly<{ stop(): void }>;
export type MediaStreamLike = Readonly<{ getTracks(): readonly MediaStreamTrackLike[] }>;

/**
 * The browser capabilities this controller borrows. `null` means "this browser does
 * not have it at all", which is a different answer from a call that fails - and the
 * only one that can be given before asking the child for permission.
 */
export type AudioCaptureEnvironment = Readonly<{
  requestMicrophone: (() => Promise<MediaStreamLike>) | null;
  createRecorder: ((stream: MediaStreamLike) => MediaRecorderLike) | null;
  createPreviewUrl: (blob: Blob) => string;
  revokePreviewUrl: (url: string) => void;
}>;

/**
 * File endings accepted when the browser hands over a file with no type at all, which
 * some systems do. A named type is still preferred; this is the fallback, not the rule.
 */
const audioFileEndings = [
  ".mp3",
  ".m4a",
  ".aac",
  ".wav",
  ".ogg",
  ".oga",
  ".opus",
  ".weba",
  ".webm",
  ".flac",
  ".caf",
  ".amr",
] as const;

const readyState: AudioCaptureState = { phase: "ready", recording: null, failure: null };

/**
 * Reads the real browser. Safe to call while server-rendering: nothing exists there,
 * so both capabilities answer `null` and the controller simply cannot record - which is
 * never rendered, so the client's real answer cannot disagree with the server's markup.
 */
export function browserAudioCaptureEnvironment(): AudioCaptureEnvironment {
  const devices =
    typeof navigator === "undefined" ? undefined : (navigator.mediaDevices as MediaDevices | undefined);
  const canAskForMicrophone = typeof devices?.getUserMedia === "function";
  const canRecord = typeof globalThis.MediaRecorder === "function";

  return {
    requestMicrophone:
      canAskForMicrophone && canRecord ? () => devices.getUserMedia({ audio: true }) : null,
    createRecorder: canRecord && canAskForMicrophone ? adaptRecorder : null,
    createPreviewUrl: (blob) => URL.createObjectURL(blob),
    revokePreviewUrl: (url) => URL.revokeObjectURL(url),
  };
}

/**
 * Wraps the real MediaRecorder rather than casting it, so the handler shapes this
 * controller relies on are converted in exactly one place.
 *
 * No timeslice is passed to `start()`: without one the browser reports the whole
 * recording as a single chunk, which is what lets the preview be the captured object
 * itself instead of a copy of it.
 */
function adaptRecorder(stream: MediaStreamLike): MediaRecorderLike {
  const recorder = new MediaRecorder(stream as MediaStream);
  const like: MediaRecorderLike = {
    get mimeType() {
      return recorder.mimeType;
    },
    get state() {
      return recorder.state;
    },
    start: () => recorder.start(),
    stop: () => recorder.stop(),
    ondataavailable: null,
    onstop: null,
    onerror: null,
  };

  recorder.ondataavailable = (event) => like.ondataavailable?.({ data: event.data });
  recorder.onstop = () => like.onstop?.();
  recorder.onerror = (event) => like.onerror?.(event);
  return like;
}

function isAudioFile(file: Blob & { readonly name?: string }): boolean {
  if (file.size === 0) return false;
  if (file.type.length > 0) return file.type.toLowerCase().startsWith("audio/");

  const name = (file.name ?? "").toLowerCase();
  return audioFileEndings.some((ending) => name.endsWith(ending));
}

/**
 * A microphone error carries a name, not a message a child should ever see. Only the
 * name is read, and only to choose between two sentences - it never leaves this module.
 */
function reasonForMicrophoneError(error: unknown): AudioCaptureFailureReason {
  const name = error instanceof Error ? error.name : "";
  return name === "NotAllowedError" || name === "SecurityError"
    ? "permission-denied"
    : "microphone-unavailable";
}

export class AudioCaptureController {
  readonly #environment: AudioCaptureEnvironment;
  readonly #listeners = new Set<() => void>();
  #state: AudioCaptureState = readyState;
  #stream: MediaStreamLike | null = null;
  #recorder: MediaRecorderLike | null = null;
  #chunks: Blob[] = [];
  /**
   * Bumped by every release. An acquisition that was already in flight compares the
   * number it started with against this one and gives its stream straight back instead
   * of attaching it to a controller that has since let go - the case a boolean cannot
   * express, because a released controller is usable again immediately afterwards.
   */
  #generation = 0;

  /**
   * Whether this browser can record at all. Read from the environment once, and kept
   * off the state on purpose: a server render answers `false` and the browser answers
   * `true`, so anything drawn from it would differ between the two.
   */
  readonly microphoneAvailable: boolean;

  constructor(environment: AudioCaptureEnvironment = browserAudioCaptureEnvironment()) {
    this.#environment = environment;
    this.microphoneAvailable =
      environment.requestMicrophone !== null && environment.createRecorder !== null;
  }

  /** Stable while nothing changed, so React may use it as an external store. */
  readonly snapshot = (): AudioCaptureState => this.#state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly startRecording = async (): Promise<void> => {
    // One recorder at a time. Without this, a second press acquires a second stream
    // whose tracks the first stop() never sees - a microphone left open with no way
    // back to it.
    if (this.#state.phase === "requesting-permission" || this.#state.phase === "recording") return;

    const { requestMicrophone, createRecorder } = this.#environment;
    if (requestMicrophone === null || createRecorder === null) {
      this.#fail("recording-unsupported");
      return;
    }

    this.#publish({ phase: "requesting-permission", recording: this.#state.recording, failure: null });

    const generation = this.#generation;
    let stream: MediaStreamLike;
    try {
      stream = await requestMicrophone();
    } catch (error) {
      // Same guard as the granted branch below: a refusal that arrives after the
      // controller was released belongs to a recording nobody is waiting for any more,
      // and must not put an error in front of whoever is looking at it now.
      if (generation === this.#generation) this.#fail(reasonForMicrophoneError(error));
      return;
    }

    // The child may have left, or pressed away, while the permission prompt was open.
    // The microphone was still granted, and it is this branch that gives it back.
    if (generation !== this.#generation) {
      stopTracks(stream);
      return;
    }

    this.#stream = stream;
    this.#chunks = [];

    try {
      const recorder = createRecorder(stream);
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) this.#chunks.push(event.data);
      };
      recorder.onstop = () => this.#finish();
      recorder.onerror = () => {
        this.#releaseMicrophone();
        this.#fail("recording-failed");
      };
      this.#recorder = recorder;
      recorder.start();
    } catch {
      this.#releaseMicrophone();
      this.#fail("recording-failed");
      return;
    }

    this.#publish({ phase: "recording", recording: this.#state.recording, failure: null });
  };

  readonly stopRecording = (): void => {
    if (this.#state.phase !== "recording" || this.#recorder === null) return;
    try {
      this.#recorder.stop();
    } catch {
      // A recorder that cannot be stopped still must not keep the microphone open.
      this.#releaseMicrophone();
      this.#fail("recording-failed");
    }
  };

  /**
   * Throwing the recording away also gives up a recording still being made. While the
   * child re-records, the previous recording keeps this button on the page - and
   * publishing "ready" without cancelling would leave the microphone open behind a
   * page that no longer offers a way to stop it.
   */
  readonly discard = (): void => {
    this.#cancelCapture();
    this.#revokePreview();
    this.#publish(readyState);
  };

  readonly chooseFile = (file: Blob & { readonly name?: string }): void => {
    if (!isAudioFile(file)) {
      // Nothing is revoked here: a recording the child already made is theirs to keep,
      // and a refused file must not take it away from them. Nor may it move a child
      // out of a recording that is still running: the stop button lives on that phase.
      if (this.#holdsCapture()) this.#refuseWithoutLeaving("file-not-audio");
      else this.#fail("file-not-audio");
      return;
    }

    // The chosen file replaces whatever was being recorded, so the microphone behind it
    // is handed back before the new state is published rather than left running under a
    // page that now shows a file.
    this.#cancelCapture();
    this.#revokePreview();
    this.#publish({
      phase: "recorded",
      recording: {
        blob: file,
        previewUrl: this.#environment.createPreviewUrl(file),
        source: "file",
        fileName: file.name ?? null,
      },
      failure: null,
    });
  };

  /**
   * Every borrowed resource given back: microphone tracks, recorder, object URL. The
   * controller is left ready rather than dead, because React calls this on unmount and
   * - under StrictMode - also once immediately after the first mount. A one-way
   * teardown would leave the child with buttons that silently do nothing, which is
   * exactly what an earlier version of this file did.
   *
   * Deliberately silent: it publishes no state, so a component on its way out is never
   * asked to render again. A component that mounts afterwards reads the ready snapshot
   * on its own.
   */
  readonly release = (): void => {
    this.#cancelCapture();
    this.#revokePreview();
    this.#state = readyState;
  };

  /**
   * Every resource an in-flight capture holds, given back: the acquisition that has not
   * answered yet, the recorder, the microphone tracks. Publishes nothing - the caller
   * decides what the child sees next, and release() deliberately shows nothing at all.
   *
   * Safe to call when there is no capture: that is the case every caller hits most of
   * the time, and it must cost nothing but a generation the pending-acquisition guard
   * will never match.
   */
  #cancelCapture(): void {
    this.#generation += 1;

    // Handlers first: stopping a recorder fires onstop, and this teardown must not be
    // finished by the very thing it is tearing down.
    const recorder = this.#recorder;
    this.#detachRecorder();
    if (recorder !== null && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // Already gone; the tracks below are what actually matters.
      }
    }

    this.#stopStream();
    this.#recorder = null;
    this.#chunks = [];
  }

  /**
   * Whether a capture is still this controller's to give back - an acquisition waiting
   * for an answer, or a recorder that is running. Read from the published phase because
   * that is the same thing every caller from outside can see: the phases below are
   * exactly the two the controller never rests in without owning something.
   */
  #holdsCapture(): boolean {
    return this.#state.phase === "requesting-permission" || this.#state.phase === "recording";
  }

  #finish(): void {
    this.#releaseMicrophone();

    const chunks = this.#chunks;
    this.#chunks = [];
    if (chunks.length === 0 || chunks.every((chunk) => chunk.size === 0)) {
      this.#fail("empty-recording");
      return;
    }

    // A single chunk is passed straight through - the browser's own output object,
    // not a copy of it. Several are joined, which concatenates bytes and re-labels
    // nothing: this code never decodes, converts or re-encodes what it captured.
    const only = chunks.length === 1 ? chunks[0] : undefined;
    const blob =
      only !== undefined && only.type.length > 0
        ? only
        : new Blob(chunks, { type: this.#recorder?.mimeType ?? chunks[0]?.type ?? "" });

    this.#recorder = null;
    this.#revokePreview();
    this.#publish({
      phase: "recorded",
      recording: {
        blob,
        previewUrl: this.#environment.createPreviewUrl(blob),
        source: "microphone",
        fileName: null,
      },
      failure: null,
    });
  }

  /**
   * A failure keeps whatever the child already recorded. Only a child with nothing in
   * hand sees the error phase; for the others the problem is an added sentence, not a
   * lost recording.
   */
  #fail(failure: AudioCaptureFailureReason): void {
    const recording = this.#state.recording;
    this.#publish({ phase: recording === null ? "error" : "recorded", recording, failure });
  }

  /**
   * A failure that took nothing away: the child stays exactly where they were, with one
   * more sentence. Kept apart from #fail because #fail decides a phase from what is in
   * hand - correct after a capture has ended, wrong while one is still running, where it
   * would replace the stop button with a recording the child cannot stop any more.
   */
  #refuseWithoutLeaving(failure: AudioCaptureFailureReason): void {
    this.#publish({ phase: this.#state.phase, recording: this.#state.recording, failure });
  }

  #releaseMicrophone(): void {
    this.#stopStream();
    this.#detachRecorder();
  }

  #stopStream(): void {
    if (this.#stream !== null) stopTracks(this.#stream);
    this.#stream = null;
  }

  #detachRecorder(): void {
    if (this.#recorder === null) return;
    this.#recorder.ondataavailable = null;
    this.#recorder.onstop = null;
    this.#recorder.onerror = null;
  }

  #revokePreview(): void {
    const url = this.#state.recording?.previewUrl;
    if (url !== undefined) this.#environment.revokePreviewUrl(url);
  }

  #publish(state: AudioCaptureState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}

function stopTracks(stream: MediaStreamLike): void {
  for (const track of stream.getTracks()) track.stop();
}
