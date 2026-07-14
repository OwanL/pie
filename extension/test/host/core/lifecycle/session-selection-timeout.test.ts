import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { produce } from 'immer';

import { SessionServiceState } from '../../../../src/host/session-service/state';
import { createInitialArchState } from '../../../../src/host/core/arch-state';
import type { ArchState } from '../../../../src/host/core/arch-state';
import { reducer } from '../../../../src/host/core/reducer';
import type { Event } from '../../../../src/host/core/events';

// ─── Deterministic fake timers for the selection watchdog ───────────────────
//
// SessionServiceState arms its selection-timeout watchdog with the global
// `setTimeout`. Driving that with real wall-clock time makes the tests
// timing-sensitive (the watchdog fires at ~15ms and a `waitFor` poller can
// stretch past its ceiling under load). We stub `setTimeout`/`clearTimeout` on
// the global so `beginSelectionRequest` arms a fake timer we advance manually —
// the watchdog fires (or is cancelled) deterministically with zero real wait.
//
// Manual override (rather than `node:test`'s `mock.timers()`) is required
// because the timer is scheduled from another module (`state.ts`), which the
// built-in MockTimers does not intercept.

type TimerCallback = () => void;
interface FakeTimer {
  id: number;
  fireAt: number;
  callback: TimerCallback;
}

const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;
let fakeClock = 0;
let nextFakeTimerId = 1;
const fakeTimers = new Map<number, FakeTimer>();

function installFakeTimers(): void {
  fakeClock = 0;
  nextFakeTimerId = 1;
  fakeTimers.clear();
  globalThis.setTimeout = ((callback: TimerCallback, ms = 0) => {
    const id = nextFakeTimerId++;
    fakeTimers.set(id, { id, fireAt: fakeClock + ms, callback });
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: unknown) => {
    if (typeof id === 'number') {
      fakeTimers.delete(id);
    }
  }) as unknown as typeof clearTimeout;
}

/** Advance the fake clock, firing every due timer in schedule order. */
function tickFakeTimers(ms: number): void {
  fakeClock += ms;
  // Re-check after each pass: a callback may arm another due timer.
  for (;;) {
    const due = [...fakeTimers.values()]
      .filter((timer) => timer.fireAt <= fakeClock)
      .sort((a, b) => a.fireAt - b.fireAt);
    if (due.length === 0) {
      break;
    }
    for (const timer of due) {
      fakeTimers.delete(timer.id);
      timer.callback();
    }
  }
}

function restoreRealTimers(): void {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}

beforeEach(() => installFakeTimers());
afterEach(() => restoreRealTimers());

function createExtensionContext() {
  return {
    globalState: {
      update: async () => undefined,
    },
    workspaceState: {
      update: async () => undefined,
    },
  } as any;
}

test('selection timeout clears pending tab and surfaces a notice', async () => {
  let archState = createInitialArchState();
  const getArchState = () => archState;
  const dispatchArch = (event: Event) => {
    const result = reducer(archState, event);
    archState = result.state;
  };

  const backend = { request: async () => undefined } as any;
  const context = createExtensionContext();
  let renderCount = 0;
  const state = new SessionServiceState(context, backend, () => {
    renderCount += 1;
  }, getArchState, dispatchArch, 15);

  // Fixed pending path — each test owns a fresh state, so uniqueness isn't needed.
  const pendingPath = '__pending__:selection-timeout';
  archState = produce(archState, (draft) => {
    draft.sessions.sessions.push({
      path: pendingPath,
      name: 'Loading...',
      isPlaceholder: true,
      cwd: '',
      modifiedAt: new Date().toISOString(),
      messageCount: 0,
    });
    if (!draft.sessions.openTabPaths.includes(pendingPath)) {
      draft.sessions.openTabPaths = [...draft.sessions.openTabPaths, pendingPath];
    }
    draft.sessions.activeSessionPath = pendingPath;
  });

  const token = state.beginSelectionRequest(pendingPath, pendingPath, false, true);
  // Advance the fake clock past the watchdog window — the timeout fires
  // synchronously, clearing the pending tab and surfacing the notice.
  tickFakeTimers(20);

  const sessionsState = getArchState().sessions;
  assert.equal(state.getSelectionRequest(token), null);
  assert.equal(sessionsState.openTabPaths.includes(pendingPath), false);
  assert.equal(sessionsState.sessions.some((session) => session.path === pendingPath), false);
  assert.equal(sessionsState.activeSessionPath, null);
  const notice = getArchState().settings.notice;
  assert.equal(typeof notice, 'string');
  assert.ok(
    (notice as string).includes('Timed out waiting to create session'),
    'timeout should surface a notice',
  );
  assert.ok(renderCount > 0, 'timeout should schedule a render');

  state.resetRuntimeState();
});

test('finishing a selection request cancels its timeout watchdog', async () => {
  let archState = createInitialArchState();
  const getArchState = () => archState;
  const dispatchArch = (event: Event) => {
    const result = reducer(archState, event);
    archState = result.state;
  };

  const backend = { request: async () => undefined } as any;
  const context = createExtensionContext();
  let renderCount = 0;
  const state = new SessionServiceState(context, backend, () => {
    renderCount += 1;
  }, getArchState, dispatchArch, 15);

  const token = state.beginSelectionRequest('/workspace/session-a.jsonl');
  state.finishSelectionRequest(token);
  // Advance well past the watchdog window — the cancelled timer must not fire,
  // so no notice is surfaced and no render is scheduled.
  tickFakeTimers(50);

  assert.equal(getArchState().settings.notice, null);
  assert.equal(renderCount, 0);
  assert.equal(state.getSelectionRequest(token), null);

  state.resetRuntimeState();
});

test('a superseded selection timeout cleans up silently without overwriting the current tab notice', () => {
  let archState = createInitialArchState();
  const getArchState = () => archState;
  const dispatchArch = (event: Event) => {
    const result = reducer(archState, event);
    archState = result.state;
  };
  const state = new SessionServiceState(
    createExtensionContext(),
    { request: async () => undefined } as any,
    () => undefined,
    getArchState,
    dispatchArch,
    15,
  );

  const staleToken = state.beginSelectionRequest('/workspace/session-a.jsonl', undefined, true);
  tickFakeTimers(5);
  const currentToken = state.beginSelectionRequest('/workspace/session-b.jsonl', undefined, true);

  // Only the first request has crossed its deadline. It must still be removed
  // so it cannot leak indefinitely, but it no longer owns the global notice.
  tickFakeTimers(11);
  assert.equal(state.getSelectionRequest(staleToken), null);
  assert.notEqual(state.getSelectionRequest(currentToken), null);
  assert.equal(state.isCurrentSelectionToken(currentToken), true);
  assert.equal(getArchState().settings.notice, null);

  // The current request remains entitled to surface its own failure.
  tickFakeTimers(5);
  assert.match(getArchState().settings.notice ?? '', /Timed out waiting to open session/);
  state.resetRuntimeState();
});
