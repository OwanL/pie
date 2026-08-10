import test from 'node:test';
import assert from 'node:assert/strict';

import { NOOP_RUN_OBSERVER } from '../../../../src/host/stats-service';
import { createInitialArchState } from '../../../../src/host/core/arch-state';
import type { ArchState } from '../../../../src/host/core/arch-state';
import { SessionServiceState } from '../../../../src/host/session-service/state';
import { SessionTabActions } from '../../../../src/host/session-service/tab-actions';
import { reducer } from '../../../../src/host/core/reducer';
import { EffectRunner, type EffectRunnerDeps } from '../../../../src/host/core/effect-runner';
import type { Event, EffectResultEvent } from '../../../../src/host/core/events';
import { makeEffectRunnerDeps } from '../../../helpers/effect-runner-deps';

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

async function flushMicrotasks(turns = 1): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await Promise.resolve();
  }
}

async function waitFor(predicate: () => boolean, attempts = 20): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    await flushMicrotasks(3);
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail('Timed out waiting for predicate to become true.');
}

test('openSession selects an already-open hydrated tab without a backend lifecycle effect', () => {
  const sessionA = '/workspace/session-a.jsonl';
  const sessionB = '/workspace/session-b.jsonl';
  let archState = createInitialArchState();
  archState = {
    ...archState,
    sessions: {
      ...archState.sessions,
      sessions: [
        { path: sessionA, name: 'A', cwd: '/workspace', modifiedAt: '2026-01-01T00:00:00.000Z', messageCount: 1 },
        { path: sessionB, name: 'B', cwd: '/workspace', modifiedAt: '2026-01-01T00:00:00.000Z', messageCount: 1 },
      ],
      openTabPaths: [sessionA, sessionB],
      activeSessionPath: sessionA,
    },
    transcript: {
      ...archState.transcript,
      bySession: {
        [sessionB]: [{ id: 'b-1', role: 'user', createdAt: '2026-01-01T00:00:00.000Z', markdown: 'warm', status: 'completed' }],
      },
      windowBySession: {
        [sessionB]: {
          totalCount: 1,
          loadedStart: 0,
          loadedEnd: 1,
          hasOlder: false,
          hasNewer: false,
          isPartial: false,
          hasUserMessages: true,
        },
      },
    },
  };
  const effects: Array<{ kind: string }> = [];
  const getArchState = () => archState;
  const dispatchArch = (event: Event) => {
    const result = reducer(archState, event);
    archState = result.state;
    effects.push(...result.effects);
  };
  const context = createExtensionContext();
  const backendRequests: string[] = [];
  const backend = {
    request: async (method: string) => { backendRequests.push(method); },
  } as any;
  const state = new SessionServiceState(context, backend, () => undefined, getArchState, dispatchArch, 0);
  const tabs = new SessionTabActions({
    context,
    scheduleRender: () => undefined,
    runObserver: NOOP_RUN_OBSERVER,
    state,
    getArchState,
    dispatchArch,
  });

  state.markSessionRuntimeKnown(sessionB);
  const staleToken = state.beginSelectionRequest('/workspace/cold-session.jsonl');
  assert.equal(state.isCurrentSelectionToken(staleToken), true);

  tabs.openSession(sessionB);

  assert.equal(archState.sessions.activeSessionPath, sessionB);
  assert.equal(state.isCurrentSelectionToken(staleToken), false, 'the pending cold open must not steal focus later');
  assert.ok(state.getSelectionRequest(staleToken), 'the stale request remains available for operation cleanup');
  assert.deepEqual(effects.map((effect) => effect.kind), ['PersistTabs']);
  assert.deepEqual(backendRequests, []);

  state.resetRuntimeState();
  effects.length = 0;
  tabs.openSession(sessionB);
  assert.ok(effects.some((effect) => effect.kind === 'OpenSession'), 'a backend restart must force runtime rehydration');
});

test('openSession serializes backend session.open requests through the lifecycle queue', async () => {
  // After the MVI migration the reducer owns the optimistic tab setup and the
  // runner owns the backend `session.open` RPC (serialized via the lifecycle
  // queue). So the dispatch loop must run the reducer AND execute the emitted
  // effects via the EffectRunner — mirroring extension-host. The real
  // `state.enqueueLifecycle` is injected so the two open effects serialize.
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sessionPaths = [`/workspace/session-a-${suffix}.jsonl`, `/workspace/session-b-${suffix}.jsonl`];
  const started: string[] = [];
  const resolvers: Array<() => void> = [];

  const backend = {
    request: async (_method: string, params: { sessionPath?: string }) => {
      started.push(String(params.sessionPath ?? ''));
      await new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });
      return undefined;
    },
  } as any;

  const context = createExtensionContext();
  let archState = createInitialArchState();
  const getArchState = () => archState;
  const dispatchArch = (event: Event) => {
    const result = reducer(archState, event);
    archState = result.state;
    for (const effect of result.effects) runner.run(effect);
  };
  // Disable the 60s selection-request timeout watchdog: this test exercises request
  // serialization, not timeout behavior. An armed-but-uncleared 60s timer keeps the Node
  // process alive for a minute after the test, so the file-level test "fails" on the runner's
  // wait. Passing 0 makes armSelectionRequestTimeout() a no-op (no timer armed, nothing to leak).
  const state = new SessionServiceState(context, backend, () => undefined, getArchState, dispatchArch, 0);
  const tabs = new SessionTabActions({
    context,
    scheduleRender: () => undefined,
    runObserver: NOOP_RUN_OBSERVER,
    state,
    getArchState,
    dispatchArch,
  });

  const { deps } = makeEffectRunnerDeps({
    backend,
    // Inject the REAL serializing lifecycle queue so the two open effects
    // serialize (the whole point of this test).
    queues: {
      enqueueLifecycle: (task) => state.enqueueLifecycle(task),
      enqueueSessionOperation: (sessionPath, task) => state.enqueueSessionOperation(sessionPath, task),
    },
    serviceOverrides: {
      handleSelectionFailure: (token: string, notice: string) => state.handleSelectionFailure(token, notice),
    },
    dispatch: (e: EffectResultEvent) => dispatchArch(e),
  });
  const runner = new EffectRunner(deps);

  tabs.openSession(sessionPaths[0]);
  tabs.openSession(sessionPaths[1]);

  await flushMicrotasks(2);

  assert.deepEqual(
    started,
    [sessionPaths[0]],
    'the second tab-open request should wait for the first lifecycle task to finish',
  );
  assert.equal(resolvers.length, 1);

  resolvers.shift()?.();
  await waitFor(() => started.length === 2);

  assert.deepEqual(started, sessionPaths);

  resolvers.shift()?.();
  await flushMicrotasks(2);
});
