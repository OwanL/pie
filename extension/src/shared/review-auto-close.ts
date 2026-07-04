import { isPendingTabPath } from './tab-behavior.js';

/**
 * Auto-close-on-done logic for agent session reviews.
 *
 * When the `session_review` tool records a review with `done: true`, the host
 * closes that session's tab — the same action a user takes when closing a tab
 * (which also drops pinned tabs from `pinnedTabPaths`). This module computes
 * *which* open tabs to close from an incoming session-list refresh, so the
 * host-side handler can dispatch `CloseSession` commands for them.
 *
 * Pure + host-state-free so it is unit-testable in isolation. The host
 * (`SessionServiceState`) owns the `ReviewAutoCloseState` and calls this each
 * time the backend emits `session.list.changed`.
 *
 * Design choices:
 *  - **Seed on first call** so a fresh pie start does NOT mass-close tabs that
 *    were already `done` from a prior run, AND a done session reopened later
 *    from the picker is not auto-closed. Only reviews that *transition* to
 *    `done` during this run (and are open, non-running, real tabs) trigger a
 *    close.
 *  - **Remember done non-open sessions**: a done session that is not
 *    currently a tab is recorded so reopening it later does not auto-close.
 *  - **Forget on flip-back**: a session whose latest review is no longer
 *    `done` is removed from the known-done set, so a later `done` transition
 *    closes it again (e.g. the user reopened a done session, the agent
 *    re-evaluated to not-done, then back to done).
 *  - **Skip running sessions while running**: a `done` review on a
 *    still-running session is not closed now and not remembered, so it closes
 *    once it stops running (defensive — the agent should not mark a running
 *    session done).
 *  - **Never close pending tabs**: a tab still being created cannot be closed.
 */

export interface ReviewAutoCloseInput {
  /** Incoming session summaries from the backend's `session.list.changed`. */
  incoming: ReadonlyArray<{ path: string; done?: boolean }>;
  /** Currently-open tab paths (host `openTabPaths`). */
  openTabPaths: readonly string[];
  /** Currently-running session paths (host `runningSessionPaths`). */
  runningPaths: readonly string[];
}

export interface ReviewAutoCloseState {
  /** Session paths already known `done` (seeded or already auto-closed). */
  knownDonePaths: Set<string>;
  /** Whether the first-call seed has happened. */
  initialized: boolean;
}

export interface ReviewAutoCloseResult {
  /** Open-tab session paths to close this call (dispatch `CloseSession`). */
  closures: string[];
  /** Updated state to store for the next call. */
  next: ReviewAutoCloseState;
}

export const INITIAL_REVIEW_AUTO_CLOSE_STATE: ReviewAutoCloseState = {
  knownDonePaths: new Set(),
  initialized: false,
};

/**
 * Compute the open-tab closures for this session-list refresh.
 *
 * Returns `{ closures: [], next: <seeded> }` on the first call — no closes,
 * but the known-done set is seeded with every currently-done open tab so the
 * subsequent "transition to done" detection starts from a correct baseline.
 */
export function computeReviewAutoCloseClosures(
  prev: ReviewAutoCloseState,
  input: ReviewAutoCloseInput,
): ReviewAutoCloseResult {
  const knownDone = new Set(prev.knownDonePaths);

  // Forget sessions whose latest review is no longer done.
  for (const summary of input.incoming) {
    if (summary.done !== true) {
      knownDone.delete(summary.path);
    }
  }

  if (!prev.initialized) {
    // Seed: remember every done session (open or not, running or not) so
    // startup does not mass-close pre-existing done tabs AND a done session
    // reopened later from the picker is not auto-closed.
    for (const summary of input.incoming) {
      if (summary.done === true) {
        knownDone.add(summary.path);
      }
    }
    return { closures: [], next: { knownDonePaths: knownDone, initialized: true } };
  }

  const openTabSet = new Set(input.openTabPaths);
  const runningSet = new Set(input.runningPaths);
  const closures: string[] = [];
  for (const summary of input.incoming) {
    if (summary.done !== true) continue;
    const { path } = summary;
    if (!openTabSet.has(path)) {
      // Done but not an open tab: remember so a later reopen doesn't re-close.
      knownDone.add(path);
      continue;
    }
    // Open tab. Skip running / pending without remembering, so they close
    // once they stop running / become a real tab.
    if (runningSet.has(path)) continue;
    if (isPendingTabPath(path)) continue;
    if (knownDone.has(path)) continue;
    closures.push(path);
    knownDone.add(path);
  }

  return { closures, next: { knownDonePaths: knownDone, initialized: true } };
}