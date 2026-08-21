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

  state.markSessionSnapshotKnown(sessionB);
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
  assert.ok(effects.some((effect) => effect.kind === 'OpenSession'), 'a backend restart must force durable snapshot rehydration');
});

test('preloaded cold tab transitions notify the backend in visual order without session.open or delayed selection', async () => {
  const sessionA = '/workspace/session-a.jsonl';
  const sessionB = '/workspace/session-b.jsonl';
  const sessionC = '/workspace/session-c.jsonl';
  let archState = createInitialArchState();
  archState = {
    ...archState,
    sessions: {
      ...archState.sessions,
      sessions: [sessionA, sessionB, sessionC].map((sessionPath) => ({
        path: sessionPath,
        name: sessionPath.at(-7)?.toUpperCase() ?? sessionPath,
        cwd: '/workspace',
        modifiedAt: '2026-01-01T00:00:00.000Z',
        messageCount: 1,
      })),
      openTabPaths: [sessionA, sessionB, sessionC],
      activeSessionPath: sessionA,
    },
    transcript: {
      ...archState.transcript,
      bySession: { [sessionB]: [], [sessionC]: [] },
      windowBySession: {
        [sessionB]: { totalCount: 0, loadedStart: 0, loadedEnd: 0, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false },
        [sessionC]: { totalCount: 0, loadedStart: 0, loadedEnd: 0, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false },
      },
    },
  };
  const effects: Array<{ kind: string }> = [];
  const notifications: Array<{ method: string; sessionPath: string; previousSessionPath: string | null }> = [];
  const getArchState = () => archState;
  const dispatchArch = (event: Event) => {
    const result = reducer(archState, event);
    archState = result.state;
    effects.push(...result.effects);
  };
  const context = createExtensionContext();
  const backend = { request: async () => undefined } as any;
  const state = new SessionServiceState(context, backend, () => undefined, getArchState, dispatchArch, 0);
  state.markSessionSnapshotKnown(sessionB);
  state.markSessionSnapshotKnown(sessionC);
  const tabs = new SessionTabActions({
    context,
    scheduleRender: () => undefined,
    runObserver: NOOP_RUN_OBSERVER,
    state,
    getArchState,
    dispatchArch,
    notifySessionViewed: async (sessionPath, previousSessionPath) => {
      notifications.push({ method: 'session.viewed', sessionPath, previousSessionPath });
    },
  });

  tabs.openSession(sessionB);
  assert.equal(archState.sessions.activeSessionPath, sessionB, 'visual selection is synchronous');
  tabs.openSession(sessionC);
  tabs.openSession(sessionB);
  tabs.openSession(sessionB);

  assert.deepEqual(notifications, [
    { method: 'session.viewed', sessionPath: sessionB, previousSessionPath: sessionA },
    { method: 'session.viewed', sessionPath: sessionC, previousSessionPath: sessionB },
    { method: 'session.viewed', sessionPath: sessionB, previousSessionPath: sessionC },
  ]);
  assert.ok(effects.every((effect) => effect.kind === 'PersistTabs'), 'host-local selection never emits session.open');
});

test('view notification normalizes pending predecessors to null', () => {
  const pending = '__pending__:1-create';
  const sessionB = '/workspace/b.jsonl';
  let archState = createInitialArchState();
  archState.sessions.sessions = [{
    path: sessionB, name: 'B', cwd: '/workspace', modifiedAt: '2026-01-01T00:00:00.000Z', messageCount: 0,
  }];
  archState.sessions.openTabPaths = [pending, sessionB];
  archState.sessions.activeSessionPath = pending;
  archState.transcript.bySession[sessionB] = [];
  archState.transcript.windowBySession[sessionB] = {
    totalCount: 0, loadedStart: 0, loadedEnd: 0, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false,
  };
  const getArchState = () => archState;
  const dispatchArch = (event: Event) => { archState = reducer(archState, event).state; };
  const context = createExtensionContext();
  const state = new SessionServiceState(context, { request: async () => undefined } as any, () => undefined, getArchState, dispatchArch, 0);
  state.markSessionSnapshotKnown(sessionB);
  const predecessors: Array<string | null> = [];
  const tabs = new SessionTabActions({
    context, scheduleRender: () => undefined, runObserver: NOOP_RUN_OBSERVER,
    state, getArchState, dispatchArch,
    notifySessionViewed: async (_path, predecessor) => { predecessors.push(predecessor); },
  });

  tabs.openSession(sessionB);
  assert.deepEqual(predecessors, [null]);
});

test('view notification failure keeps local selection and surfaces only the current transition failure', async () => {
  const sessionA = '/workspace/a.jsonl';
  const sessionB = '/workspace/b.jsonl';
  let archState = createInitialArchState();
  archState.sessions.sessions = [sessionA, sessionB].map((sessionPath) => ({
    path: sessionPath, name: sessionPath, cwd: '/workspace', modifiedAt: '2026-01-01T00:00:00.000Z', messageCount: 0,
  }));
  archState.sessions.openTabPaths = [sessionA, sessionB];
  archState.sessions.activeSessionPath = sessionA;
  archState.transcript.bySession[sessionB] = [];
  archState.transcript.windowBySession[sessionB] = {
    totalCount: 0, loadedStart: 0, loadedEnd: 0, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false,
  };
  const getArchState = () => archState;
  const dispatchArch = (event: Event) => { archState = reducer(archState, event).state; };
  const context = createExtensionContext();
  const state = new SessionServiceState(context, { request: async () => undefined } as any, () => undefined, getArchState, dispatchArch, 0);
  state.markSessionSnapshotKnown(sessionB);
  const tabs = new SessionTabActions({
    context, scheduleRender: () => undefined, runObserver: NOOP_RUN_OBSERVER,
    state, getArchState, dispatchArch,
    notifySessionViewed: async () => { throw new Error('backend unavailable'); },
  });

  tabs.openSession(sessionB);
  assert.equal(archState.sessions.activeSessionPath, sessionB);
  await flushMicrotasks(2);
  assert.equal(archState.sessions.activeSessionPath, sessionB, 'notification failure never rolls back visual selection');
  assert.match(archState.settings.notice ?? '', /backend view tracking failed: backend unavailable/);
});

test('an older failed notification cannot surface after leaving and reselecting the same tab', async () => {
  const a = '/workspace/a.jsonl';
  const b = '/workspace/b.jsonl';
  let archState = createInitialArchState();
  archState.sessions.sessions = [a, b].map((sessionPath) => ({
    path: sessionPath, name: sessionPath, cwd: '/workspace', modifiedAt: '2026-01-01T00:00:00.000Z', messageCount: 0,
  }));
  archState.sessions.openTabPaths = [a, b];
  archState.sessions.activeSessionPath = a;
  for (const sessionPath of [a, b]) {
    archState.transcript.bySession[sessionPath] = [];
    archState.transcript.windowBySession[sessionPath] = {
      totalCount: 0, loadedStart: 0, loadedEnd: 0, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false,
    };
  }
  const getArchState = () => archState;
  const dispatchArch = (event: Event) => { archState = reducer(archState, event).state; };
  const context = createExtensionContext();
  const state = new SessionServiceState(context, { request: async () => undefined } as any, () => undefined, getArchState, dispatchArch, 0);
  state.markSessionSnapshotKnown(a);
  state.markSessionSnapshotKnown(b);
  let rejectFirst!: (error: Error) => void;
  let call = 0;
  const tabs = new SessionTabActions({
    context, scheduleRender: () => undefined, runObserver: NOOP_RUN_OBSERVER,
    state, getArchState, dispatchArch,
    notifySessionViewed: async () => {
      call += 1;
      if (call === 1) await new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
    },
  });

  tabs.openSession(b);
  tabs.openSession(a);
  tabs.openSession(b);
  rejectFirst(new Error('stale failure'));
  await flushMicrotasks(2);
  assert.equal(archState.sessions.activeSessionPath, b);
  assert.equal(archState.settings.notice, null);
});

test('create selection invalidates an older viewed-notification failure', async () => {
  const a = '/workspace/a.jsonl';
  const b = '/workspace/b.jsonl';
  let archState = createInitialArchState();
  archState.sessions.workspaceCwd = '/workspace';
  archState.sessions.sessions = [a, b].map((sessionPath) => ({
    path: sessionPath, name: sessionPath, cwd: '/workspace', modifiedAt: '2026-01-01T00:00:00.000Z', messageCount: 0,
  }));
  archState.sessions.openTabPaths = [a, b];
  archState.sessions.activeSessionPath = a;
  archState.transcript.bySession[b] = [];
  archState.transcript.windowBySession[b] = {
    totalCount: 0, loadedStart: 0, loadedEnd: 0, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false,
  };
  const getArchState = () => archState;
  const dispatchArch = (event: Event) => { archState = reducer(archState, event).state; };
  const context = createExtensionContext();
  const state = new SessionServiceState(context, { request: async () => undefined } as any, () => undefined, getArchState, dispatchArch, 0);
  state.markSessionSnapshotKnown(b);
  let rejectViewed!: (error: Error) => void;
  const tabs = new SessionTabActions({
    context, scheduleRender: () => undefined, runObserver: NOOP_RUN_OBSERVER,
    state, getArchState, dispatchArch,
    notifySessionViewed: async () => await new Promise<void>((_resolve, reject) => { rejectViewed = reject; }),
  });

  tabs.openSession(b);
  tabs.createNewSession();
  rejectViewed(new Error('stale viewed failure'));
  await flushMicrotasks(2);
  assert.equal(archState.settings.notice, null);
});

test('close reducer notifies only when closing the active tab', () => {
  const a = '/workspace/a.jsonl';
  const b = '/workspace/b.jsonl';
  const c = '/workspace/c.jsonl';
  const makeState = () => {
    const state = createInitialArchState();
    state.sessions.sessions = [a, b, c].map((sessionPath) => ({
      path: sessionPath, name: sessionPath, cwd: '/workspace', modifiedAt: '2026-01-01T00:00:00.000Z', messageCount: 0,
    }));
    state.sessions.openTabPaths = [a, b, c];
    state.sessions.activeSessionPath = a;
    return state;
  };

  const inactive = reducer(makeState(), {
    kind: 'Command', cmd: { kind: 'CloseSession', corrId: 'close-b', sessionPath: b },
  });
  assert.equal(inactive.state.sessions.activeSessionPath, a);
  assert.equal(inactive.effects.some((effect) => effect.kind === 'NotifySessionViewed'), false);

  const active = reducer(makeState(), {
    kind: 'Command', cmd: { kind: 'CloseSession', corrId: 'close-a', sessionPath: a },
  });
  assert.equal(active.state.sessions.activeSessionPath, b);
  assert.deepEqual(active.effects.find((effect) => effect.kind === 'NotifySessionViewed'), {
    kind: 'NotifySessionViewed', corrId: 'close-a', sessionPath: b, previousSessionPath: a,
  });
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

test('session operation queues fence continuations from an ended backend generation', async () => {
  const backend = {} as any;
  const context = createExtensionContext();
  const archState = createInitialArchState();
  const state = new SessionServiceState(
    context,
    backend,
    () => undefined,
    () => archState,
    () => undefined,
    0,
  );

  let releaseFirst!: () => void;
  const first = state.enqueueSessionOperation('/workspace/session.jsonl', () => new Promise<void>((resolve) => {
    releaseFirst = resolve;
  }));
  await flushMicrotasks(2);

  let staleTaskRan = false;
  const stale = state.enqueueSessionOperation('/workspace/session.jsonl', async () => {
    staleTaskRan = true;
  });

  state.resetRuntimeState();
  releaseFirst();
  await first;

  await assert.rejects(stale, (error: Error) => error.name === 'LifecycleTaskStaleGenerationError');
  assert.equal(staleTaskRan, false, 'an operation queued before restart must not mutate the replacement backend');
});
