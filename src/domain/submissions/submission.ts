export type SubmissionId = string;

export type SubmissionStatus = "LOCAL_ONLY" | "SERVER_ACKNOWLEDGED";

export type TextSubmission = Readonly<{
  id: SubmissionId;
  kind: "text";
  questionId: string;
  originalText: string;
  createdAt: string;
  status: SubmissionStatus;
  profileId?: string;
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

export function submissionStatusLabel(status: SubmissionStatus): string {
  switch (status) {
    case "LOCAL_ONLY":
      return "Nur auf diesem Ger\u00e4t gespeichert";
    case "SERVER_ACKNOWLEDGED":
      return "Im Projekt angekommen";
  }
}
