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
