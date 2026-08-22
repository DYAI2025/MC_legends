import type { QuestionLifecycleSnapshot } from "@/domain/questions/question-lifecycle";
import { createQuestionLifecycleReader } from "@/composition/server";

/**
 * What the child-facing pages know about which questions are open (MCL-35).
 *
 * One helper for both of them, because the DANGEROUS half of this is the failure branch
 * and two copies of it would eventually disagree. The rule it encodes:
 *
 * A lifecycle store that cannot be read does NOT fall back to the seeded dataset. That
 * fallback is the tempting one - the pages keep rendering, nothing looks broken - and it
 * is the reason it is refused: the seed is what the project decided before anybody could
 * change it, so serving it after the store exists means presenting a question as current
 * that an adult may have retired weeks ago, and inviting a child to answer it. A page
 * that says "we cannot tell you right now" is less useful and true; a page that quietly
 * shows stale state is more useful and false.
 *
 * `null` is therefore the honest answer, and every caller renders a child-safe
 * temporary-unavailable state for it with no way to write a new answer.
 */
export type QuestionAvailability = QuestionLifecycleSnapshot | null;

/** The fixed log string, so a real outage is greppable and never carries child text. */
const READ_FAILED = "question lifecycle read failed";

export async function readQuestionSnapshot(): Promise<QuestionAvailability> {
  try {
    return await createQuestionLifecycleReader().snapshot();
  } catch (cause) {
    // Server-side only, and the whole cause: the page answers with a sentence a child can
    // read, and the reason it does stays here where somebody can act on it.
    console.error(READ_FAILED, cause);
    return null;
  }
}
