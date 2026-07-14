import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WebviewReadinessProbe,
  READINESS_PROBE_INTERVAL_MS,
  READINESS_PROBE_MAX_ATTEMPTS,
  RELOAD_STUCK_SKIPS,
  type WebviewReadinessProbeDeps,
} from '../../../src/host/sidebar/readiness-probe';

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
    pending = pending.filter((timer) => timer.id !== (id as unknown as number));
  }) as typeof globalThis.clearTimeout;
  const advance = (ms: number) => {
    now += ms;
    for (;;) {
      const due = pending.filter((timer) => timer.fireAt <= now).sort((a, b) => a.fireAt - b.fireAt);
      if (due.length === 0) break;
      const ids = new Set(due.map((timer) => timer.id));
      pending = pending.filter((timer) => !ids.has(timer.id));
      for (const timer of due) timer.fn();
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
  visible: boolean;
  webviewReady: boolean;
  globalDirty: boolean;
  probeCalls: number;
  deliver: boolean;
  reloading: boolean;
  forceClears: number;
  exhausted: number;
}

function stuckState(): FakeState {
  return {
    viewExists: true,
    visible: true,
    webviewReady: false,
    globalDirty: true,
    probeCalls: 0,
    deliver: false,
    reloading: false,
    forceClears: 0,
    exhausted: 0,
  };
}

function makeDeps(state: FakeState, onProbe?: WebviewReadinessProbeDeps['onProbe']): WebviewReadinessProbeDeps {
  return {
    getViewExists: () => state.viewExists,
    getViewVisible: () => state.visible,
    getWebviewReady: () => state.webviewReady,
    getGlobalDirty: () => state.globalDirty,
    isReloading: () => state.reloading,
    onProbe: onProbe ?? (() => {
      state.probeCalls += 1;
      if (state.deliver) state.webviewReady = true;
      return state.deliver;
    }),
    onForceClearReloading: () => {
      state.forceClears += 1;
      state.reloading = false;
    },
    onExhausted: () => { state.exhausted += 1; },
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test('idle lost-ready probe adopts readiness and stops', () => {
  const timers = useFakeTimers();
  try {
    const state = stuckState();
    state.deliver = true;
    const probe = new WebviewReadinessProbe(makeDeps(state));
    probe.arm();
    timers.advance(READINESS_PROBE_INTERVAL_MS);
    assert.equal(state.probeCalls, 1);
    assert.equal(state.webviewReady, true);
    assert.equal(probe.isArmed(), false);
  } finally { timers.restore(); }
});

test('false outcomes self-rearm and exhaust explicitly at the bounded cap', () => {
  const timers = useFakeTimers();
  try {
    const state = stuckState();
    const probe = new WebviewReadinessProbe(makeDeps(state));
    probe.arm();
    for (let i = 0; i <= READINESS_PROBE_MAX_ATTEMPTS; i++) {
      timers.advance(READINESS_PROBE_INTERVAL_MS);
    }
    assert.equal(state.probeCalls, READINESS_PROBE_MAX_ATTEMPTS);
    assert.equal(state.exhausted, 1);
    assert.equal(probe.isArmed(), false);
  } finally { timers.restore(); }
});

test('a reload-start reset after exhaustion begins a fresh bounded episode instead of immediate re-exhaustion', () => {
  const timers = useFakeTimers();
  try {
    const state = stuckState();
    const holder: { probe?: WebviewReadinessProbe } = {};
    const deps = makeDeps(state);
    deps.onExhausted = () => {
      state.exhausted += 1;
      holder.probe?.clear();
      holder.probe?.arm();
    };
    const probe = new WebviewReadinessProbe(deps);
    holder.probe = probe;
    probe.arm();
    for (let i = 0; i <= READINESS_PROBE_MAX_ATTEMPTS; i++) {
      timers.advance(READINESS_PROBE_INTERVAL_MS);
    }
    assert.equal(state.exhausted, 1);
    assert.equal(probe.isArmed(), true);

    timers.advance(READINESS_PROBE_INTERVAL_MS);
    assert.equal(state.exhausted, 1, 'fresh episode probes instead of immediately exhausting again');
    assert.equal(state.probeCalls, READINESS_PROBE_MAX_ATTEMPTS + 1);
  } finally { timers.restore(); }
});

test('rejected probe is classified and self-rearms', async () => {
  const timers = useFakeTimers();
  try {
    const state = stuckState();
    let calls = 0;
    const probe = new WebviewReadinessProbe(makeDeps(state, () => {
      calls += 1;
      return Promise.reject(new Error('raw rejection body'));
    }));
    probe.arm();
    timers.advance(READINESS_PROBE_INTERVAL_MS);
    await settle();
    assert.equal(calls, 1);
    assert.equal(probe.isArmed(), true);
  } finally { timers.restore(); }
});

test('normal ready handshake cancels the armed episode', () => {
  const timers = useFakeTimers();
  try {
    const state = stuckState();
    const probe = new WebviewReadinessProbe(makeDeps(state));
    probe.arm();
    state.webviewReady = true;
    timers.advance(READINESS_PROBE_INTERVAL_MS);
    assert.equal(state.probeCalls, 0);
    assert.equal(probe.isArmed(), false);
  } finally { timers.restore(); }
});

test('arm is idempotent and clear cancels/reset the episode', () => {
  const timers = useFakeTimers();
  try {
    const state = stuckState();
    const probe = new WebviewReadinessProbe(makeDeps(state));
    probe.arm(); probe.arm(); probe.arm();
    assert.equal(timers.pendingCount(), 1);
    probe.clear();
    timers.advance(READINESS_PROBE_INTERVAL_MS);
    assert.equal(state.probeCalls, 0);
  } finally { timers.restore(); }
});

test('reloading skips self-rearm without any reducer event, then force-clear stale reload and probe', () => {
  const timers = useFakeTimers();
  try {
    const state = stuckState();
    state.reloading = true;
    state.deliver = true;
    const probe = new WebviewReadinessProbe(makeDeps(state));
    probe.arm();

    for (let i = 0; i < RELOAD_STUCK_SKIPS - 1; i++) {
      timers.advance(READINESS_PROBE_INTERVAL_MS);
      assert.equal(probe.isArmed(), true, 'each reload skip rearms itself');
    }
    assert.equal(state.probeCalls, 0);
    timers.advance(READINESS_PROBE_INTERVAL_MS);
    assert.equal(state.forceClears, 1);
    assert.equal(state.probeCalls, 1);
    assert.equal(state.webviewReady, true);
  } finally { timers.restore(); }
});

test('hidden view pauses without spending attempts and resumes the same dirty intent', () => {
  const timers = useFakeTimers();
  try {
    const state = stuckState();
    const probe = new WebviewReadinessProbe(makeDeps(state));
    probe.arm();
    state.visible = false;
    probe.setVisible(false);
    timers.advance(READINESS_PROBE_INTERVAL_MS * 10);
    assert.equal(state.probeCalls, 0);

    state.visible = true;
    state.deliver = true;
    probe.setVisible(true);
    timers.advance(READINESS_PROBE_INTERVAL_MS);
    assert.equal(state.probeCalls, 1);
    assert.equal(state.webviewReady, true);
  } finally { timers.restore(); }
});

test('no view or no dirty state stops without probing', () => {
  const timers = useFakeTimers();
  try {
    const state = stuckState();
    state.globalDirty = false;
    const probe = new WebviewReadinessProbe(makeDeps(state));
    probe.arm();
    timers.advance(READINESS_PROBE_INTERVAL_MS);
    assert.equal(state.probeCalls, 0);

    state.globalDirty = true;
    state.viewExists = false;
    probe.arm();
    timers.advance(READINESS_PROBE_INTERVAL_MS);
    assert.equal(state.probeCalls, 0);
  } finally { timers.restore(); }
});
