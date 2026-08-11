export type SubmissionId = string;

export type SubmissionStatus = "LOCAL_ONLY" | "SERVER_ACKNOWLEDGED";

export type ServerReceipt = Readonly<{
  receiptId: string;
  receivedAt: string;
}>;

export type TextSubmission = Readonly<{
  id: SubmissionId;
  kind: "text";
  questionId: string;
  originalText: string;
  createdAt: string;
  status: SubmissionStatus;
  profileId?: string;
  /** Only present once the server really acknowledged this submission. */
  receipt?: ServerReceipt;
}>;

export type CreateTextSubmissionInput = Readonly<{
  questionId: string;
  originalText: string;
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
 * The only way to reach SERVER_ACKNOWLEDGED. A real receipt is required, so the UI
 * cannot promote a submission to "Im Projekt angekommen" on its own.
 */
export function acknowledgeSubmission(
  submission: TextSubmission,
  receipt: ServerReceipt,
): TextSubmission {
  if (receipt.receiptId.trim().length === 0) {
    throw new Error("receiptId must not be blank");
  }

  if (receipt.receivedAt.trim().length === 0) {
    throw new Error("receivedAt must not be blank");
  }

  // Validated by trimming, so stored trimmed - padding must not survive into a
  // receipt. The submitted text is the opposite case and is never touched.
  return Object.freeze({
    ...submission,
    status: "SERVER_ACKNOWLEDGED" as const,
    receipt: Object.freeze({
      receiptId: receipt.receiptId.trim(),
      receivedAt: receipt.receivedAt.trim(),
    }),
  });
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
