import { useEffect, useRef, useState } from 'preact/hooks';
import { reconcileOptimisticEcho } from './optimistic-echo';

/**
 * Optimistic intended-selection reconciliation for chip editors whose
 * persistence round-trips asynchronously through host state snapshots (the
 * `selected` prop only updates once the host echo lands). Mirrors the
 * pending-commit echo queue in `number-field.tsx` for numeric commits:
 * edits accumulate from the local intent instead of the possibly stale host
 * prop, so a rapid add → add → remove burst keeps every later intent, while
 * delayed in-order echoes converge and an external (or rejected /
 * re-normalized) echo projects host truth. This is a small value-matched
 * queue, deliberately not a state framework.
 */

/** Ordered element-wise equality for selections. */
export function sameSelection(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

/**
 * Resolve one authoritative echo against locally emitted selections whose
 * echoes have not converged yet, in emission order. The host protocol carries
 * no per-command acknowledgements, so echoes are matched by value only, and
 * snapshot revisions are strictly ordered — echoes are processed in emission
 * order; out-of-order delivery is not imagined here (the revision guard
 * upstream discards stale snapshots).
 *
 * Consume the earliest matching prefix, including coalesced middle echoes.
 * Duplicate values cannot identify a request revision, so later matching
 * intents remain pending until an unambiguous echo or unrelated host truth
 * resolves them (see reconcileOptimisticEcho).
 */
export function reconcileSelectionEcho(
  queue: string[][],
  echo: readonly string[],
): string[][] {
  return reconcileOptimisticEcho(queue, [...echo], sameSelection);
}

export interface IntendedSelection {
  /** Optimistic selection: the newest local edit while echoes converge, then
   *  the authoritative host selection. */
  value: string[];
  /** Apply a user edit; emits the new intended selection to the consumer.
   *  Edits read the previous intent, so they never lose an in-flight intent. */
  update: (next: string[]) => void;
}

/**
 * Optimistic intended-selection buffer for {@link ChipEditor}-based editors.
 * Returns the value to render (chips and duplicate guards read this) and an
 * updater for user edits. Convergence is driven by echoes alone — no timers —
 * so unmount needs no cleanup; an edit whose echo never arrives stays visible
 * as an intent the user can aim again (remove) or that an external snapshot
 * resolves.
 */
export function useIntendedSelection(
  selected: readonly string[],
  onChange: (next: string[]) => void,
): IntendedSelection {
  const [intended, setIntended] = useState<string[]>(() => [...selected]);
  const intendedRef = useRef(intended);
  /** Selections emitted locally whose echo has not converged yet, in emission
   *  order. An echo of an older edit must never overwrite the display a newer
   *  local edit established. */
  const pending = useRef<string[][]>([]);

  useEffect(() => {
    pending.current = reconcileSelectionEcho(pending.current, selected);
    if (pending.current.length > 0) return; // a newer local intent still leads
    if (sameSelection(intendedRef.current, selected)) return;
    const echo = [...selected];
    intendedRef.current = echo;
    setIntended(echo);
  }, [selected]);

  const update = (next: string[]) => {
    if (sameSelection(next, intendedRef.current)) return;
    const emitted = [...next];
    intendedRef.current = emitted;
    setIntended(emitted);
    pending.current = [...pending.current, emitted];
    onChange(emitted);
  };

  return { value: intended, update };
}