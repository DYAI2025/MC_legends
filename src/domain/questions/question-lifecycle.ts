/**
 * MCL-35. The vocabulary the question lifecycle is written in, and the only module that
 * decides what a state transition means.
 *
 * It lives in the domain rather than next to the question dataset because three layers
 * need the same words: `src/content` derives which question a child sees, the
 * application ports describe what one close or reopen recorded, and the adapters store
 * it. A union declared in the dataset module would make the persistence layer depend on
 * a content file for its most load-bearing type; a union declared twice would let the
 * two spellings drift apart on the day somebody adds a third state.
 */

/** Whether a question is still taking answers. */
export type QuestionState = "open" | "closed";

/**
 * What one recorded lifecycle change did.
 *
 * Named after the transition rather than after the verb an adult pressed ("close" /
 * "reopen"), because this is what history reads back: an event says what happened, not
 * what somebody intended.
 */
export type QuestionLifecycleAction = "closed" | "reopened";

/**
 * The state each action produces. A total table, so a third action is a compile error
 * here rather than an event whose meaning nothing decides.
 */
const producedState = {
  closed: "closed",
  reopened: "open",
} as const satisfies Record<QuestionLifecycleAction, QuestionState>;

/** The state a question is in after the action was recorded. */
export function stateAfter(action: QuestionLifecycleAction): QuestionState {
  return producedState[action];
}

/**
 * The action that produces a state. The inverse of the table above, written out rather
 * than searched for, so both directions stay total.
 */
const actionProducing = {
  open: "reopened",
  closed: "closed",
} as const satisfies Record<QuestionState, QuestionLifecycleAction>;

/** Which action a caller is asking for when it asks for a target state. */
export function actionProducingState(state: QuestionState): QuestionLifecycleAction {
  return actionProducing[state];
}

/**
 * What the lifecycle store currently says about ONE question.
 *
 * `sequence` is the store's own total order over every recorded event - a strictly
 * increasing number, never a timestamp. It is carried here because rotation needs it:
 * a question that was reopened has to take its turn behind the ones that never left,
 * and "when was it reopened, relative to everything else" is the only fact that can
 * order several reopened questions among themselves. An application clock could not:
 * two events can share a millisecond, and a clock that steps backwards would reorder
 * history.
 */
export type QuestionLifecycleFact = Readonly<{
  state: QuestionState;
  sequence: number;
}>;

/**
 * What the lifecycle store currently says about every question it holds an event for.
 *
 * A question absent from this map has no recorded event, which is NOT the same as being
 * closed: it means the seeded state in the dataset still stands. Absence therefore has
 * to stay representable, which is why this is a partial map and not a total record over
 * the known question ids.
 */
export type QuestionLifecycleSnapshot = Readonly<Record<string, QuestionLifecycleFact>>;
