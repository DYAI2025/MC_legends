import { describe, expect, it } from "vitest";
import {
  QuestionLifecyclePayloadError,
  type QuestionLifecycleLog,
  type QuestionLifecycleReader,
  type QuestionLifecycleRequest,
} from "@/application/questions/question-lifecycle";

/**
 * The behaviour every question lifecycle store must have, run against each adapter
 * (MCL-35).
 *
 * A reusable suite, not a test file: `*-contract.ts` is not collected by vitest, and the
 * two adapter files import it. The point is that the JSONL rollback path and the
 * PostgreSQL table answer the same questions the same way - a rollback that quietly
 * behaves differently is the failure mode this project has already paid for once.
 *
 * Everything here is stated as OBSERVABLE behaviour. There is deliberately no case
 * asserting that the adapters' source contains no UPDATE or DELETE: what matters is that
 * a reopen leaves the close readable and that a stale caller cannot overwrite a newer
 * state, and both are asserted through the ports rather than through a source scan that
 * a rename would satisfy while the behaviour rotted.
 */

export type QuestionLifecycleStore = QuestionLifecycleLog & QuestionLifecycleReader;

export function closeRequest(
  questionId: string,
  overrides: Partial<QuestionLifecycleRequest> = {},
): QuestionLifecycleRequest {
  return {
    questionId,
    nextState: "closed",
    expectedState: "open",
    seededState: "open",
    ...overrides,
  };
}

export function reopenRequest(
  questionId: string,
  overrides: Partial<QuestionLifecycleRequest> = {},
): QuestionLifecycleRequest {
  return {
    questionId,
    nextState: "open",
    expectedState: "closed",
    seededState: "open",
    ...overrides,
  };
}

/** `createStore` must hand back an EMPTY store on every call. */
export function describeQuestionLifecycleContract(
  name: string,
  createStore: () => Promise<QuestionLifecycleStore>,
): void {
  describe(`${name} (question lifecycle contract)`, () => {
    it("says nothing about a question nobody has touched", async () => {
      const store = await createStore();

      expect(await store.snapshot()).toEqual({});
      expect(await store.history()).toEqual([]);
      expect(await store.history("companion-animal")).toEqual([]);
    });

    it("records a close and reports the new state", async () => {
      const store = await createStore();

      const outcome = await store.append(closeRequest("companion-animal"));

      expect(outcome.applied).toBe(true);
      expect(outcome.applied === true && outcome.event.action).toBe("closed");
      expect(outcome.applied === true && outcome.event.previousState).toBe("open");
      expect(outcome.applied === true && outcome.event.nextState).toBe("closed");
      // The first change to a question is revision 0; the sequence is the store's own
      // total order and starts above zero so "no sequence" is never a valid one.
      expect(outcome.applied === true && outcome.event.revision).toBe(0);
      expect(outcome.applied === true && outcome.event.sequence).toBeGreaterThan(0);

      const snapshot = await store.snapshot();
      expect(snapshot["companion-animal"]?.state).toBe("closed");
    });

    it("refuses a second close that still believes the question is open", async () => {
      const store = await createStore();
      await store.append(closeRequest("companion-animal"));

      const outcome = await store.append(closeRequest("companion-animal"));

      expect(outcome.applied).toBe(false);
      expect(outcome.applied === false && outcome.reason).toBe("stale");
      // The state that actually holds, so the caller can show the truth rather than
      // only refuse.
      expect(outcome.applied === false && outcome.currentState).toBe("closed");
      // And nothing was written for the refused attempt.
      expect(await store.history("companion-animal")).toHaveLength(1);
    });

    it("reopens a closed question", async () => {
      const store = await createStore();
      await store.append(closeRequest("companion-animal"));

      const outcome = await store.append(reopenRequest("companion-animal"));

      expect(outcome.applied).toBe(true);
      expect(outcome.applied === true && outcome.event.action).toBe("reopened");
      expect(outcome.applied === true && outcome.event.revision).toBe(1);
      expect((await store.snapshot())["companion-animal"]?.state).toBe("open");
    });

    it("keeps the close readable after the reopen, newest first", async () => {
      const store = await createStore();
      await store.append(closeRequest("companion-animal"));
      await store.append(reopenRequest("companion-animal"));

      const history = await store.history("companion-animal");

      // Two events, not one overwritten row. Reopening a question must never erase the
      // evidence that it was closed - that evidence IS the archive.
      expect(history.map((event) => event.action)).toEqual(["reopened", "closed"]);
      expect(history[0].sequence).toBeGreaterThan(history[1].sequence);
      expect(history[0].revision).toBe(1);
      expect(history[1].revision).toBe(0);
    });

    it("filters history by exact question id, never by prefix", async () => {
      const store = await createStore();
      await store.append(closeRequest("companion"));
      await store.append(closeRequest("companion-animal"));

      const history = await store.history("companion");

      expect(history).toHaveLength(1);
      expect(history[0].questionId).toBe("companion");
      // Both are in the unfiltered history, so the case above is a filter that narrowed
      // rather than a store that only ever held one.
      expect(await store.history()).toHaveLength(2);
    });

    it("orders the whole history newest first across questions", async () => {
      const store = await createStore();
      await store.append(closeRequest("companion-animal"));
      await store.append(closeRequest("druhen-protection"));

      const sequences = (await store.history()).map((event) => event.sequence);

      expect(sequences).toEqual([...sequences].sort((left, right) => right - left));
      expect(new Set(sequences).size).toBe(sequences.length);
    });

    it("refuses a caller whose belief disagrees with the seeded state", async () => {
      const store = await createStore();

      // No event exists, so the seeded state decides. A caller that thinks a
      // seeded-closed question is open is working from something older than the dataset
      // it is looking at.
      const outcome = await store.append(
        reopenRequest("amulet-power", { seededState: "open" }),
      );

      expect(outcome.applied).toBe(false);
      expect(outcome.applied === false && outcome.currentState).toBe("open");
      expect(await store.history()).toEqual([]);
    });

    it("reports the latest state of every question it holds", async () => {
      const store = await createStore();
      await store.append(closeRequest("companion-animal"));
      await store.append(closeRequest("druhen-protection"));
      await store.append(reopenRequest("companion-animal"));

      const snapshot = await store.snapshot();

      expect(snapshot["companion-animal"]?.state).toBe("open");
      expect(snapshot["druhen-protection"]?.state).toBe("closed");
      // The reopened question's sequence is the reopen's, not the close's: rotation uses
      // it to put a returning question behind the ones that never left.
      expect(snapshot["companion-animal"]?.sequence).toBeGreaterThan(
        snapshot["druhen-protection"]?.sequence ?? 0,
      );
    });

    it("lets exactly one of two simultaneous closes through", async () => {
      const store = await createStore();

      // Started without awaiting the first: two adults on two devices, or one adult
      // whose second click landed before the first answered. Both believe the question
      // is open, and both are right at the moment they decide.
      const outcomes = await Promise.all([
        store.append(closeRequest("companion-animal")),
        store.append(closeRequest("companion-animal")),
      ]);

      expect(outcomes.filter((outcome) => outcome.applied)).toHaveLength(1);
      expect(outcomes.filter((outcome) => !outcome.applied)).toHaveLength(1);
      // One event, so the archive says the question was closed once - which is what
      // happened.
      expect(await store.history("companion-animal")).toHaveLength(1);
      expect((await store.snapshot())["companion-animal"]?.state).toBe("closed");
    });

    it("refuses a change that does not change anything", async () => {
      const store = await createStore();

      await expect(
        store.append(closeRequest("companion-animal", { expectedState: "closed" })),
      ).rejects.toBeInstanceOf(QuestionLifecyclePayloadError);
      expect(await store.history()).toEqual([]);
    });

    it("refuses a question id no store could hold", async () => {
      const store = await createStore();

      // Past the 200-character cap migration 0003 spells out. A payload error rather
      // than an outage: retrying it unchanged can never succeed, and reporting it as
      // "the store is down" would invite exactly that.
      await expect(store.append(closeRequest("q".repeat(201)))).rejects.toBeInstanceOf(
        QuestionLifecyclePayloadError,
      );
      await expect(store.append(closeRequest("   "))).rejects.toBeInstanceOf(
        QuestionLifecyclePayloadError,
      );
      expect(await store.history()).toEqual([]);
    });
  });
}
