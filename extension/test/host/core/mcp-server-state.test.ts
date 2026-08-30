import test from 'node:test';
import assert from 'node:assert/strict';

import { reducer, initialArchState } from '../../../src/host/core/reducer';
import { selectViewState } from '../../../src/host/core/projection';
import { EffectRunner } from '../../../src/host/core/effect-runner';
import type { Effect } from '../../../src/host/core/effects';
import type { Event } from '../../../src/host/core/events';
import type { McpServerInfo } from '../../../src/shared/protocol';
import { makeEffectRunnerDeps } from '../../helpers/effect-runner-deps';

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

const SERVERS: McpServerInfo[] = [
  { name: 'jira', disabled: false },
  { name: 'echo', disabled: true },
];

test('reducer: McpListRequested emits an McpListRpc effect and marks the list loading', () => {
  const result = reducer(initialArchState, {
    kind: 'Command',
    cmd: { kind: 'McpListRequested', corrId: 'm1' },
  });
  assert.deepEqual(result.effects, [{ kind: 'McpListRpc', corrId: 'm1' }]);
  assert.equal(result.state.settings.mcpServersStatus, 'loading');
});

test('reducer: McpSetServerEnabled emits an McpSetServerRpc effect', () => {
  const result = reducer(initialArchState, {
    kind: 'Command',
    cmd: { kind: 'McpSetServerEnabled', corrId: 'm2', name: 'jira', enabled: false },
  });
  assert.deepEqual(result.effects, [{ kind: 'McpSetServerRpc', corrId: 'm2', name: 'jira', enabled: false }]);
  assert.equal(result.state.settings.mcpServersStatus, 'loading');
  assert.deepEqual(result.state.settings.mcpServers, initialArchState.settings.mcpServers);
});

test('reducer: McpServersUpdated replaces the server list and pending-apply flag', () => {
  const event: Event = {
    kind: 'McpServersUpdated',
    corrId: 'm3',
    ok: true,
    servers: SERVERS,
    pendingApply: true,
  };
  const result = reducer(initialArchState, event);
  assert.deepEqual(result.state.settings.mcpServers, SERVERS);
  assert.equal(result.state.settings.mcpServersStatus, 'ok');
  assert.equal(result.state.settings.mcpPendingApply, true);
  assert.deepEqual(result.effects, []);
});

test('reducer: a later list read preserves pendingApply (a config list read does not reload the adapter)', () => {
  const withPending: typeof initialArchState = {
    ...initialArchState,
    settings: { ...initialArchState.settings, mcpServers: SERVERS, mcpPendingApply: true },
  };
  const result = reducer(withPending, {
    kind: 'McpServersUpdated',
    corrId: 'm4',
    ok: true,
    servers: SERVERS,
  });
  assert.equal(result.state.settings.mcpPendingApply, true, 'the restart-required hint must survive a refresh');
  assert.deepEqual(result.state.settings.mcpServers, SERVERS);
  assert.equal(result.state.settings.mcpServersStatus, 'ok');
});

test('reducer: a failed fetch keeps the cached list and flag and sets the error status', () => {
  const withServers: typeof initialArchState = {
    ...initialArchState,
    settings: { ...initialArchState.settings, mcpServers: SERVERS, mcpPendingApply: true },
  };
  const result = reducer(withServers, {
    kind: 'McpServersUpdated',
    corrId: 'm6',
    ok: false,
    error: 'mcp.list failed',
  });
  assert.equal(result.state.settings.mcpServersStatus, 'error');
  assert.deepEqual(result.state.settings.mcpServers, SERVERS, 'cached rows must stay visible on error');
  assert.equal(result.state.settings.mcpPendingApply, true, 'a failed fetch must not clear the pending-apply flag');
});

test('reducer: session hydration does not mask a failed global server refresh', () => {
  const failed = {
    ...initialArchState,
    settings: { ...initialArchState.settings, mcpServers: SERVERS, mcpServersStatus: 'error' as const },
  };
  const result = reducer(failed, {
    kind: 'McpServersUpdated',
    corrId: 'session-hydration',
    ok: true,
    sessionPath: SESSION,
    sessionOverrides: { jira: true },
  });
  assert.equal(result.state.settings.mcpServersStatus, 'error', 'hydration-only success cannot claim global discovery recovered');
  assert.deepEqual(result.state.settings.mcpSessionOverridesBySession[SESSION], { jira: true });
});

test('reducer: backend ready clears pendingApply (the restart the hint promises)', () => {
  const withPending: typeof initialArchState = {
    ...initialArchState,
    settings: { ...initialArchState.settings, mcpServers: SERVERS, mcpPendingApply: true },
  };
  const result = reducer(withPending, {
    kind: 'BackendReadyChanged',
    ready: true,
  });
  assert.equal(result.state.settings.mcpPendingApply, false);
  assert.deepEqual(result.state.settings.mcpServers, SERVERS, 'the cached list survives the restart');

  const duplicateReady = reducer({
    ...withPending,
    settings: { ...withPending.settings, backendReady: true },
  }, { kind: 'BackendReadyChanged', ready: true });
  assert.equal(duplicateReady.state.settings.mcpPendingApply, true, 'duplicate ready events must not clear a newer toggle');
});

test('projection: mcpServers, mcpServersStatus and mcpPendingApply reach the ViewState snapshot', () => {
  const state = {
    ...initialArchState,
    settings: { ...initialArchState.settings, mcpServers: SERVERS, mcpServersStatus: 'error' as const, mcpPendingApply: true },
  };
  const view = selectViewState(state);
  assert.deepEqual(view.mcpServers, SERVERS);
  assert.equal(view.mcpServersStatus, 'error');
  assert.equal(view.mcpPendingApply, true);
});

test('EffectRunner McpListRpc fetches the list and dispatches McpServersUpdated without touching pendingApply', async () => {
  const dispatched: Event[] = [];
  const { deps } = makeEffectRunnerDeps({ dispatchEvent: (e) => dispatched.push(e) });
  const runner = new EffectRunner(deps);
  runner.run({ kind: 'McpListRpc', corrId: 'e1' } as Effect);
  await settle();

  const updated = dispatched.find((e) => e.kind === 'McpServersUpdated');
  assert.ok(updated, 'McpServersUpdated must be dispatched');
  assert.equal(updated.corrId, 'e1');
  assert.equal(updated.ok, true);
  assert.deepEqual(updated.servers, []);
  assert.equal(updated.pendingApply, undefined, 'a list read must not carry a pendingApply value');
});

test('EffectRunner McpListRpc dispatches ok:false on failure', async () => {
  const dispatched: Event[] = [];
  const { deps } = makeEffectRunnerDeps({
    dispatchEvent: (e) => dispatched.push(e),
    serviceOverrides: {
      async mcpList() {
        throw new Error('boom');
      },
    },
  });
  const runner = new EffectRunner(deps);
  runner.run({ kind: 'McpListRpc', corrId: 'e1b' } as Effect);
  await settle();

  const updated = dispatched.find((e) => e.kind === 'McpServersUpdated');
  assert.ok(updated, 'McpServersUpdated must be dispatched');
  assert.equal(updated.ok, false);
  assert.match(updated.error ?? '', /boom/);
});

test('EffectRunner McpListRpc is not blocked by an unrelated pending preference write', async () => {
  const dispatched: Event[] = [];
  let listCalls = 0;
  const { deps } = makeEffectRunnerDeps({
    dispatchEvent: (e) => dispatched.push(e),
    serviceOverrides: {
      async setPrefs() {
        await new Promise<void>(() => {});
      },
      async mcpList() {
        listCalls += 1;
        return { servers: SERVERS };
      },
    },
  });
  const runner = new EffectRunner(deps);
  runner.run({ kind: 'SetPrefsRpc', corrId: 'slow-pref', prefs: { hideRunStatus: true } } as Effect);
  runner.run({ kind: 'McpListRpc', corrId: 'independent-list' } as Effect);
  await settle();

  assert.equal(listCalls, 1);
  const updated = dispatched.find((e) => e.kind === 'McpServersUpdated');
  assert.ok(updated && updated.kind === 'McpServersUpdated');
  assert.equal(updated.corrId, 'independent-list');
  assert.equal(updated.ok, true);
});

test('EffectRunner McpListRpc is not blocked by a pending session worker recycle', async () => {
  const dispatched: Event[] = [];
  let sessionMutationCalls = 0;
  let listCalls = 0;
  let releaseMutation!: () => void;
  const mutationBlocked = new Promise<void>((resolve) => { releaseMutation = resolve; });
  let sessionTail = Promise.resolve();
  const { deps } = makeEffectRunnerDeps({
    dispatchEvent: (e) => dispatched.push(e),
    queues: {
      async enqueueLifecycle<T>(task: () => Promise<T>): Promise<T> {
        return await task();
      },
      enqueueSessionOperation<T>(_sessionPath: string, task: () => Promise<T>): Promise<T> {
        const result = sessionTail.then(task);
        sessionTail = result.then(() => undefined, () => undefined);
        return result;
      },
    },
    serviceOverrides: {
      async mcpSetSessionServerEnabled() {
        sessionMutationCalls += 1;
        await mutationBlocked;
        return { recycled: false, overrides: { jira: true } };
      },
      async mcpList(sessionPath?: string) {
        listCalls += 1;
        return { servers: SERVERS, ...(sessionPath ? { sessionOverrides: { jira: true } } : {}) };
      },
    },
  });
  const runner = new EffectRunner(deps);
  runner.run({ kind: 'McpSetSessionServerRpc', corrId: 'slow-recycle', sessionPath: 's1', overrides: { jira: true }, recycle: true } as Effect);
  runner.run({ kind: 'McpListRpc', corrId: 'menu-open', sessionPath: 's1' } as Effect);
  await settle();

  assert.equal(sessionMutationCalls, 1, 'the session mutation should be in flight');
  assert.equal(listCalls, 1, 'opening the menu must start global discovery without waiting for worker recycle');
  const updated = dispatched.find((e) => e.kind === 'McpServersUpdated' && e.corrId === 'menu-open');
  assert.ok(updated && updated.kind === 'McpServersUpdated');
  assert.equal(updated.ok, true);
  assert.deepEqual(updated.servers, SERVERS);

  releaseMutation();
  await settle();
  assert.equal(listCalls, 2, 'session hydration runs after the queued mutation settles');
  const mutationIndex = dispatched.findIndex((e) => e.kind === 'McpSessionServersUpdated' && e.corrId === 'slow-recycle');
  const hydrationIndex = dispatched.findIndex((e) => e.kind === 'McpServersUpdated' && e.corrId === 'menu-open' && e.sessionPath === 's1');
  assert.ok(mutationIndex >= 0 && hydrationIndex > mutationIndex, 'hydration must not race ahead of the session write');
});

test('EffectRunner McpSetServerRpc surfaces changed as pendingApply', async () => {
  const dispatched: Event[] = [];
  const { deps } = makeEffectRunnerDeps({
    dispatchEvent: (e) => dispatched.push(e),
    serviceOverrides: {
      async mcpSetServerEnabled() {
        return { servers: SERVERS, changed: true };
      },
    },
  });
  const runner = new EffectRunner(deps);
  runner.run({ kind: 'McpSetServerRpc', corrId: 'e2', name: 'jira', enabled: false } as Effect);
  await settle();

  const updated = dispatched.find((e) => e.kind === 'McpServersUpdated');
  assert.ok(updated, 'McpServersUpdated must be dispatched');
  assert.equal(updated.corrId, 'e2');
  assert.equal(updated.ok, true);
  assert.deepEqual(updated.servers, SERVERS);
  assert.equal(updated.pendingApply, true);
});

test('EffectRunner McpSetServerRpc leaves pendingApply unset on a no-op toggle', async () => {
  const dispatched: Event[] = [];
  const { deps } = makeEffectRunnerDeps({
    dispatchEvent: (e) => dispatched.push(e),
    serviceOverrides: {
      async mcpSetServerEnabled() {
        return { servers: SERVERS, changed: false };
      },
    },
  });
  const runner = new EffectRunner(deps);
  runner.run({ kind: 'McpSetServerRpc', corrId: 'e2b', name: 'jira', enabled: false } as Effect);
  await settle();

  const updated = dispatched.find((e) => e.kind === 'McpServersUpdated');
  assert.ok(updated, 'McpServersUpdated must be dispatched');
  assert.equal(updated.ok, true);
  assert.equal(updated.pendingApply, undefined, 'a no-op toggle must not clear a pending flag');
});

// ─── Session-scoped server toggles ───────────────────────────────────────────

const SESSION = 's1';

test('reducer: McpSetServerEnabledForSession for an idle session recycles the worker and seeds overrides', () => {
  const result = reducer(initialArchState, {
    kind: 'Command',
    cmd: { kind: 'McpSetServerEnabledForSession', corrId: 'm10', sessionPath: SESSION, name: 'jira', enabled: false },
  });
  const effect = result.effects[0];
  assert.equal(effect?.kind, 'McpSetSessionServerRpc');
  assert.equal((effect as Extract<Effect, { kind: 'McpSetSessionServerRpc' }>).recycle, true);
  assert.deepEqual((effect as Extract<Effect, { kind: 'McpSetSessionServerRpc' }>).overrides, { jira: true });
  assert.equal(result.state.settings.mcpSessionOverridesBySession[SESSION]?.jira, true);
  assert.equal(result.state.settings.mcpPendingApplyBySession[SESSION], false);
});

test('reducer: McpSetServerEnabledForSession for a busy session keeps pending semantics', () => {
  const busy = {
    ...initialArchState,
    sessions: { ...initialArchState.sessions, runningSessionPaths: [SESSION] },
  };
  const result = reducer(busy, {
    kind: 'Command',
    cmd: { kind: 'McpSetServerEnabledForSession', corrId: 'm11', sessionPath: SESSION, name: 'jira', enabled: false },
  });
  const effect = result.effects[0] as Extract<Effect, { kind: 'McpSetSessionServerRpc' }>;
  assert.equal(effect.recycle, false, 'a running session must not ask for a worker recycle');
  assert.deepEqual(effect.overrides, { jira: true });
});

test('reducer: a second toggle merges into the session override set', () => {
  const seeded = reducer(initialArchState, {
    kind: 'Command',
    cmd: { kind: 'McpSetServerEnabledForSession', corrId: 'm12', sessionPath: SESSION, name: 'jira', enabled: false },
  });
  const result = reducer(seeded.state, {
    kind: 'Command',
    cmd: { kind: 'McpSetServerEnabledForSession', corrId: 'm13', sessionPath: SESSION, name: 'echo', enabled: true },
  });
  const effect = result.effects[0] as Extract<Effect, { kind: 'McpSetSessionServerRpc' }>;
  assert.deepEqual(effect.overrides, { jira: true, echo: false });
});

test('reducer: McpSessionServersUpdated applies the authoritative set and pending flag', () => {
  const result = reducer(initialArchState, {
    kind: 'McpSessionServersUpdated',
    corrId: 'm14',
    sessionPath: SESSION,
    ok: true,
    overrides: { jira: true },
    recycled: false,
  });
  assert.deepEqual(result.state.settings.mcpSessionOverridesBySession[SESSION], { jira: true });
  assert.equal(result.state.settings.mcpPendingApplyBySession[SESSION], true, 'a refused recycle keeps the pending hint');

  const applied = reducer(result.state, {
    kind: 'McpSessionServersUpdated',
    corrId: 'm15',
    sessionPath: SESSION,
    ok: true,
    overrides: { jira: true },
    recycled: true,
  });
  assert.equal(applied.state.settings.mcpPendingApplyBySession[SESSION], false, 'a successful recycle clears the pending hint');
});

test('reducer: a successful recycle retry is driven by the next idle transition (BusyChanged)', () => {
  // Toggle while busy → the overrides exist, but the recycle was refused.
  const busy = {
    ...initialArchState,
    sessions: { ...initialArchState.sessions, runningSessionPaths: [SESSION] },
  };
  const toggled = reducer(busy, {
    kind: 'Command',
    cmd: { kind: 'McpSetServerEnabledForSession', corrId: 'm15', sessionPath: SESSION, name: 'jira', enabled: false },
  });
  const refused = reducer(toggled.state, {
    kind: 'McpSessionServersUpdated',
    corrId: 'm15',
    sessionPath: SESSION,
    ok: true,
    overrides: { jira: true },
    recycled: false,
  });
  assert.equal(refused.state.settings.mcpPendingApplyBySession[SESSION], true);

  const idle = reducer(refused.state, {
    kind: 'BusyChanged',
    sessionPath: SESSION,
    running: false,
  });
  const retry = idle.effects.find((e) => e.kind === 'McpSetSessionServerRpc') as Extract<Effect, { kind: 'McpSetSessionServerRpc' }> | undefined;
  assert.ok(retry, 'the idle transition must re-attempt the recycle');
  assert.equal(retry.recycle, true);
  assert.deepEqual(retry.overrides, { jira: true });
});

test('reducer: backend-ready transition clears session pending hints too', () => {
  const withPending = reducer(initialArchState, {
    kind: 'McpSessionServersUpdated',
    corrId: 'm16',
    sessionPath: SESSION,
    ok: true,
    overrides: { jira: true },
    recycled: false,
  }).state;
  assert.equal(withPending.settings.mcpPendingApplyBySession[SESSION], true);

  const result = reducer({ ...withPending }, { kind: 'BackendReadyChanged', ready: true });
  assert.deepEqual(result.state.settings.mcpPendingApplyBySession, {},
    'a backend restart re-reads config per worker, so no session hint survives');
});

test('reducer: McpListRequested hydrates the active session overrides (sessionPath in effect)', () => {
  const withActive = {
    ...initialArchState,
    sessions: { ...initialArchState.sessions, activeSessionPath: SESSION },
  };
  const result = reducer(withActive, {
    kind: 'Command',
    cmd: { kind: 'McpListRequested', corrId: 'm16' },
  });
  const effect = result.effects[0] as Extract<Effect, { kind: 'McpListRpc' }>;
  assert.equal(effect.sessionPath, SESSION, 'list reads hydrate the active session override set');
});

test('reducer: McpServersUpdated session hydration lands in the per-session map', () => {
  const withActive = {
    ...initialArchState,
    sessions: { ...initialArchState.sessions, activeSessionPath: SESSION },
  };
  const result = reducer(withActive, {
    kind: 'McpServersUpdated',
    corrId: 'm17',
    ok: true,
    servers: SERVERS,
    sessionPath: SESSION,
    sessionOverrides: { jira: false },
  });
  assert.deepEqual(result.state.settings.mcpSessionOverridesBySession[SESSION], { jira: false });
});

test('projection: mcpSessionServers merges global state with active-session overrides', () => {
  const state = {
    ...initialArchState,
    sessions: { ...initialArchState.sessions, activeSessionPath: SESSION },
    settings: {
      ...initialArchState.settings,
      mcpServers: SERVERS,
      mcpSessionOverridesBySession: { [SESSION]: { jira: true } },
      mcpPendingApplyBySession: { [SESSION]: true },
    },
  };
  const view = selectViewState(state);
  // Session toggle hides jira further; echo stays globally disabled.
  assert.deepEqual(view.mcpSessionServers, [
    { name: 'jira', disabled: true },
    { name: 'echo', disabled: true },
  ]);
  assert.equal(view.mcpSessionPendingApply, true);
});

test('EffectRunner McpListRpc hydrates session overrides when a sessionPath is given', async () => {
  const dispatched: Event[] = [];
  const { deps } = makeEffectRunnerDeps({
    dispatchEvent: (e) => dispatched.push(e),
    serviceOverrides: {
      async mcpList(sessionPath?: string) {
        return { servers: SERVERS, ...(sessionPath ? { sessionOverrides: { jira: true } } : {}) };
      },
    },
  });
  const runner = new EffectRunner(deps);
  runner.run({ kind: 'McpListRpc', corrId: 'e2', sessionPath: SESSION } as Effect);
  await settle();

  const updated = dispatched.find((e) => e.kind === 'McpServersUpdated');
  assert.ok(updated && updated.kind === 'McpServersUpdated');
  assert.equal(updated.sessionPath, SESSION);
  assert.deepEqual(updated.sessionOverrides, { jira: true });
});

test('EffectRunner McpSetSessionServerRpc dispatches the recycle outcome', async () => {
  const dispatched: Event[] = [];
  const { deps } = makeEffectRunnerDeps({
    dispatchEvent: (e) => dispatched.push(e),
    serviceOverrides: {
      async mcpSetSessionServerEnabled() {
        return { recycled: true, overrides: { jira: true } };
      },
    },
  });
  const runner = new EffectRunner(deps);
  runner.run({ kind: 'McpSetSessionServerRpc', corrId: 'e3', sessionPath: SESSION, overrides: { jira: true }, recycle: true } as Effect);
  await settle();

  const updated = dispatched.find((e) => e.kind === 'McpSessionServersUpdated');
  assert.ok(updated && updated.kind === 'McpSessionServersUpdated');
  assert.equal(updated.recycled, true);
  assert.equal(updated.sessionPath, SESSION);
  assert.deepEqual(updated.overrides, { jira: true });
});
