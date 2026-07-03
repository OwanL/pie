import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WebviewReadinessProbe,
  READINESS_PROBE_INTERVAL_MS,
  READINESS_PROBE_MAX_ATTEMPTS,
  RELOAD_STUCK_SKIPS,
  type WebviewReadinessProbeDeps,
} from '../src/host/sidebar/readiness-probe';

/** Virtual clock mirroring state-applied-watchdog.test.ts. */
function useFakeTimers() {
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
      const due = pending.filter((t) => t.fireAt <= now).sort((a, b) => a.fireAt - b.fireAt);
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

interface FakeState {
  viewExists: boolean;
  webviewReady: boolean;
  globalDirty: boolean;
  probeCalls: number;
  deliver: boolean;
  reloading: boolean;
  forceClears: number;
}

function makeDeps(state: FakeState, onProbe?: WebviewReadinessProbeDeps['onProbe']): WebviewReadinessProbeDeps {
  return {
    getViewExists: () => state.viewExists,
    getWebviewReady: () => state.webviewReady,
    getGlobalDirty: () => state.globalDirty,
    isReloading: () => state.reloading,
    onProbe: onProbe ?? (() => {
      state.probeCalls += 1;
      // Mimic the provider: a delivered probe adopts readiness.
      if (state.deliver) {
        state.webviewReady = true;
      }
      return state.deliver;
    }),
    onForceClearReloading: () => {
      state.forceClears += 1;
      state.reloading = false;
    },
  };
}

function stuckState(): FakeState {
  return { viewExists: true, webviewReady: false, globalDirty: true, probeCalls: 0, deliver: false, reloading: false, forceClears: 0 };
}

test('probe adopts readiness when onProbe delivers, and does not re-arm', () => {
  const timers = useFakeTimers();
  try {
    const state = stuckState();
    state.deliver = true;
    const probe = new WebviewReadinessProbe(makeDeps(state));

    probe.arm();
    assert.equal(probe.isArmed(), true);

    timers.advance(READINESS_PROBE_INTERVAL_MS);

    assert.equal(state.probeCalls, 1, 'onProbe fired once');
    assert.equal(state.webviewReady, true, 'readiness adopted on delivery');
    assert.equal(probe.isArmed(), false, 'delivered probe does not re-arm');
  } finally {
    timers.restore();
  }
});

test('probe retries while not delivered, then stops at the attempt cap', () => {
  const timers = useFakeTimers();
  try {
    const state = stuckState(); // deliver stays false — never adopts
    const probe = new WebviewReadinessProbe(makeDeps(state));

    probe.arm();

    for (let i = 0; i < READINESS_PROBE_MAX_ATTEMPTS; i++) {
      timers.advance(READINESS_PROBE_INTERVAL_MS);
    }
    // MAX attempts each called onProbe once and re-armed.
    assert.equal(state.probeCalls, READINESS_PROBE_MAX_ATTEMPTS);
    assert.equal(probe.isArmed(), true, 're-armed after the MAXth failed attempt');

    // The (MAX+1)th tick hits the cap and stops without calling onProbe.
    timers.advance(READINESS_PROBE_INTERVAL_MS);
    assert.equal(state.probeCalls, READINESS_PROBE_MAX_ATTEMPTS, 'no further probe calls once exhausted');
    assert.equal(probe.isArmed(), false, 'exhausted probe stops re-arming');
  } finally {
    timers.restore();
  }
});

test('probe self-cancels when readiness is restored externally (normal ready handshake)', () => {
  const timers = useFakeTimers();
  try {
    const state = stuckState();
    const probe = new WebviewReadinessProbe(makeDeps(state));

    probe.arm();
    // A normal `ready` handshake restores readiness between arming and firing.
    state.webviewReady = true;

    timers.advance(READINESS_PROBE_INTERVAL_MS);

    assert.equal(state.probeCalls, 0, 'tick no-ops once readiness is restored');
    assert.equal(probe.isArmed(), false);
  } finally {
    timers.restore();
  }
});

test('clear cancels a pending probe and resets the attempt counter', () => {
  const timers = useFakeTimers();
  try {
    const state = stuckState();
    const probe = new WebviewReadinessProbe(makeDeps(state));

    probe.arm();
    assert.equal(probe.isArmed(), true);

    probe.clear();
    assert.equal(probe.isArmed(), false);

    timers.advance(READINESS_PROBE_INTERVAL_MS);
    assert.equal(state.probeCalls, 0, 'cleared probe never fires');

    // After clear, a fresh arm starts the attempt counter over.
    probe.arm();
    state.deliver = true;
    timers.advance(READINESS_PROBE_INTERVAL_MS);
    assert.equal(state.probeCalls, 1);
    assert.equal(state.webviewReady, true);
  } finally {
    timers.restore();
  }
});

test('arm is idempotent — a second arm does not schedule a second timer', () => {
  const timers = useFakeTimers();
  try {
    const state = stuckState();
    const probe = new WebviewReadinessProbe(makeDeps(state));

    probe.arm();
    probe.arm();
    probe.arm();
    assert.equal(timers.pendingCount(), 1, 'only one probe timer is ever pending');
  } finally {
    timers.restore();
  }
});

test('probe no-ops when not stuck (nothing dirty / no view)', () => {
  const timers = useFakeTimers();
  try {
    const nothingDirty = stuckState();
    nothingDirty.globalDirty = false;
    const probe = new WebviewReadinessProbe(makeDeps(nothingDirty));

    probe.arm();
    timers.advance(READINESS_PROBE_INTERVAL_MS);
    assert.equal(nothingDirty.probeCalls, 0, 'no probe when nothing is dirty');

    const noView = stuckState();
    noView.viewExists = false;
    const probe2 = new WebviewReadinessProbe(makeDeps(noView));
    probe2.arm();
    timers.advance(READINESS_PROBE_INTERVAL_MS);
    assert.equal(noView.probeCalls, 0, 'no probe when the view is gone');
  } finally {
    timers.restore();
  }
});

test('probe does not fire while a webview reload is in progress', () => {
  const timers = useFakeTimers();
  try {
    const state = stuckState();
    state.reloading = true;
    const probe = new WebviewReadinessProbe(makeDeps(state));

    probe.arm();
    timers.advance(READINESS_PROBE_INTERVAL_MS);
    assert.equal(state.probeCalls, 0, 'no probe while reloading');
    assert.equal(probe.isArmed(), false, 'bail does not re-arm (scheduleState re-arms post-reload)');
    assert.equal(state.forceClears, 0, 'a brief reload is not force-cleared');

    // After the reload settles (reloading=false), re-arming fires normally.
    state.reloading = false;
    state.deliver = true;
    probe.arm();
    timers.advance(READINESS_PROBE_INTERVAL_MS);
    assert.equal(state.probeCalls, 1);
    assert.equal(state.webviewReady, true);
  } finally {
    timers.restore();
  }
});

test('probe force-clears a stuck reloading (reload loop / lost ready) and heals instead of freezing', () => {
  const timers = useFakeTimers();
  try {
    const state = stuckState();
    state.reloading = true; // stuck — a reload loop or lost `ready` never clears it
    state.deliver = true; // the webview is actually alive; postMessage will deliver
    const probe = new WebviewReadinessProbe(makeDeps(state));

    probe.arm();
    // The first (RELOAD_STUCK_SKIPS - 1) ticks bail like a legitimate reload:
    // no probe, no force-clear. `scheduleState` re-arms between ticks during
    // streaming (simulated here by re-arming).
    for (let i = 0; i < RELOAD_STUCK_SKIPS - 1; i++) {
      timers.advance(READINESS_PROBE_INTERVAL_MS);
      probe.arm();
    }
    assert.equal(state.probeCalls, 0, 'no probe during the legitimate-reload bail window');
    assert.equal(state.forceClears, 0, 'no force-clear during the bail window');

    // The RELOAD_STUCK_SKIPS-th tick treats the reload as stale, force-clears
    // it, and probes — healing the stall that would otherwise freeze the
    // webview until the user interrupts (the probe neither heals nor exhausts
    // while reloading is stuck, and the watchdog can't force-reload mid-stream).
    timers.advance(READINESS_PROBE_INTERVAL_MS);
    assert.equal(state.forceClears, 1, 'stuck reloading force-cleared');
    assert.equal(state.reloading, false, 'reloading flag cleared');
    assert.equal(state.probeCalls, 1, 'probe fired after force-clear');
    assert.equal(state.webviewReady, true, 'readiness adopted');
    assert.equal(probe.isArmed(), false, 'healed probe does not re-arm');
  } finally {
    timers.restore();
  }
});
