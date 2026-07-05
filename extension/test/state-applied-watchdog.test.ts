import test from 'node:test';
import assert from 'node:assert/strict';

import {
  StateAppliedWatchdog,
  STATE_APPLIED_RELOAD_LIMIT,
  STATE_APPLIED_RELOAD_WINDOW_MS,
  type StateAppliedWatchdogDeps,
} from '../src/host/sidebar/state-applied-watchdog';

/** No-op deps suitable for exercising the pure throttle/ack logic. */
function fakeDeps(overrides: Partial<StateAppliedWatchdogDeps> = {}): StateAppliedWatchdogDeps {
  return {
    getWebviewReady: () => true,
    getViewVisible: () => true,
    getRunningSessionCount: () => 0,
    getHostInstanceId: () => 'test-instance',
    onResnapshot: () => undefined,
    onForceReload: async () => undefined,
    ...overrides,
  };
}

interface FakeTimers {
  advance: (ms: number) => void;
  pendingCount: () => number;
  restore: () => void;
}

/** Virtual clock mirroring tool-call-close-lifecycle.test.ts. */
function useFakeTimers(): FakeTimers {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;

  type Pending = { fn: () => void; fireAt: number; id: number };
  let now = 0;
  let pending: Pending[] = [];
  let nextId = 1;

  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    const id = nextId++;
    pending.push({ fn, fireAt: now + (ms ?? 0), id });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof globalThis.setTimeout;

  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    pending = pending.filter((t) => t.id !== (id as unknown as number));
  }) as typeof globalThis.clearTimeout;

  const advance = (ms: number) => {
    now += ms;
    for (;;) {
      const due = pending
        .filter((t) => t.fireAt <= now)
        .sort((a, b) => a.fireAt - b.fireAt);
      if (due.length === 0) break;
      const dueIds = new Set(due.map((t) => t.id));
      pending = pending.filter((t) => !dueIds.has(t.id));
      for (const t of due) {
        t.fn();
      }
    }
  };

  return {
    advance,
    pendingCount: () => pending.length,
    restore: () => {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
}

test('shouldThrottleStateAppliedReload allows up to the limit within a 30s window then throttles', () => {
  const watchdog = new StateAppliedWatchdog(fakeDeps());
  const t0 = 1_000_000;

  // First call opens the window and consumes attempt 1 -> allow.
  assert.equal(watchdog.shouldThrottleStateAppliedReload(t0), false);
  // Second call within the window consumes attempt 2 -> allow.
  assert.equal(watchdog.shouldThrottleStateAppliedReload(t0 + 1_000), false);
  // Third call within the window hits the limit -> throttle.
  assert.equal(watchdog.shouldThrottleStateAppliedReload(t0 + 2_000), true);
  // Subsequent calls within the same window keep throttling.
  assert.equal(watchdog.shouldThrottleStateAppliedReload(t0 + 3_000), true);

  assert.equal(STATE_APPLIED_RELOAD_LIMIT, 2, 'guard: test assumes limit of 2');
  assert.equal(STATE_APPLIED_RELOAD_WINDOW_MS, 30_000, 'guard: test assumes a 30s window');
});

test('shouldThrottleStateAppliedReload resets after the rolling window elapses', () => {
  const watchdog = new StateAppliedWatchdog(fakeDeps());
  const t0 = 5_000_000;

  // Burn through the limit inside the first window.
  assert.equal(watchdog.shouldThrottleStateAppliedReload(t0), false);
  assert.equal(watchdog.shouldThrottleStateAppliedReload(t0 + 500), false);
  assert.equal(watchdog.shouldThrottleStateAppliedReload(t0 + 1_000), true);

  // Past the 30s window: the counter resets and reloads are allowed again.
  const afterWindow = t0 + STATE_APPLIED_RELOAD_WINDOW_MS + 1;
  assert.equal(watchdog.shouldThrottleStateAppliedReload(afterWindow), false);
  assert.equal(watchdog.shouldThrottleStateAppliedReload(afterWindow + 100), false);
  assert.equal(watchdog.shouldThrottleStateAppliedReload(afterWindow + 200), true);
});

test('recordStateApplied clears the pending watchdog when ack revision >= pending revision', () => {
  const timers = useFakeTimers();
  try {
    const watchdog = new StateAppliedWatchdog(fakeDeps());

    watchdog.armStateAppliedWatchdog(7);
    assert.equal(timers.pendingCount(), 1, 'arming schedules a timeout timer');
    assert.equal(watchdog.getPendingStateAppliedRevision(), 7);

    // An ack for the armed revision clears the timer and pending state.
    watchdog.recordStateApplied(7);
    assert.equal(timers.pendingCount(), 0, 'matching ack clears the timer');
    assert.equal(watchdog.getPendingStateAppliedRevision(), null);

    // A later ack for a higher revision also clears an armed watchdog.
    watchdog.armStateAppliedWatchdog(12);
    assert.equal(timers.pendingCount(), 1);
    watchdog.recordStateApplied(15);
    assert.equal(timers.pendingCount(), 0);
    assert.equal(watchdog.getPendingStateAppliedRevision(), null);
  } finally {
    timers.restore();
  }
});

test('recordStateApplied does not clear the pending watchdog when ack revision < pending revision', () => {
  const timers = useFakeTimers();
  try {
    const watchdog = new StateAppliedWatchdog(fakeDeps());

    watchdog.armStateAppliedWatchdog(20);
    assert.equal(timers.pendingCount(), 1);

    // A stale ack for an older revision must not clear the armed watchdog.
    watchdog.recordStateApplied(5);
    assert.equal(timers.pendingCount(), 1, 'stale ack keeps the timer armed');
    assert.equal(watchdog.getPendingStateAppliedRevision(), 20);
  } finally {
    timers.restore();
  }
});
// ─── Bounded resnapshot escalation while streaming ────────────────────────
// The watchdog must not suppress a force-reload *indefinitely* while a session
// is running. After RESNAPSHOT_MAX_RETRIES unacked resnapshots it escalates to a
// throttled force-reload even with runningCount > 0, so a hung renderer recovers
// within ~((1 + RESNAPSHOT_MAX_RETRIES) * STATE_APPLIED_TIMEOUT_MS) instead of
// waiting out the whole turn. A slow-but-functional webview that eventually acks
// resets the retry counter and never escalates.

test('resnapshot retries while streaming, then escalates to a force-reload after the budget is exhausted', () => {
  const timers = useFakeTimers();
  try {
    const resnapshots: number[] = [];
    const reloads: number[] = [];
    let nextRevision = 1;
    let watchdog!: StateAppliedWatchdog;
    const deps = fakeDeps({
      getRunningSessionCount: () => 1, // streaming
      onResnapshot: () => {
        // Mirror the real flow: the resnapshot re-posts a fresh revision and
        // re-arms the watchdog for it.
        nextRevision += 1;
        resnapshots.push(nextRevision);
        watchdog.armStateAppliedWatchdog(nextRevision);
      },
      onForceReload: async (revision: number) => {
        reloads.push(revision);
      },
    });
    watchdog = new StateAppliedWatchdog(deps);

    watchdog.armStateAppliedWatchdog(nextRevision); // rev 1
    timers.advance(2_500); // first timeout -> resnapshot #1, re-arm rev 2
    assert.equal(resnapshots.length, 1, 'first timeout resnapshots, does not reload');
    assert.equal(reloads.length, 0);
    assert.equal(watchdog.getPendingStateAppliedRevision(), 2);

    timers.advance(2_500); // resnapshot #2, re-arm rev 3
    assert.equal(resnapshots.length, 2);
    timers.advance(2_500); // resnapshot #3, re-arm rev 4
    assert.equal(resnapshots.length, 3);
    timers.advance(2_500); // resnapshot #4, re-arm rev 5
    assert.equal(resnapshots.length, 4);
    assert.equal(reloads.length, 0, 'resnapshot retries do not reload');

    timers.advance(2_500); // budget exhausted -> escalate to force-reload
    assert.equal(resnapshots.length, 4, 'escalation does not resnapshot again');
    assert.equal(reloads.length, 1, 'escalation triggers exactly one force-reload');
    assert.equal(reloads[0], 5, 'the pending revision at escalation is reloaded');
  } finally {
    timers.restore();
  }
});

test('a mid-stream ack resets the resnapshot retry budget so a slow-but-functional webview never escalates', () => {
  const timers = useFakeTimers();
  try {
    const resnapshots: number[] = [];
    const reloads: number[] = [];
    let nextRevision = 10;
    let watchdog!: StateAppliedWatchdog;
    const deps = fakeDeps({
      getRunningSessionCount: () => 1,
      onResnapshot: () => {
        nextRevision += 1;
        resnapshots.push(nextRevision);
        watchdog.armStateAppliedWatchdog(nextRevision);
      },
      onForceReload: async (revision: number) => {
        reloads.push(revision);
      },
    });
    watchdog = new StateAppliedWatchdog(deps);

    watchdog.armStateAppliedWatchdog(nextRevision); // rev 10
    timers.advance(2_500); // resnapshot #1 -> re-arm rev 11
    timers.advance(2_500); // resnapshot #2 -> re-arm rev 12
    assert.equal(resnapshots.length, 2);

    // The webview finally acknowledges rev 12 (slow but functional).
    watchdog.recordStateApplied(12);
    assert.equal(reloads.length, 0, 'ack prevents escalation');

    // The budget is fully reset; a fresh unacked episode must run the full
    // retry budget before escalating again.
    watchdog.armStateAppliedWatchdog(20);
    timers.advance(2_500); // resnapshot #1 -> re-arm rev 21
    timers.advance(2_500); // resnapshot #2
    timers.advance(2_500); // resnapshot #3
    assert.equal(resnapshots.length, 5, 'fresh episode restarts the retry budget from 0');
    assert.equal(reloads.length, 0);
  } finally {
    timers.restore();
  }
});

test('escalated force-reloads while streaming are throttled to STATE_APPLIED_RELOAD_LIMIT per window', () => {
  const timers = useFakeTimers();
  try {
    const reloads: number[] = [];
    let nextRevision = 100;
    let watchdog!: StateAppliedWatchdog;
    const deps = fakeDeps({
      getRunningSessionCount: () => 1,
      onResnapshot: () => {
        nextRevision += 1;
        watchdog.armStateAppliedWatchdog(nextRevision);
      },
      onForceReload: async (revision: number) => {
        reloads.push(revision);
        // Reload resets the bridge; simulate the post-reload re-arm with a
        // fresh revision and a reset resnapshot budget.
        watchdog.resetResnapshotFlag();
        nextRevision += 1;
        watchdog.armStateAppliedWatchdog(nextRevision);
      },
    });
    watchdog = new StateAppliedWatchdog(deps);

    watchdog.armStateAppliedWatchdog(nextRevision); // rev 100
    // Burn through the resnapshot budget -> first reload.
    for (let i = 0; i < 5; i++) timers.advance(2_500);
    assert.equal(reloads.length, 1, 'first escalation reloads (within the throttle window)');

    // After the reload the webview is still hung: another full budget -> reload.
    // (The throttle window is wall-clock via Date.now(); the test runs in well
    // under 30s of real time, so the second reload is still within the window.)
    for (let i = 0; i < 5; i++) timers.advance(2_500);
    assert.equal(reloads.length, 2, 'second escalation reloads (limit reached)');

    // Third escalation within the same wall-clock window is throttled (the
    // `shouldThrottleStateAppliedReload` limit is STATE_APPLIED_RELOAD_LIMIT=2).
    // The window-reset path itself is covered by the dedicated throttle tests
    // above, which exercise `shouldThrottleStateAppliedReload(now)` directly.
    for (let i = 0; i < 5; i++) timers.advance(2_500);
    assert.equal(reloads.length, 2, 'third escalation within the window is throttled');
  } finally {
    timers.restore();
  }
});
