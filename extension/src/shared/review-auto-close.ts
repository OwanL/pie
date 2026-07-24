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

export const INITIAL_REVIEW_AUTO_CLOSE_STATE: ReviewAutoCloseState = {
  claimedActionIds: new Set(),
};

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
