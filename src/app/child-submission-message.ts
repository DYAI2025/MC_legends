import type {
  DeliveryFailureReason,
  DeliveryOutcome,
} from "@/application/submissions/deliver-submission";

/**
 * What a child reads after one delivery attempt. Kept out of the page component so it
 * can be tested on its own, and written as a total table so a new failure reason is a
 * compile error here instead of silently falling back to one vague sentence.
 *
 * The distinction the reasons carry is the point: "we could not reach the project"
 * invites a retry that can work, "the project could not take this" does not. A single
 * boolean would force one sentence for both and mislead in one of the two cases.
 *
 * No codes, no technical detail, and never a claim of arrival - only the acknowledged
 * status may say that, and it says it through submissionStatusLabel.
 */
const failureMessages = {
  transport:
    "Deine Antwort ist sicher auf diesem Gerät. Wir konnten das Projekt gerade nicht erreichen. Du kannst sie später noch einmal senden.",
  refused:
    "Deine Antwort ist sicher auf diesem Gerät. Das Projekt konnte sie diesmal nicht annehmen.",
  "local-save":
    "Deine Antwort ist sicher auf diesem Gerät. Du kannst sie später noch einmal senden.",
} as const satisfies Record<DeliveryFailureReason, string>;

/**
 * A failure without a reason cannot be described more precisely than "it is here and
 * you can try again", which is exactly the local-save wording.
 */
const unnamedFailureMessage = failureMessages["local-save"];

export function childMessageFor(outcome: DeliveryOutcome): string {
  if (outcome.delivered) {
    return "Deine Antwort ist im Projekt angekommen.";
  }

  return outcome.reason === undefined ? unnamedFailureMessage : failureMessages[outcome.reason];
}
