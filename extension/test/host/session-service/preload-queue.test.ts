import assert from 'node:assert/strict';
import test from 'node:test';

import { createInitialArchState } from '../../../src/host/core/arch-state';
import { reducer } from '../../../src/host/core/reducer';
import { EffectRunner } from '../../../src/host/core/effect-runner';
import { SessionServiceState } from '../../../src/host/session-service/state';
import { SessionTabActions } from '../../../src/host/session-service/tab-actions';
import { NOOP_RUN_OBSERVER } from '../../../src/host/stats-service';
import { makeEffectRunnerDeps } from '../../helpers/effect-runner-deps';
import type { SessionOpenedPayload } from '../../../src/shared/protocol';
import type { ArchState } from '../../../src/host/core/arch-state';
import type { Event } from '../../../src/host/core/events';
import type { Effect } from '../../../src/host/core/effects';

function createExtensionContext() {
  return {
    globalState: { update: async () => undefined },
    workspaceState: { update: async () => undefined },
  } as any;
}

interface PendingRequest {
  method: string;
  sessionPath: string;
  resolve: (value?: unknown) => void;
  reject: (reason?: unknown) => void;
}

class DeferredBackend {
  readonly calls: string[] = [];
  readonly pending: PendingRequest[] = [];
  active = 0;
  maxActive = 0;
  localCancellations = 0;

  request(
    method: string,
    params?: unknown,
    options?: { signal?: AbortSignal; onTransportSettled?: () => void },
  ): Promise<unknown> {
    const sessionPath = String((params as { sessionPath?: unknown } | undefined)?.sessionPath ?? '');
    this.calls.push(`${method}:${sessionPath}`);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    return new Promise((resolve, reject) => {
      let applicationSettled = false;
      const onAbort = () => {
        if (applicationSettled) return;
        applicationSettled = true;
        this.localCancellations += 1;
        reject(new Error('local waiter cancelled'));
      };
      options?.signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.push({
        method,
        sessionPath,
        resolve: (value) => {
          this.active -= 1;
          options?.signal?.removeEventListener('abort', onAbort);
          options?.onTransportSettled?.();
          if (!applicationSettled) {
            applicationSettled = true;
            resolve(value);
          }
        },
        reject: (reason) => {
          this.active -= 1;
          options?.signal?.removeEventListener('abort', onAbort);
          options?.onTransportSettled?.();
          if (!applicationSettled) {
            applicationSettled = true;
            reject(reason);
          }
        },
      });
    });
  }

  settle(index: number, value?: unknown): void {
    this.pending[index]?.resolve(value);
  }

  fail(index: number, error = new Error('preload failed')): void {
    this.pending[index]?.reject(error);
  }
}

async function flushMicrotasks(turns = 6): Promise<void> {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

function createState(paths: readonly string[], running: readonly string[] = []) {
  let archState: ArchState = createInitialArchState();
  archState = {
    ...archState,
    sessions: {
      ...archState.sessions,
      openTabPaths: [...paths],
      runningSessionPaths: [...running],
    },
  };
  const backend = new DeferredBackend();
  const getArchState = () => archState;
  let runEffects: ((effects: Effect[]) => void) | undefined;
  const dispatchArch = (event: Event) => {
    const result = reducer(archState, event);
    archState = result.state;
    runEffects?.(result.effects);
  };
  const state = new SessionServiceState(
    createExtensionContext(),
    backend as any,
    () => undefined,
    getArchState,
    dispatchArch,
    0,
  );
  return {
    state,
    backend,
    getArchState,
    dispatchArch,
    setEffectRunner: (runner: (effects: Effect[]) => void) => { runEffects = runner; },
  };
}

function payload(sessionPath: string): SessionOpenedPayload {
  return { session: { path: sessionPath } as any } as SessionOpenedPayload;
}

test('snapshot-known and runtime-ready knowledge are independent and reset together', () => {
  const h = createState([]);
  h.state.markSessionSnapshotKnown('/cold');
  h.state.markSessionSnapshotKnown('/hot');
  h.state.markSessionRuntimeKnown('/hot');

  assert.equal(h.state.isSessionSnapshotKnown('/cold'), true);
  assert.equal(h.state.isSessionRuntimeKnown('/cold'), false);
  assert.equal(h.state.isSessionSnapshotKnown('/hot'), true);
  assert.equal(h.state.isSessionRuntimeKnown('/hot'), true);

  h.state.resetRuntimeState();
  assert.equal(h.state.isSessionSnapshotKnown('/cold'), false);
  assert.equal(h.state.isSessionRuntimeKnown('/hot'), false);
});

test('unresolved foreground session.open prevents the first preload and settling resumes it', async () => {
  const startup = '/workspace/startup.jsonl';
  const background = '/workspace/background.jsonl';
  const setup = createState([startup, background]);

  setup.state.enqueueLifecycle(() => setup.backend.request('session.open', { sessionPath: startup }));
  setup.state.preloadSession(background);
  await flushMicrotasks();

  assert.deepEqual(setup.backend.calls, [`session.open:${startup}`]);

  setup.backend.settle(0, payload(startup));
  await flushMicrotasks();
  assert.deepEqual(setup.backend.calls, [
    `session.open:${startup}`,
    `session.preload:${background}`,
  ]);
});

test('startup drains queued foreground lifecycle work before background preload work', async () => {
  const startup = '/workspace/startup.jsonl';
  const created = '/workspace/created.jsonl';
  const background = '/workspace/background.jsonl';
  const setup = createState([startup, created, background]);

  setup.state.enqueueLifecycle(() => setup.backend.request('session.open', { sessionPath: startup }));
  setup.state.enqueueLifecycle(() => setup.backend.request('session.create', { sessionPath: created }));
  setup.state.preloadSession(background);
  await flushMicrotasks();
  assert.deepEqual(setup.backend.calls, [`session.open:${startup}`]);

  setup.backend.settle(0, payload(startup));
  await flushMicrotasks();
  assert.deepEqual(setup.backend.calls, [
    `session.open:${startup}`,
    `session.create:${created}`,
  ]);

  setup.backend.settle(1, payload(created));
  await flushMicrotasks();
  assert.deepEqual(setup.backend.calls, [
    `session.open:${startup}`,
    `session.create:${created}`,
    `session.preload:${background}`,
  ]);
});

test('reset fences lifecycle tasks that have not started without cancelling in-flight or replacement work', async () => {
  const { state } = createState([]);
  const started: string[] = [];
  const unhandledRejections: unknown[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
  process.on('unhandledRejection', onUnhandledRejection);

  try {
    const first = state.enqueueLifecycle(async () => {
      started.push('old-first');
      await firstGate;
      return 'old-first-result';
    });
    const stale = state.enqueueLifecycle(async () => {
      started.push('old-second');
      return 'old-second-result';
    });
    await flushMicrotasks();
    assert.deepEqual(started, ['old-first']);

    state.resetRuntimeState();
    const replacement = state.enqueueLifecycle(async () => {
      started.push('new-first');
      return 'new-first-result';
    });
    assert.equal(await replacement, 'new-first-result', 'replacement generation is not blocked by the old queue');

    releaseFirst();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const [firstResult, staleResult] = await Promise.allSettled([first, stale]);

    assert.deepEqual(firstResult, { status: 'fulfilled', value: 'old-first-result' });
    assert.equal(staleResult.status, 'rejected');
    if (staleResult.status === 'rejected') {
      assert.equal(staleResult.reason?.name, 'LifecycleTaskStaleGenerationError');
    }
    assert.deepEqual(started, ['old-first', 'new-first'], 'the stale queued task never executes');
    assert.deepEqual(unhandledRejections, [], 'the queue consumes ignored stale-task rejections internally');
  } finally {
    releaseFirst();
    process.off('unhandledRejection', onUnhandledRejection);
  }
});

test('background preloads are FIFO, deduplicated, and single-flight; failures advance', async () => {
  const a = '/workspace/a.jsonl';
  const b = '/workspace/b.jsonl';
  const c = '/workspace/c.jsonl';
  const { state, backend } = createState([a, b, c]);
  const opened: string[] = [];
  state.setPreloadedSessionOpenedHandler((event) => opened.push(event.session.path));

  state.preloadSessions([a, b, a, c]);
  await flushMicrotasks();
  assert.deepEqual(backend.calls, [`session.preload:${a}`]);
  assert.equal(backend.maxActive, 1);

  backend.settle(0, payload(a));
  await flushMicrotasks();
  assert.deepEqual(backend.calls, [`session.preload:${a}`, `session.preload:${b}`]);
  assert.deepEqual(opened, [a]);

  backend.fail(1);
  await flushMicrotasks();
  assert.deepEqual(backend.calls, [
    `session.preload:${a}`,
    `session.preload:${b}`,
    `session.preload:${c}`,
  ]);
  assert.equal(backend.maxActive, 1);

  backend.settle(2, payload(c));
  await flushMicrotasks();
  assert.deepEqual(opened, [a, c]);
});

test('background preload pump pauses while any host session is running and resumes on idle', async () => {
  const running = '/workspace/running.jsonl';
  const preload = '/workspace/preload.jsonl';
  const setup = createState([running, preload], [running]);

  setup.state.preloadSession(preload);
  await flushMicrotasks();
  assert.deepEqual(setup.backend.calls, []);

  setup.dispatchArch({ kind: 'RunningSessionsChanged', sessionPaths: [] });
  setup.state.resumePreloads();
  await flushMicrotasks();
  assert.deepEqual(setup.backend.calls, [`session.preload:${preload}`]);
});

test('generation beginning fences an active preload and holds the queue until idle and transport settlement', async () => {
  const running = '/workspace/running.jsonl';
  const active = '/workspace/background-a.jsonl';
  const queued = '/workspace/background-b.jsonl';
  const setup = createState([running, active, queued]);
  const opened: string[] = [];
  setup.state.setPreloadedSessionOpenedHandler((event) => opened.push(event.session.path));

  setup.state.preloadSessions([active, queued]);
  await flushMicrotasks();
  assert.deepEqual(setup.backend.calls, [`session.preload:${active}`]);

  setup.dispatchArch({ kind: 'RunningSessionsChanged', sessionPaths: [running] });
  setup.state.resumePreloads();
  await flushMicrotasks();
  assert.equal(setup.backend.localCancellations, 1, 'active preload host waiter is cancelled immediately');

  setup.dispatchArch({ kind: 'RunningSessionsChanged', sessionPaths: [] });
  setup.state.resumePreloads();
  await flushMicrotasks();
  assert.deepEqual(setup.backend.calls, [`session.preload:${active}`], 'idle alone cannot release the physical preload slot');

  setup.backend.settle(0, payload(active));
  await flushMicrotasks();
  assert.deepEqual(opened, [], 'the cancelled active preload payload is fenced');
  assert.deepEqual(setup.backend.calls, [
    `session.preload:${active}`,
    `session.preload:${queued}`,
  ]);
  assert.equal(setup.backend.maxActive, 1, 'local cancellation does not increase backend background concurrency');
});

test('generation fences a transport-settled preload before its host payload continuation applies', async () => {
  const running = '/workspace/running.jsonl';
  const active = '/workspace/background-a.jsonl';
  const queued = '/workspace/background-b.jsonl';
  const setup = createState([running, active, queued]);
  const opened: string[] = [];
  setup.state.setPreloadedSessionOpenedHandler((event) => opened.push(event.session.path));

  setup.state.preloadSessions([active, queued]);
  await flushMicrotasks();
  setup.backend.settle(0, payload(active));
  // The transport callback ran synchronously, but the host promise continuation
  // has not. Generation must still fence that pending payload application.
  setup.dispatchArch({ kind: 'RunningSessionsChanged', sessionPaths: [running] });
  setup.state.resumePreloads();
  await flushMicrotasks();

  assert.deepEqual(opened, []);
  assert.deepEqual(setup.backend.calls, [`session.preload:${active}`]);

  setup.dispatchArch({ kind: 'RunningSessionsChanged', sessionPaths: [] });
  setup.state.resumePreloads();
  await flushMicrotasks();
  assert.deepEqual(setup.backend.calls, [
    `session.preload:${active}`,
    `session.preload:${queued}`,
  ]);
});

test('foreground selection removes a queued preload and is not blocked by an in-flight preload', async () => {
  const activePreload = '/workspace/background-a.jsonl';
  const selected = '/workspace/background-b.jsonl';
  const setup = createState([activePreload, selected]);
  const tabs = new SessionTabActions({
    context: createExtensionContext(),
    scheduleRender: () => undefined,
    runObserver: NOOP_RUN_OBSERVER,
    state: setup.state,
    getArchState: setup.getArchState,
    dispatchArch: setup.dispatchArch,
  });

  setup.state.preloadSessions([activePreload, selected]);
  await flushMicrotasks();
  assert.deepEqual(setup.backend.calls, [`session.preload:${activePreload}`]);

  const { deps } = makeEffectRunnerDeps({
    backend: setup.backend as any,
    serviceOverrides: {
      handleSelectionFailure: (token, notice) => setup.state.handleSelectionFailure(token, notice),
    },
    dispatch: (event) => setup.dispatchArch(event),
  });
  const runner = new EffectRunner(deps);
  setup.setEffectRunner((effects) => effects.forEach((effect) => runner.run(effect)));

  tabs.openSession(selected);
  assert.equal(setup.getArchState().sessions.activeSessionPath, selected);
  assert.deepEqual(setup.backend.calls, [
    `session.preload:${activePreload}`,
    `session.open:${selected}`,
  ], 'foreground session.open is dispatched immediately rather than waiting for the background preload');
  setup.backend.settle(0, payload(activePreload));
  await flushMicrotasks();

  assert.deepEqual(setup.backend.calls, [
    `session.preload:${activePreload}`,
    `session.open:${selected}`,
  ]);
});

test('selecting an in-flight preload path suppresses its stale payload', async () => {
  const selected = '/workspace/selected.jsonl';
  const setup = createState([selected]);
  const tabs = new SessionTabActions({
    context: createExtensionContext(),
    scheduleRender: () => undefined,
    runObserver: NOOP_RUN_OBSERVER,
    state: setup.state,
    getArchState: setup.getArchState,
    dispatchArch: setup.dispatchArch,
  });
  const opened: string[] = [];
  setup.state.setPreloadedSessionOpenedHandler((event) => opened.push(event.session.path));

  setup.state.preloadSession(selected);
  await flushMicrotasks();
  tabs.openSession(selected);
  setup.backend.settle(0, payload(selected));
  await flushMicrotasks();

  assert.deepEqual(opened, []);
});

test('reset fences old preload completions from the replacement generation', async () => {
  const sessionPath = '/workspace/restarted.jsonl';
  const setup = createState([sessionPath]);
  const opened: string[] = [];
  setup.state.setPreloadedSessionOpenedHandler((event) => opened.push(event.session.path));

  setup.state.preloadSession(sessionPath);
  await flushMicrotasks();
  setup.state.resetRuntimeState();
  setup.state.preloadSession(sessionPath);
  await flushMicrotasks();
  assert.equal(setup.backend.calls.length, 2);

  setup.backend.settle(0, payload(sessionPath));
  await flushMicrotasks();
  assert.deepEqual(opened, []);
  assert.equal(setup.backend.calls.length, 2, 'old completion must not drain the replacement record');

  setup.backend.settle(1, payload(sessionPath));
  await flushMicrotasks();
  assert.deepEqual(opened, [sessionPath]);
});

test('closing a session fences its in-flight preload completion', async () => {
  const sessionPath = '/workspace/closed.jsonl';
  const setup = createState([sessionPath]);
  const opened: string[] = [];
  setup.state.setPreloadedSessionOpenedHandler((event) => opened.push(event.session.path));

  setup.state.preloadSession(sessionPath);
  await flushMicrotasks();
  setup.state.clearSessionScope(sessionPath);
  setup.backend.settle(0, payload(sessionPath));
  await flushMicrotasks();

  assert.deepEqual(opened, []);
});
