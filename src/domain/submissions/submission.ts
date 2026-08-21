import type { AudioArtifact } from "@/domain/media/audio-artifact";

export type SubmissionId = string;

export type SubmissionStatus = "LOCAL_ONLY" | "SERVER_ACKNOWLEDGED";

/**
 * Which kind of answer a child gave.
 *
 * A discriminant, not a label: the two kinds carry genuinely different payloads - words in
 * one case, an artifact reference in the other - and MCL-49 requires that a stored audio is
 * never confused for text nor an empty text for a missing recording. Naming the union here
 * makes every `switch` over it exhaustive by compilation.
 */
export type SubmissionKind = "text" | "audio";

export type ServerReceipt = Readonly<{
  receiptId: string;
  receivedAt: string;
}>;

/** Everything both kinds share. Never used on its own - only through the union below. */
type SubmissionBase = Readonly<{
  id: SubmissionId;
  questionId: string;
  createdAt: string;
  status: SubmissionStatus;
  profileId?: string;
  /** Only present once the server really acknowledged this submission. */
  receipt?: ServerReceipt;
}>;

export type TextSubmission = SubmissionBase &
  Readonly<{
    kind: "text";
    originalText: string;
  }>;

/**
 * An answer the child spoke (MCL-30 / MCL-49).
 *
 * Carries the artifact *metadata*, never the bytes. The recording itself lives in the
 * private file store, and a domain type that could hold either would make it possible to
 * pass a megabyte of audio into a database row by accident. `audio.objectKey` is the single
 * reference between the two halves.
 *
 * There is deliberately no `originalText` here, not even an optional one. An audio answer
 * has no text, and a transcript - when MCL-54 adds one - is a *derived* artifact that
 * AGENTS.md requires to stay a separate representation. An optional field on this type is
 * exactly where a transcript would eventually be written and then read as if a child had
 * typed it.
 */
export type AudioSubmission = SubmissionBase &
  Readonly<{
    kind: "audio";
    audio: AudioArtifact;
  }>;

export type Submission = TextSubmission | AudioSubmission;

export type CreateTextSubmissionInput = Readonly<{
  questionId: string;
  originalText: string;
  profileId?: string;
}>;

export type CreateAudioSubmissionInput = Readonly<{
  questionId: string;
  audio: AudioArtifact;
  profileId?: string;
}>;

export type SubmissionFactoryDependencies = Readonly<{
  createId: () => string;
  now: () => Date;
}>;

export function createTextSubmission(
  input: CreateTextSubmissionInput,
  dependencies: SubmissionFactoryDependencies,
): TextSubmission {
  if (input.questionId.trim().length === 0) {
    throw new Error("questionId must not be blank");
  }

  if (input.originalText.trim().length === 0) {
    throw new Error("originalText must not be blank");
  }

  const id = dependencies.createId();
  if (id.trim().length === 0) {
    throw new Error("generated submission id must not be blank");
  }

  return Object.freeze({
    id,
    kind: "text" as const,
    questionId: input.questionId,
    originalText: input.originalText,
    createdAt: dependencies.now().toISOString(),
    status: "LOCAL_ONLY" as const,
    ...(input.profileId ? { profileId: input.profileId } : {}),
  });
}

/**
 * An answer the child recorded rather than typed.
 *
 * Takes an already-described `AudioArtifact` instead of raw bytes or a client filename:
 * by the time a submission exists, the hashing, the allowlist check and the object-key
 * derivation have all happened, and none of them can be skipped by calling this directly.
 */
export function createAudioSubmission(
  input: CreateAudioSubmissionInput,
  dependencies: SubmissionFactoryDependencies,
): AudioSubmission {
  if (input.questionId.trim().length === 0) {
    throw new Error("questionId must not be blank");
  }

  const id = dependencies.createId();
  if (id.trim().length === 0) {
    throw new Error("generated submission id must not be blank");
  }

  return Object.freeze({
    id,
    kind: "audio" as const,
    questionId: input.questionId,
    audio: input.audio,
    createdAt: dependencies.now().toISOString(),
    status: "LOCAL_ONLY" as const,
    ...(input.profileId ? { profileId: input.profileId } : {}),
  });
}

/**
 * The only way to reach SERVER_ACKNOWLEDGED. A real receipt is required, so the UI
 * cannot promote a submission to "Im Projekt angekommen" on its own.
 *
 * Generic over the kind rather than one function per kind, and rather than one taking the
 * union: acknowledging must not be able to change what kind of answer something is, and a
 * signature returning `Submission` would let a caller assign an acknowledged audio answer
 * into a text-shaped slot. The type parameter carries the kind straight through.
 */
export function acknowledgeSubmission<TSubmission extends Submission>(
  submission: TSubmission,
  receipt: ServerReceipt,
): TSubmission {
  if (receipt.receiptId.trim().length === 0) {
    throw new Error("receiptId must not be blank");
  }

  if (receipt.receivedAt.trim().length === 0) {
    throw new Error("receivedAt must not be blank");
  }

  // Validated by trimming, so stored trimmed - padding must not survive into a
  // receipt. The submitted text is the opposite case and is never touched.
  //
  // The cast is the one TypeScript cannot discharge on its own: spreading a value of an
  // unresolved type parameter widens to an index signature, so tsc cannot see that the
  // result is still a TSubmission. It is, and narrowly so - every field of `submission`
  // is carried over unchanged and exactly two are overwritten, both declared on
  // SubmissionBase with these very types. Nothing here reads or invents a `kind`, which
  // is the property that makes an acknowledged audio answer still an audio answer.
  //
  // Unlike the casts this codebase refuses, this one makes no claim about data from
  // outside the process: the object is built here, from a value the caller already typed.
  return Object.freeze({
    ...submission,
    status: "SERVER_ACKNOWLEDGED" as const,
    receipt: Object.freeze({
      receiptId: receipt.receiptId.trim(),
      receivedAt: receipt.receivedAt.trim(),
    }),
  }) as TSubmission;
}

/**
 * Whether the project itself confirmed it holds this submission. The child view has
 * to branch on that - arrived wording versus a retry button - and only this module is
 * allowed to name the acknowledged status, so the branch is answered here rather than
 * by a string comparison somewhere in the UI.
 */
export function hasArrivedInProject(status: SubmissionStatus): boolean {
  switch (status) {
    case "LOCAL_ONLY":
      return false;
    case "SERVER_ACKNOWLEDGED":
      return true;
  }
}

export function submissionStatusLabel(status: SubmissionStatus): string {
  switch (status) {
    case "LOCAL_ONLY":
      return "Nur auf diesem Ger\u00e4t gespeichert";
    case "SERVER_ACKNOWLEDGED":
      return "Im Projekt angekommen";
  }
}
