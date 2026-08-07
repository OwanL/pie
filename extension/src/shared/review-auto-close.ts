import type { ClosureAction } from './protocol/sessions.js';
import { isPendingTabPath } from './tab-behavior.js';

/**
 * Pure host decision logic for explicit V2 closure actions.
 *
 * Review persistence never implies closure. Only pending/retrying
 * `closeReviewed`/`closeSelf` outbox actions are drained. Action IDs are claimed
 * once per host runtime while the CQRS close/persist effects are outstanding;
 * failed attempts release their claims for a later retry.
 */

export interface ReviewAutoCloseInput {
  incoming: ReadonlyArray<{
    path: string;
    closureActions?: readonly ClosureAction[];
  }>;
  openTabPaths: readonly string[];
  runningPaths: readonly string[];
}

export interface ReviewAutoCloseState {
  claimedActionIds: Set<string>;
}

export interface ReviewAutoCloseAttempt {
  sessionPath: string;
  actions: ClosureAction[];
  /** Running closes are tab hides and therefore have no CloseSession effect;
   *  their authoritative completion is the PersistTabs result alone. */
  requiresCloseCompletion: boolean;
}

export interface ReviewAutoCloseResult {
  /** One correlated CQRS close attempt per target path. */
  attempts: ReviewAutoCloseAttempt[];
  next: ReviewAutoCloseState;
}

/** Bounded retry budget for an explicit closure action. After this many
 *  attempts, a still-failing action becomes terminal `failed` rather than
 *  `retrying`, so a persistently-uncloseable target stops being reclaimed on
 *  every list refresh. Crash reclaim is preserved: a crash before the fsynced
 *  terminal append leaves the prior pending/retrying record authoritative, so
 *  the action remains retryable until a durable `failed` is confirmed. */
export const MAX_CLOSURE_ATTEMPTS = 3;

/** A failed attempt that has reached the retry budget becomes terminal. The
 *  argument is the post-increment attempt count (attempts already made). */
export function closureActionExhaustedRetries(attempts: number): boolean {
  return attempts >= MAX_CLOSURE_ATTEMPTS;
}

export const INITIAL_REVIEW_AUTO_CLOSE_STATE: ReviewAutoCloseState = {
  claimedActionIds: new Set(),
};

/** Choose a fresh-start default without racing an explicit active closure.
 * Catalog-absent closure targets can be synthetic summaries, and opening one
 * before the list event drains it would revive a path already being closed. */
export function findStartupSessionToOpen(
  sessions: ReadonlyArray<{ path: string; closureActions?: readonly ClosureAction[] }>,
): string | undefined {
  return sessions.find((session) => !session.closureActions?.some(
    (action) => action.status === 'pending' || action.status === 'retrying',
  ))?.path;
}

export function computeReviewAutoCloseClosures(
  prev: ReviewAutoCloseState,
  input: ReviewAutoCloseInput,
): ReviewAutoCloseResult {
  const claimedActionIds = new Set(prev.claimedActionIds);
  const running = new Set(input.runningPaths);
  const attemptsByPath = new Map<string, ReviewAutoCloseAttempt>();

  for (const summary of input.incoming) {
    if (isPendingTabPath(summary.path)) continue;

    for (const action of summary.closureActions ?? []) {
      if (action.status === 'succeeded' || action.status === 'failed') {
        claimedActionIds.add(action.actionId);
        continue;
      }
      if (claimedActionIds.has(action.actionId)) continue;

      let attempt = attemptsByPath.get(summary.path);
      if (!attempt) {
        attempt = {
          sessionPath: summary.path,
          actions: [],
          requiresCloseCompletion: !running.has(summary.path),
        };
        attemptsByPath.set(summary.path, attempt);
      }
      attempt.actions.push(action);
      claimedActionIds.add(action.actionId);
    }
  }

  return {
    attempts: [...attemptsByPath.values()],
    next: { claimedActionIds },
  };
}
