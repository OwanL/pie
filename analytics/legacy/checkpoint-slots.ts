import type {
  RunCheckpoint,
} from './run-analytics/types.js';

export type CheckpointSlot = 'a' | 'b';

export interface ResolvedCheckpoint {
  checkpoint: RunCheckpoint | null;
  activeSlot: CheckpointSlot;
}

/**
 * Resolve which checkpoint slot is active given the gen marker and the two
 * parsed slot checkpoints. Centralises the A/B-slot selection so the producer
 * (stats-service persistence) and consumer (run-analytics query) cannot drift
 * on "which slot wins".
 *
 * Selection rules:
 *  - If genValue is 'a' or 'b', prefer that slot; fall back to the other.
 *    activeSlot reflects the slot the returned checkpoint actually came from
 *    (flipped when a gen-preferred slot is missing and the fallback is used).
 *  - Otherwise pick the slot with the higher `.seq`.
 *  - Defaults to { checkpoint: null, activeSlot: 'a' } when none is available.
 */
export function resolveCheckpointSlot(
  genValue: string | null | undefined,
  checkpointA: RunCheckpoint | null,
  checkpointB: RunCheckpoint | null,
): ResolvedCheckpoint {
  const trimmedGen = genValue?.trim();

  if (trimmedGen === 'a' || trimmedGen === 'b') {
    const preferred = trimmedGen === 'a' ? checkpointA : checkpointB;
    const fallback = trimmedGen === 'a' ? checkpointB : checkpointA;
    if (preferred) {
      return { checkpoint: preferred, activeSlot: trimmedGen };
    }
    if (fallback) {
      return { checkpoint: fallback, activeSlot: trimmedGen === 'a' ? 'b' : 'a' };
    }
  }

  if (checkpointA && checkpointB) {
    return checkpointA.seq >= checkpointB.seq
      ? { checkpoint: checkpointA, activeSlot: 'a' }
      : { checkpoint: checkpointB, activeSlot: 'b' };
  }

  if (checkpointA) {
    return { checkpoint: checkpointA, activeSlot: 'a' };
  }

  if (checkpointB) {
    return { checkpoint: checkpointB, activeSlot: 'b' };
  }

  return { checkpoint: null, activeSlot: 'a' };
}
