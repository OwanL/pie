/**
 * Single entry point for dispatching events to the CQRS reducer.
 *
 * `dispatch` is a pure function: `(ArchState, Event) → { state, effects }`.
 * It has no side effects and holds no mutable state. The caller is
 * responsible for:
 * 1. Storing the new state (e.g. `this.archState = result.state`).
 * 2. Executing the returned effects (via `EffectRunner.run()`).
 * 3. Scheduling any render — there is no auto-projection here.
 */

import { reducer } from './reducer';
import type { ArchState } from './arch-state';
import type { Event } from './events';
import type { Effect } from './effects/effects';

/**
 * Dispatch an event through the CQRS reducer.
 *
 * Returns the new state and effects. Pure and deterministic: dispatching the
 * same event against the same state always yields the same result. The caller
 * must store the new state, run the effects, and schedule any render.
 */
export function dispatch(state: ArchState, event: Event): { state: ArchState; effects: Effect[] } {
  return reducer(state, event);
}
