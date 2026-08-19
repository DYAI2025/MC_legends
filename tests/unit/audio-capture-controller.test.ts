import { describe, expect, it } from "vitest";
import {
  AudioCaptureController,
  type AudioCaptureEnvironment,
  type MediaRecorderLike,
  type MediaStreamLike,
} from "@/adapters/media/audio-capture-controller";

/**
 * MCL-30A. Pins the browser-side recording lifecycle: the state a child sees, and the
 * two resources a recorder leaks if nobody stops them - the microphone tracks and the
 * object URLs behind the preview.
 *
 * Fakes rather than a real MediaRecorder on purpose: the rules under test are "every
 * track was stopped", "the previous URL was revoked" and "the bytes we captured are
 * the bytes we preview". None of them needs a microphone, and a test that needed one
 * could not run in CI at all.
 */

class FakeTrack {
  stopCalls = 0;
  stop(): void {
    this.stopCalls += 1;
  }
}

class FakeStream implements MediaStreamLike {
  readonly tracks: readonly FakeTrack[] = [new FakeTrack(), new FakeTrack()];
  getTracks(): readonly FakeTrack[] {
    return this.tracks;
  }
}

/**
 * Stands in for MediaRecorder without timeslice: chunks arrive when stop() is called,
 * then onstop. Synchronous so every assertion below is about the controller's own
 * ordering rather than about when a fake decided to resolve.
 */
class FakeRecorder implements MediaRecorderLike {
  state = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  startCalls = 0;

  constructor(
    readonly mimeType = "audio/webm;codecs=opus",
    private readonly chunks: readonly Blob[] = [
      new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm;codecs=opus" }),
    ],
  ) {}

  start(): void {
    this.startCalls += 1;
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
    for (const chunk of this.chunks) this.ondataavailable?.({ data: chunk });
    this.onstop?.();
  }

  failWhileRecording(): void {
    this.onerror?.({ name: "InvalidStateError" });
  }
}

/**
 * A recorder that refuses to stop. The real MediaRecorder throws an InvalidStateError
 * when stop() is called in a state it does not allow, and leaves the microphone exactly
 * where it was - which is the whole reason the controller catches it.
 */
class RefusingRecorder extends FakeRecorder {
  override stop(): void {
    throw new Error("stop refused");
  }
}

type Harness = Readonly<{
  environment: AudioCaptureEnvironment;
  streams: FakeStream[];
  recorders: FakeRecorder[];
  createdUrls: string[];
  revokedUrls: string[];
  urlFor: Map<string, Blob>;
}>;

function harness(
  options: Readonly<{
    microphone?: "available" | "missing";
    recorderConstructor?: "available" | "missing";
    permission?: Error;
    recorders?: () => FakeRecorder;
  }> = {},
): Harness {
  const streams: FakeStream[] = [];
  const recorders: FakeRecorder[] = [];
  const createdUrls: string[] = [];
  const revokedUrls: string[] = [];
  const urlFor = new Map<string, Blob>();
  let urlCounter = 0;

  const environment: AudioCaptureEnvironment = {
    requestMicrophone:
      options.microphone === "missing"
        ? null
        : async () => {
            if (options.permission !== undefined) throw options.permission;
            const stream = new FakeStream();
            streams.push(stream);
            return stream;
          },
    createRecorder:
      options.recorderConstructor === "missing"
        ? null
        : () => {
            const recorder = options.recorders?.() ?? new FakeRecorder();
            recorders.push(recorder);
            return recorder;
          },
    createPreviewUrl: (blob) => {
      urlCounter += 1;
      const url = `blob:fake/${urlCounter}`;
      createdUrls.push(url);
      urlFor.set(url, blob);
      return url;
    },
    revokePreviewUrl: (url) => {
      revokedUrls.push(url);
    },
  };

  return { environment, streams, recorders, createdUrls, revokedUrls, urlFor };
}

function audioFile(name = "meine-idee.webm", type = "audio/webm"): File {
  return new File([new Uint8Array([9, 8, 7])], name, { type });
}

async function recordOnce(controller: AudioCaptureController, world: Harness): Promise<void> {
  await controller.startRecording();
  world.recorders[world.recorders.length - 1]?.stop();
}

describe("AudioCaptureController", () => {
  it("starts ready, records, and ends with a recording a child can play", async () => {
    const world = harness();
    const controller = new AudioCaptureController(world.environment);

    expect(controller.snapshot().phase).toBe("ready");
    expect(controller.snapshot().recording).toBeNull();

    const started = controller.startRecording();
    expect(controller.snapshot().phase).toBe("requesting-permission");
    await started;
    expect(controller.snapshot().phase).toBe("recording");

    world.recorders[0]?.stop();

    const state = controller.snapshot();
    expect(state.phase).toBe("recorded");
    expect(state.failure).toBeNull();
    expect(state.recording?.source).toBe("microphone");
    expect(state.recording?.previewUrl).toBe(world.createdUrls[0]);
  });

  it("stops every microphone track when the recording ends", async () => {
    const world = harness();
    const controller = new AudioCaptureController(world.environment);

    await recordOnce(controller, world);

    const tracks = world.streams[0]?.getTracks() ?? [];
    expect(tracks.length).toBe(2);
    for (const track of tracks) expect(track.stopCalls).toBe(1);
  });

  it("previews exactly the bytes the browser captured, without re-encoding them", async () => {
    const first = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
    const second = new Blob([new Uint8Array([4, 5])], { type: "audio/webm" });
    const world = harness({ recorders: () => new FakeRecorder("audio/webm", [first, second]) });
    const controller = new AudioCaptureController(world.environment);

    await recordOnce(controller, world);

    const captured = controller.snapshot().recording?.blob;
    expect(captured).toBeInstanceOf(Blob);
    expect(new Uint8Array(await captured!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    expect(captured!.type).toBe("audio/webm");
    // The very object handed to the preview, so nothing can copy or convert in between.
    expect(world.urlFor.get(controller.snapshot().recording!.previewUrl)).toBe(captured);
  });

  it("hands a single chunk through untouched", async () => {
    const only = new Blob([new Uint8Array([7, 7, 7])], { type: "audio/ogg" });
    const world = harness({ recorders: () => new FakeRecorder("audio/ogg", [only]) });
    const controller = new AudioCaptureController(world.environment);

    await recordOnce(controller, world);

    expect(controller.snapshot().recording?.blob).toBe(only);
  });

  it("returns to ready and revokes the preview when the child discards a recording", async () => {
    const world = harness();
    const controller = new AudioCaptureController(world.environment);
    await recordOnce(controller, world);
    const url = controller.snapshot().recording!.previewUrl;

    controller.discard();

    expect(controller.snapshot().phase).toBe("ready");
    expect(controller.snapshot().recording).toBeNull();
    expect(world.revokedUrls).toEqual([url]);
  });

  it("replaces the previous preview and revokes its URL when recording again", async () => {
    const world = harness();
    const controller = new AudioCaptureController(world.environment);
    await recordOnce(controller, world);
    const firstUrl = controller.snapshot().recording!.previewUrl;

    await recordOnce(controller, world);
    const secondUrl = controller.snapshot().recording!.previewUrl;

    expect(secondUrl).not.toBe(firstUrl);
    expect(world.revokedUrls).toEqual([firstUrl]);
    expect(world.createdUrls).toEqual([firstUrl, secondUrl]);
  });

  it("releases tracks and the preview URL when the component goes away", async () => {
    const world = harness();
    const controller = new AudioCaptureController(world.environment);
    await recordOnce(controller, world);
    const url = controller.snapshot().recording!.previewUrl;

    controller.release();

    expect(world.revokedUrls).toEqual([url]);
    expect(controller.snapshot()).toEqual({ phase: "ready", recording: null, failure: null });
    for (const track of world.streams[0]?.getTracks() ?? []) expect(track.stopCalls).toBe(1);
  });

  it("stops the microphone when released while a recording is still running", async () => {
    const world = harness();
    const controller = new AudioCaptureController(world.environment);
    await controller.startRecording();

    controller.release();

    for (const track of world.streams[0]?.getTracks() ?? []) expect(track.stopCalls).toBe(1);
    expect(world.recorders[0]?.state).toBe("inactive");
    // No preview was invented out of the chunks a stopped recorder still emits.
    expect(controller.snapshot().recording).toBeNull();
    expect(world.createdUrls).toEqual([]);
  });

  it("ignores a second start while one recording is already running", async () => {
    const world = harness();
    const controller = new AudioCaptureController(world.environment);

    await Promise.all([controller.startRecording(), controller.startRecording()]);
    await controller.startRecording();

    expect(world.streams.length).toBe(1);
    expect(world.recorders.length).toBe(1);
    expect(world.recorders[0]?.startCalls).toBe(1);
  });

  it("tells a child recording is not possible here when the browser cannot capture", async () => {
    for (const world of [
      harness({ microphone: "missing" }),
      harness({ recorderConstructor: "missing" }),
    ]) {
      const controller = new AudioCaptureController(world.environment);
      expect(controller.microphoneAvailable).toBe(false);

      await controller.startRecording();

      expect(controller.snapshot().phase).toBe("error");
      expect(controller.snapshot().failure).toBe("recording-unsupported");

      // The fallback is what makes that failure recoverable, so it is asserted here
      // rather than only in its own case.
      const chosen = audioFile();
      controller.chooseFile(chosen);
      expect(controller.snapshot().phase).toBe("recorded");
      expect(controller.snapshot().recording?.blob).toBe(chosen);
    }
  });

  it("separates a refused microphone from a missing one", async () => {
    const denied = new Error("denied");
    denied.name = "NotAllowedError";
    const refused = new AudioCaptureController(harness({ permission: denied }).environment);
    await refused.startRecording();
    expect(refused.snapshot().failure).toBe("permission-denied");

    const missing = new Error("none");
    missing.name = "NotFoundError";
    const absent = new AudioCaptureController(harness({ permission: missing }).environment);
    await absent.startRecording();
    expect(absent.snapshot().failure).toBe("microphone-unavailable");
  });

  it("releases the microphone when the recorder itself fails", async () => {
    const world = harness();
    const controller = new AudioCaptureController(world.environment);
    await controller.startRecording();

    world.recorders[0]?.failWhileRecording();

    expect(controller.snapshot().phase).toBe("error");
    expect(controller.snapshot().failure).toBe("recording-failed");
    expect(controller.snapshot().recording).toBeNull();
    for (const track of world.streams[0]?.getTracks() ?? []) expect(track.stopCalls).toBe(1);
  });

  it("offers no preview for a recording that captured nothing", async () => {
    const world = harness({ recorders: () => new FakeRecorder("audio/webm", []) });
    const controller = new AudioCaptureController(world.environment);

    await recordOnce(controller, world);

    expect(controller.snapshot().failure).toBe("empty-recording");
    expect(controller.snapshot().recording).toBeNull();
    expect(world.createdUrls).toEqual([]);
  });

  it("previews a chosen audio file as the file itself", () => {
    const world = harness();
    const controller = new AudioCaptureController(world.environment);
    const chosen = audioFile("stimme.mp3", "audio/mpeg");

    controller.chooseFile(chosen);

    const state = controller.snapshot();
    expect(state.phase).toBe("recorded");
    expect(state.recording?.source).toBe("file");
    expect(state.recording?.fileName).toBe("stimme.mp3");
    expect(state.recording?.blob).toBe(chosen);
    expect(world.urlFor.get(state.recording!.previewUrl)).toBe(chosen);
  });

  it("accepts an audio file whose type the browser did not name, by its ending", () => {
    const world = harness();
    const controller = new AudioCaptureController(world.environment);

    controller.chooseFile(new File([new Uint8Array([1])], "lied.WAV", { type: "" }));

    expect(controller.snapshot().phase).toBe("recorded");
  });

  it("refuses a file that is not audio, and keeps no preview for it", () => {
    const world = harness();
    const controller = new AudioCaptureController(world.environment);

    controller.chooseFile(new File([new Uint8Array([1])], "katze.png", { type: "image/png" }));

    expect(controller.snapshot().phase).toBe("error");
    expect(controller.snapshot().failure).toBe("file-not-audio");
    expect(controller.snapshot().recording).toBeNull();
    expect(world.createdUrls).toEqual([]);
  });

  it("refuses an empty file rather than previewing silence", () => {
    const world = harness();
    const controller = new AudioCaptureController(world.environment);

    controller.chooseFile(new File([], "leer.mp3", { type: "audio/mpeg" }));

    expect(controller.snapshot().failure).toBe("file-not-audio");
    expect(world.createdUrls).toEqual([]);
  });

  it("keeps a recording the child already has when the next chosen file is refused", async () => {
    const world = harness();
    const controller = new AudioCaptureController(world.environment);
    await recordOnce(controller, world);
    const kept = controller.snapshot().recording;

    controller.chooseFile(new File([new Uint8Array([1])], "katze.png", { type: "image/png" }));

    expect(controller.snapshot().phase).toBe("recorded");
    expect(controller.snapshot().recording).toBe(kept);
    expect(controller.snapshot().failure).toBe("file-not-audio");
    expect(world.revokedUrls).toEqual([]);
  });

  it("says nothing about a microphone refused after it was already released", async () => {
    let refuse: ((error: Error) => void) | null = null;
    const controller = new AudioCaptureController({
      ...harness().environment,
      requestMicrophone: () =>
        new Promise<MediaStreamLike>((_resolve, reject) => {
          refuse = reject;
        }),
    });

    const pending = controller.startRecording();
    controller.release();
    const denied = new Error("too late");
    denied.name = "NotAllowedError";
    refuse!(denied);
    await pending;

    expect(controller.snapshot()).toEqual({ phase: "ready", recording: null, failure: null });
  });

  it("notifies subscribers on every change and stops after unsubscribing", async () => {
    const world = harness();
    const controller = new AudioCaptureController(world.environment);
    let changes = 0;
    const unsubscribe = controller.subscribe(() => {
      changes += 1;
    });

    await recordOnce(controller, world);
    expect(changes).toBeGreaterThan(0);

    const seen = changes;
    unsubscribe();
    controller.discard();
    expect(changes).toBe(seen);
  });

  it("keeps the same snapshot object while nothing changes", () => {
    const controller = new AudioCaptureController(harness().environment);
    expect(controller.snapshot()).toBe(controller.snapshot());
  });

  /**
   * React runs an effect cleanup immediately after the first mount under StrictMode,
   * which this project turns on (next.config.ts). Measured before this was fixed: a
   * one-way teardown left every button on the recording area silently doing nothing,
   * and all six signed-in browser cases timed out waiting for a stop button.
   */
  it("can record again after being released, as a re-mounted component does", async () => {
    const world = harness();
    const controller = new AudioCaptureController(world.environment);

    controller.release();
    await recordOnce(controller, world);

    expect(controller.snapshot().phase).toBe("recorded");
    expect(controller.snapshot().recording?.previewUrl).toBe(world.createdUrls[0]);
  });

  it("gives back a microphone granted after it was already released", async () => {
    let grant: ((stream: MediaStreamLike) => void) | null = null;
    const stream = new FakeStream();
    const world = harness();
    const environment: AudioCaptureEnvironment = {
      ...world.environment,
      requestMicrophone: () =>
        new Promise<MediaStreamLike>((resolve) => {
          grant = resolve;
        }),
    };
    const controller = new AudioCaptureController(environment);

    const pending = controller.startRecording();
    controller.release();
    grant!(stream);
    await pending;

    for (const track of stream.getTracks()) expect(track.stopCalls).toBe(1);
    expect(controller.snapshot().phase).toBe("ready");
    expect(world.recorders).toEqual([]);
  });

  /**
   * The lifecycle cases below all come from one shape: startRecording() keeps whatever
   * the child already recorded, so while they re-record the page still offers "Aufnahme
   * löschen" and the file chooser. Measured on a611fcf, before this was fixed: both of
   * those controls published a state with no stop button while the microphone stayed
   * open, and the next start acquired a second stream the first one's stop() never saw.
   */
  it("gives the microphone back when a running recording is discarded", async () => {
    const world = harness();
    const controller = new AudioCaptureController(world.environment);
    await recordOnce(controller, world);
    const firstUrl = controller.snapshot().recording?.previewUrl;

    await controller.startRecording();
    expect(controller.snapshot().phase).toBe("recording");

    controller.discard();

    expect(controller.snapshot()).toEqual({ phase: "ready", recording: null, failure: null });
    expect(world.streams.length).toBe(2);
    const tracks = world.streams[1]?.getTracks() ?? [];
    expect(tracks.length).toBe(2);
    for (const track of tracks) expect(track.stopCalls).toBe(1);
    expect(world.recorders[1]?.state).toBe("inactive");
    expect(world.revokedUrls).toEqual([firstUrl]);
    // Nothing was previewed out of the recording that was thrown away mid-flight.
    expect(world.createdUrls).toEqual([firstUrl]);

    // And exactly one further microphone is taken for the next recording, not two.
    await recordOnce(controller, world);
    expect(world.streams.length).toBe(3);
    expect(controller.snapshot().phase).toBe("recorded");
  });

  it("gives the microphone back when a chosen file replaces a running recording", async () => {
    const world = harness();
    const controller = new AudioCaptureController(world.environment);
    await recordOnce(controller, world);
    const firstUrl = controller.snapshot().recording?.previewUrl;

    await controller.startRecording();
    const chosen = audioFile("stimme.mp3", "audio/mpeg");
    controller.chooseFile(chosen);

    const state = controller.snapshot();
    expect(state.phase).toBe("recorded");
    expect(state.recording?.source).toBe("file");
    expect(state.recording?.blob).toBe(chosen);
    const tracks = world.streams[1]?.getTracks() ?? [];
    expect(tracks.length).toBe(2);
    for (const track of tracks) expect(track.stopCalls).toBe(1);
    expect(world.recorders[1]?.state).toBe("inactive");
    expect(world.revokedUrls).toEqual([firstUrl]);
    expect(world.createdUrls).toEqual([firstUrl, state.recording?.previewUrl]);
  });

  it("stays in the recording the child can stop when a refused file arrives", async () => {
    const world = harness();
    const controller = new AudioCaptureController(world.environment);
    await controller.startRecording();

    controller.chooseFile(new File([new Uint8Array([1])], "katze.png", { type: "image/png" }));

    // The phase is what the page draws the stop button from: it may not move here.
    expect(controller.snapshot().phase).toBe("recording");
    expect(controller.snapshot().failure).toBe("file-not-audio");
    expect(controller.snapshot().recording).toBeNull();
    expect(world.revokedUrls).toEqual([]);
    expect(world.createdUrls).toEqual([]);
    const tracks = world.streams[0]?.getTracks() ?? [];
    expect(tracks.length).toBe(2);
    for (const track of tracks) expect(track.stopCalls).toBe(0);

    // And the real way out still works, which is the point of keeping the phase.
    controller.stopRecording();
    expect(controller.snapshot().phase).toBe("recorded");
    for (const track of tracks) expect(track.stopCalls).toBe(1);
  });

  it("stays in a pending permission request when a refused file arrives", async () => {
    const world = harness();
    const controller = new AudioCaptureController(world.environment);
    const pending = controller.startRecording();
    expect(controller.snapshot().phase).toBe("requesting-permission");

    controller.chooseFile(new File([new Uint8Array([1])], "katze.png", { type: "image/png" }));

    expect(controller.snapshot().phase).toBe("requesting-permission");
    expect(controller.snapshot().failure).toBe("file-not-audio");

    // The microphone that was already being asked for still arrives and is used.
    await pending;
    expect(controller.snapshot().phase).toBe("recording");
    expect(world.streams.length).toBe(1);
  });

  it("gives back a microphone granted after the child discarded the request", async () => {
    let grant: ((stream: MediaStreamLike) => void) | null = null;
    const granted = new FakeStream();
    const world = harness();
    const controller = new AudioCaptureController({
      ...world.environment,
      requestMicrophone: () =>
        new Promise<MediaStreamLike>((resolve) => {
          grant = resolve;
        }),
    });

    const pending = controller.startRecording();
    controller.discard();
    grant!(granted);
    await pending;

    for (const track of granted.getTracks()) expect(track.stopCalls).toBe(1);
    expect(world.recorders).toEqual([]);
    expect(controller.snapshot()).toEqual({ phase: "ready", recording: null, failure: null });
  });

  it("keeps the chosen file when the microphone it replaced is granted late", async () => {
    let grant: ((stream: MediaStreamLike) => void) | null = null;
    const granted = new FakeStream();
    const world = harness();
    const controller = new AudioCaptureController({
      ...world.environment,
      requestMicrophone: () =>
        new Promise<MediaStreamLike>((resolve) => {
          grant = resolve;
        }),
    });

    const pending = controller.startRecording();
    const chosen = audioFile("stimme.mp3", "audio/mpeg");
    controller.chooseFile(chosen);
    grant!(granted);
    await pending;

    for (const track of granted.getTracks()) expect(track.stopCalls).toBe(1);
    expect(world.recorders).toEqual([]);
    expect(controller.snapshot().phase).toBe("recorded");
    expect(controller.snapshot().recording?.blob).toBe(chosen);
  });

  it("leaves no microphone open and no preview URL alive across a whole session", async () => {
    const world = harness();
    const controller = new AudioCaptureController(world.environment);

    await recordOnce(controller, world);
    await controller.startRecording();
    controller.chooseFile(audioFile());
    await controller.startRecording();
    controller.discard();
    await recordOnce(controller, world);
    controller.release();

    expect(world.streams.length).toBe(4);
    for (const stream of world.streams) {
      const tracks = stream.getTracks();
      expect(tracks.length).toBe(2);
      for (const track of tracks) expect(track.stopCalls).toBe(1);
    }
    // Every URL this session created, revoked once, in the order it stopped being shown.
    expect(world.revokedUrls).toEqual(world.createdUrls);
    expect(new Set(world.revokedUrls).size).toBe(world.revokedUrls.length);
  });

  /**
   * Asked for in the Sourcery review of PR #28: the guarded branch in stopRecording()
   * where the recorder itself throws. It is the one stop path that never reaches
   * onstop, so nothing but this catch hands the microphone back.
   */
  it("releases the microphone when the recorder refuses to stop", async () => {
    const world = harness({ recorders: () => new RefusingRecorder() });
    const controller = new AudioCaptureController(world.environment);
    await controller.startRecording();

    controller.stopRecording();

    expect(controller.snapshot().phase).toBe("error");
    expect(controller.snapshot().failure).toBe("recording-failed");
    expect(controller.snapshot().recording).toBeNull();
    expect(world.createdUrls).toEqual([]);
    const tracks = world.streams[0]?.getTracks() ?? [];
    expect(tracks.length).toBe(2);
    for (const track of tracks) expect(track.stopCalls).toBe(1);
  });
});
