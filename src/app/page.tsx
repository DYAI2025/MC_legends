import { cookies } from "next/headers";
import { FamilyExperience } from "@/app/family-experience";
import { FAMILY_SESSION_COOKIE } from "@/adapters/http/family-session-cookie";
import { createFamilyAccessGate } from "@/composition/server";
import { readQuestionSnapshot } from "@/app/question-rotation-source";
import { rotateQuestions } from "@/content/open-questions";
import { categoryFilterFromSlug, THEMA_PARAM } from "@/content/avaloria-content";

/**
 * The page is a server component so the family session is verified where the secret
 * lives. The browser is told only whether it may write - never how that was decided,
 * and never with anything it could forge, because the answer is re-derived on the
 * server for every request.
 *
 * This is a rendering decision, not the access boundary. The protected route checks
 * the same session itself, so a client that lies about this flag gains nothing: it
 * would render a form whose every submission is refused with 401.
 */
export default async function HomePage({
  searchParams,
}: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const sessionValue = (await cookies()).get(FAMILY_SESSION_COOKIE)?.value ?? null;
  const check = createFamilyAccessGate().verifySession(sessionValue);

  // MCL-47: which topic is chosen is now part of the address, so it survives opening a
  // tile and coming back - with the browser's back button just as much as with the page's
  // own one. A repeated parameter arrives as an array; only a single value can mean
  // anything, and everything unrecognised falls back to the whole world.
  const themaParam = (await searchParams)[THEMA_PARAM];
  const selectedCategory = categoryFilterFromSlug(
    typeof themaParam === "string" ? themaParam : undefined,
  );

  // MCL-35: which question is being asked is runtime state now, read per request. A
  // store that cannot be read is passed on as `unavailable` rather than falling back to
  // the seeded dataset - see readQuestionSnapshot for why that fallback is refused.
  const snapshot = await readQuestionSnapshot();
  const rotation = snapshot === null ? null : rotateQuestions(snapshot);

  // Only an explicit grant opens the form. An unavailable gate - no access code
  // configured - shows the sign-in panel like any other refusal, so a misconfigured
  // server never presents a writable surface.
  return (
    <FamilyExperience
      familySessionActive={check.outcome === "granted"}
      selectedCategory={selectedCategory}
      questions={
        rotation === null
          ? { availability: "unavailable" }
          : {
              availability: "available",
              activeQuestionId: rotation.active?.id ?? null,
              upcomingQuestionIds: rotation.upcoming.map((question) => question.id),
            }
      }
    />
  );
}
