/**
 * Integration test pinning the critical ordering invariant of the openSession
 * migration: `beginSelectionRequest` must run BEFORE the reducer optimistically
 * activates the opened tab, so the selection request snapshots the *previous*
 * active path. `handleSelectionFailure` uses that snapshot to restore the
 * previously-active tab on failure — if `beginSelectionRequest` ran after the
 * reducer set `activeSessionPath = sessionPath`, it would snapshot the opened
 * path and recovery would select the wrong tab.
 *
 * Mirrors create-session-ordering.test.ts (the createSession equivalent) but
 * opens a real (non-pending) path. Uses the real `SessionServiceState` +
 * `SessionTabActions` (timeout disabled to avoid a 60s timer leak);
 * `dispatchArch` runs the real reducer so the optimistic setup is applied
 * synchronously before `openSession()` returns.
 */
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackendClient, BackendRpcError } from '../../../agent-connection/client';
import { RequestTimeoutError } from '../../../agent-connection/request-tracker';
import assert from 'node:assert/strict';

import { NOOP_RUN_OBSERVER } from '../../../analytics-views';
import { createInitialArchState } from '../../../conversation-state/arch-state';
import type { ArchState } from '../../../conversation-state/arch-state';
import { reducer } from '../../../conversation-state/reducer';
import { projectSessionCapabilities } from '../../../conversation-state/projections/projection';
import { SessionServiceState } from '../../../session-actions/state';
import { SessionTabActions } from '../../../session-actions/tab-actions';
import { attach } from '../../../session-actions/handlers/attach';
import type { SessionSummary } from '../../../../lib/protocol/index.js';
import { EffectRunner, type BackendLike, type CommitAwareRequestOptions } from '../../../conversation-state/effects/effect-runner';
import type { Event, EffectResultEvent } from '../../../conversation-state/events';
import { makeEffectRunnerDeps } from '../../helpers/effect-runner-deps';

function createExtensionContext(): any {
  return {
    globalState: { update: async () => undefined },
    workspaceState: { update: async () => undefined },
  };
}

test('openSession mints the selection token before the reducer activates the opened tab (previousActivePath is the old active)', () => {
  const backend = { request: async () => ({}) } as any;
  const context = createExtensionContext();
  const OLD = '/workspace/old.jsonl';
  const NEW = '/workspace/new.jsonl';
  const oldSummary: SessionSummary = {
    path: OLD, name: 'Old', cwd: '/w', modifiedAt: '2024-01-01T00:00:00.000Z', messageCount: 1,
  };
  let archState: ArchState = {
    ...createInitialArchState(),
    sessions: {
      ...createInitialArchState().sessions,
      sessions: [oldSummary],
      openTabPaths: [OLD],
      activeSessionPath: OLD,
    },
  };
  const getArchState = () => archState;

  let capturedToken: string | undefined;
  const dispatchArch = (event: Event) => {
    if (event.kind === 'Command' && event.cmd.kind === 'OpenSession') {
      capturedToken = event.cmd.selectionToken;
    }
    archState = reducer(archState, event).state;
  };

  // timeout = 0 → armSelectionRequestTimeout is a no-op (no 60s timer leak).
  const state = new SessionServiceState(backend, () => undefined, getArchState, dispatchArch, 0);
  const tabs = new SessionTabActions({
    scheduleRender: () => undefined,
    runObserver: NOOP_RUN_OBSERVER,
    state,
    getArchState,
    dispatchArch,
  });

  tabs.openSession(NEW);

  // The reducer activated the opened tab (optimistic setup applied
  // synchronously during the Command dispatch).
  assert.equal(archState.sessions.activeSessionPath, NEW);
  assert.ok(archState.sessions.openTabPaths.includes(NEW));

  // The selection request snapshotted the OLD active path — NOT the opened
  // path — because beginSelectionRequest ran before the Command dispatch. This
  // is what lets handleSelectionFailure restore the previous active tab on
  // failure. (If beginSelectionRequest ran after the reducer set active =
  // NEW, previousActivePath would equal NEW — a recovery bug.)
  const request = state.getSelectionRequest(capturedToken);
  assert.ok(request, 'a selection request was registered for the open');
  assert.equal(request?.previousActivePath, OLD);
  assert.notEqual(request?.previousActivePath, NEW);
});

for (const wasOpenTab of [false, true]) {
  for (const superseded of [false, true]) {
    test(`confirmed backend exit settles ambiguous open before reset (restored=${wasOpenTab}, superseded=${superseded})`, () => {
      const oldPath = '/workspace/old.jsonl';
      const openedPath = '/workspace/loading.jsonl';
      let arch = createInitialArchState();
      arch = { ...arch, sessions: { ...arch.sessions,
        openTabPaths: wasOpenTab ? [oldPath, openedPath] : [oldPath],
        activeSessionPath: oldPath,
      } };
      let token = '';
      let operationId = '';
      const dispatchArch = (event: Event) => {
        if (event.kind === 'Command' && event.cmd.kind === 'OpenSession') {
          token = event.cmd.selectionToken!;
          operationId = event.cmd.operationId!;
        }
        arch = reducer(arch, event).state;
      };
      const state = new SessionServiceState({} as any, () => undefined, () => arch, dispatchArch, 0);
      const tabs = new SessionTabActions({ state, getArchState: () => arch, dispatchArch,
        scheduleRender: () => undefined, runObserver: NOOP_RUN_OBSERVER });
      state.adoptBackendGeneration(1);
      tabs.openSession(openedPath);
      dispatchArch({ kind: 'OpenSessionResult', corrId: 'lost-ack', sessionPath: openedPath,
        operationId, operationAttempt: 1, backendGeneration: 1,
        ok: false, ambiguous: true, error: 'deadline' });
      assert.equal(arch.operations[operationId].phase, 'ambiguous');
      assert.ok(state.getSelectionRequest(token));
      assert.ok(arch.sessions.openTabPaths.includes(openedPath));
      state.adoptBackendGeneration(2);
      state.failPendingCreateOperations('another generation ended');
      assert.equal(arch.operations[operationId].terminal, undefined);
      assert.ok(state.getSelectionRequest(token));
      assert.ok(arch.sessions.openTabPaths.includes(openedPath));
      // Restore the owning generation for its actual confirmed-exit callback.
      state.adoptBackendGeneration(1);
      if (superseded) {
        state.supersedeSelectionOwnership();
        dispatchArch({ kind: 'Command', cmd: { kind: 'SelectSession', corrId: 'select-old', sessionPath: oldPath } });
      }
      let exit!: (info: { code: number | null; stderr: string }) => void;
      attach({ getGeneration: () => 1, onEvent: () => ({ dispose() {} }),
        onExit: (handler) => { exit = handler; return { dispose() {} }; } },
      { state, getArchState: () => arch, dispatchArch, scheduleRender: () => undefined,
        runObserver: NOOP_RUN_OBSERVER }, { handleBackendEvent: () => undefined });
      exit({ code: 1, stderr: '' });
      assert.equal(arch.operations[operationId].terminal?.reason, 'backend-generation-ended');
      assert.equal(arch.operations[operationId].terminal?.outcome, 'failed');
      assert.equal(state.getSelectionRequest(token), null);
      assert.equal(arch.sessions.openTabPaths.includes(openedPath), wasOpenTab);
      assert.equal(arch.sessions.activeSessionPath, oldPath);
      const terminal = arch.operations[operationId].terminal;
      dispatchArch({ kind: 'OpenSessionResult', corrId: 'late', sessionPath: openedPath,
        operationId, operationAttempt: 1, backendGeneration: 1, ok: true });
      assert.deepEqual(arch.operations[operationId].terminal, terminal);
    });
  }
}

test('openSession selects an existing pending tab without opening its sentinel path in the backend', () => {
  const backend = { request: async () => ({}) } as any;
  const context = createExtensionContext();
  const OLD = '/workspace/old.jsonl';
  const PENDING = '__pending__:1-abc';
  const oldSummary: SessionSummary = {
    path: OLD, name: 'Old', cwd: '/w', modifiedAt: '2024-01-01T00:00:00.000Z', messageCount: 1,
  };
  const pendingSummary: SessionSummary = {
    path: PENDING, name: 'Creating', cwd: '/w', modifiedAt: '2024-01-01T00:00:01.000Z', messageCount: 0, isPlaceholder: true,
  };
  let archState: ArchState = {
    ...createInitialArchState(),
    sessions: {
      ...createInitialArchState().sessions,
      sessions: [oldSummary, pendingSummary],
      openTabPaths: [OLD, PENDING],
      activeSessionPath: OLD,
    },
  };
  const getArchState = () => archState;
  const commands: string[] = [];
  const dispatchArch = (event: Event) => {
    if (event.kind === 'Command') commands.push(event.cmd.kind);
    archState = reducer(archState, event).state;
  };
  const state = new SessionServiceState(backend, () => undefined, getArchState, dispatchArch, 0);
  const tabs = new SessionTabActions({
    scheduleRender: () => undefined, runObserver: NOOP_RUN_OBSERVER,
    state, getArchState, dispatchArch,
  });

  tabs.openSession(PENDING);

  assert.equal(archState.sessions.activeSessionPath, PENDING);
  assert.deepEqual(commands, ['SelectSession']);
  assert.equal(state.getSelectionRequest('selection:1'), null);
});

test('openSession -> backend session.open rejection -> handleSelectionFailure restores the pre-open state (e2e through the EffectRunner)', async () => {
  // Glues the whole riskiest chain in one test: optimistic setup (reducer) ->
  // backend RPC rejection (runner) -> handleSelectionFailure (host) -> reducer
  // transitions that undo the setup. The final ArchState must equal the
  // pre-open state (active restored to OLD, opened tab + placeholder gone, a
  // notice surfaced).
  const OLD = '/workspace/old.jsonl';
  const NEW = '/workspace/new.jsonl';
  const oldSummary: SessionSummary = {
    path: OLD, name: 'Old', cwd: '/w', modifiedAt: '2024-01-01T00:00:00.000Z', messageCount: 1,
  };
  let archState: ArchState = {
    ...createInitialArchState(),
    sessions: { ...createInitialArchState().sessions, sessions: [oldSummary], openTabPaths: [OLD], activeSessionPath: OLD },
  };
  const getArchState = () => archState;
  const context = createExtensionContext();

  // A correlated backend rejection is definitive, unlike transport failure.
  const backend: BackendLike = {
    async request<T = unknown>(method: string, _params?: unknown, options?: CommitAwareRequestOptions<T>): Promise<T> {
      if (method === 'session.open') {
        const error = new BackendRpcError('open', method, 'INTERNAL_ERROR', 'boom');
        options?.onCorrelatedResponse?.({ ok: false, error });
        throw error;
      }
      throw new Error(`Unexpected backend request: ${method}`);
    },
  };
  let openCompletion!: Promise<void>;

  // The dispatch loop mirrors extension-host: run the reducer, then execute the
  // emitted effects via the runner. The runner's result dispatch +
  // handleSelectionFailure's recovery dispatches all re-enter here.
  function dispatchArch(event: Event): void {
    const result = reducer(archState, event);
    archState = result.state;
    for (const effect of result.effects) runner.run(effect);
  }

  // SessionServiceState requires the concrete backend type; this test exercises
  // its backend-independent selection path. The runner below uses the mock.
  const state = new SessionServiceState(new BackendClient(), () => undefined, getArchState, dispatchArch, 0);
  const tabs = new SessionTabActions({
    scheduleRender: () => undefined, runObserver: NOOP_RUN_OBSERVER,
    state, getArchState, dispatchArch,
  });

  const { deps } = makeEffectRunnerDeps({
    backend,
    queues: {
      enqueueLifecycle: (task) => {
        const completion = task();
        openCompletion = completion.then(() => undefined);
        return completion;
      },
      enqueueSessionOperation: (_path, task) => task(),
    },
    serviceOverrides: {
      handleSelectionFailure: (token: string, notice: string) => state.handleSelectionFailure(token, notice),
    },
    dispatch: (e: EffectResultEvent) => dispatchArch(e),
  });
  const runner = new EffectRunner(deps);

  tabs.openSession(NEW);

  // Optimistic setup applied synchronously.
  assert.equal(archState.sessions.activeSessionPath, NEW);
  assert.ok(archState.sessions.openTabPaths.includes(NEW));

  // Includes the fresh asynchronous host stat and all recovery dispatches.
  await openCompletion;

  // Final state equals the pre-open state: active restored to OLD, opened
  // tab + placeholder gone, no pending run-summary, a notice surfaced.
  assert.equal(archState.sessions.activeSessionPath, OLD);
  assert.deepEqual(archState.sessions.openTabPaths, [OLD]);
  assert.deepEqual(archState.sessions.sessions, [oldSummary]);
  assert.equal(archState.sessions.openTabPaths.includes(NEW), false);
  assert.equal(NEW in archState.composer.activeRunSummaryBySession, false);
  assert.equal(archState.settings.notice, 'Failed to open session: boom');
});

test('opening a restored tab before backend startup cannot leave a reconciliation lock after preload', async () => {
  const sessionPath = '/workspace/restored.jsonl';
  const summary: SessionSummary = {
    path: sessionPath, name: 'Restored', cwd: '/workspace', modifiedAt: '', messageCount: 1,
  };
  let archState = createInitialArchState();
  archState = { ...archState, sessions: { ...archState.sessions,
    sessions: [summary], openTabPaths: [sessionPath], activeSessionPath: sessionPath,
  } };
  const backend = new BackendClient(); // Real pre-dispatch failure, not a mocked transport timeout.
  const timers: Array<() => void> = [];
  const effects: string[] = [];
  let completion!: Promise<void>;
  const dispatchArch = (event: Event): void => {
    const result = reducer(archState, event);
    archState = result.state;
    for (const effect of result.effects) {
      effects.push(effect.kind);
      runner.run(effect);
    }
  };
  const state = new SessionServiceState(backend, () => undefined, () => archState, dispatchArch, 0);
  state.adoptBackendGeneration(1);
  const tabs = new SessionTabActions({ state, getArchState: () => archState, dispatchArch,
    scheduleRender: () => undefined, runObserver: NOOP_RUN_OBSERVER });
  const { deps } = makeEffectRunnerDeps({
    backend,
    queues: {
      enqueueLifecycle: (task) => {
        const result = task();
        completion = result.then(() => undefined);
        return result;
      },
      enqueueSessionOperation: (_path, task) => task(),
    },
    timer: { schedule: (callback) => { timers.push(callback); return callback; }, cancel: () => undefined },
    serviceOverrides: {
      getBackendGeneration: () => state.getBackendGeneration(),
      handleSelectionFailure: (...args) => state.handleSelectionFailure(...args),
    },
    dispatch: dispatchArch,
    dispatchEvent: dispatchArch,
  });
  const runner = new EffectRunner(deps);
  tabs.openSession(sessionPath);
  await completion;

  // Before the fix these three fake-time polls exhaust recovery against a
  // backend that never received the open. No sleeps or live processes needed.
  for (let poll = 0; poll < 3 && timers.length; poll += 1) {
    timers.shift()!();
    await completion;
  }

  // Startup later succeeds and hydrates this tab in the background, without
  // correlation to the earlier unsent operation (the reported failure pattern).
  dispatchArch({ kind: 'BackendReadyChanged', ready: true });
  dispatchArch({ kind: 'SessionOpened', sessionPath, backendGeneration: 1,
    modelWriteFence: 0, modelHydrationRevision: 0, catalogHydrationRevision: 0,
    payload: {
      session: summary, transcript: [], busy: false, runtimeReady: false,
      transcriptWindow: { totalCount: 0, loadedStart: 0, loadedEnd: 0,
        hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false },
      capabilities: { billableActivity: false, canContinue: true, canInterrupt: false, canCompact: true },
    },
  });
  state.markSessionSnapshotKnown(sessionPath);
  const openCount = effects.filter((kind) => kind === 'OpenSession').length;
  tabs.openSession(sessionPath); // Warm selection must not need another RPC to unlock sending.
  assert.equal(effects.filter((kind) => kind === 'OpenSession').length, openCount);
  assert.equal(projectSessionCapabilities(archState)[sessionPath]?.primaryOperation, undefined);
  assert.equal(projectSessionCapabilities(archState)[sessionPath]?.canContinue, true);
  const operation = Object.values(archState.operations).find((candidate) => candidate.kind === 'session.open')!;
  assert.equal(operation.terminal?.outcome, 'failed', 'a request rejected before dispatch has a definitive outcome');
  assert.equal(operation.commit, 'not-committed');
  assert.equal(effects.includes('ScheduleOpenSessionReconciliation'), false);
  assert.deepEqual(archState.sessions.openTabPaths, [sessionPath], 'startup failure must not remove a restored tab');
});

// Exercise restored Loading tabs through the real ingress/reducer/effect/failure
// chain. Filesystem evidence is fresh, not inferred from a catalog or RPC code.
async function restoredOpen(t: TestContext, options: {
  onlyTab?: boolean;
  error?: Error;
  present?: boolean;
  notDirectory?: boolean;
  correlatedTransportFailure?: boolean;
  fence?: 'running' | 'hidden-running' | 'closing' | 'duplicate' | 'create' | 'message' | 'settled' | 'superseded' | 'epoch' | 'generation';
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pie-restored-open-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const missing = options.notDirectory ? join(directory, 'parent', 'missing.jsonl') : join(directory, 'missing.jsonl');
  if (options.notDirectory) await writeFile(join(directory, 'parent'), '');
  const healthy = join(directory, 'healthy.jsonl');
  if (options.present) await writeFile(missing, '');
  const initial = createInitialArchState();
  let archState: ArchState = {
    ...initial,
    sessions: {
      ...initial.sessions,
      sessions: [
        { path: missing, name: 'Loading...', cwd: directory, modifiedAt: '', messageCount: 0, isPlaceholder: true },
        ...(!options.onlyTab ? [{ path: healthy, name: 'Healthy', cwd: directory, modifiedAt: '', messageCount: 1 }] : []),
      ],
      openTabPaths: options.onlyTab ? [missing] : [missing, healthy],
      pinnedTabPaths: options.onlyTab ? [missing] : [missing, healthy],
      pinnedTabGroups: options.onlyTab ? [] : [[missing, healthy]],
      activeSessionPath: options.onlyTab ? missing : healthy,
    },
  };
  let rejectOpen!: (error: Error) => void;
  let openCompletion!: Promise<void>;
  let started!: () => void;
  const openStarted = new Promise<void>((resolve) => { started = resolve; });
  const backend: BackendLike = {
    request<T = unknown>(method: string, _params?: unknown, requestOptions?: CommitAwareRequestOptions<T>): Promise<T> {
      if (method !== 'session.open') return Promise.reject(new Error(`Unexpected backend request: ${method}`));
      return new Promise<T>((_, reject) => {
        rejectOpen = (error) => {
          // Transport deadlines have no correlated response; backend errors do.
          if (error instanceof BackendRpcError || options.correlatedTransportFailure) {
            requestOptions?.onCorrelatedResponse?.({ ok: false, error });
          }
          reject(error);
        };
        started();
      });
    },
  };
  const dispatchArch = (event: Event) => {
    const result = reducer(archState, event);
    archState = result.state;
    for (const effect of result.effects) runner.run(effect);
  };
  // The state path under test is backend-independent; the runner below uses
  // the request mock while satisfying SessionServiceState's concrete type.
  const state = new SessionServiceState(new BackendClient(), () => undefined, () => archState, dispatchArch, 0);
  const tabs = new SessionTabActions({ state, getArchState: () => archState, dispatchArch,
    scheduleRender: () => undefined, runObserver: NOOP_RUN_OBSERVER });
  const { deps, calls } = makeEffectRunnerDeps({
    backend,
    queues: {
      enqueueLifecycle: (task) => {
        const completion = task();
        openCompletion = completion.then(() => undefined);
        return completion;
      },
      enqueueSessionOperation: (_path, task) => task(),
    },
    timer: { schedule: () => 0, cancel: () => undefined },
    serviceOverrides: {
      handleSelectionFailure: (token, notice, attempt, reason, confirmedMissing) =>
        state.handleSelectionFailure(token, notice, attempt, reason, confirmedMissing),
      getBackendGeneration: () => state.getBackendGeneration(),
    },
    dispatch: dispatchArch,
  });
  const runner = new EffectRunner(deps);
  tabs.openSession(missing);
  await openStarted;
  const open = Object.values(archState.operations).find((operation) => operation.kind === 'session.open')!;
  if (options.fence === 'running') archState.sessions.runningSessionPaths = [missing];
  if (options.fence === 'hidden-running') archState.sessions.intentionallyHiddenRunningPaths = [missing];
  if (options.fence === 'closing') archState.operations.close = {
    ...open, operationId: 'close', kind: 'session.close', causal: { ...open.causal, selectionToken: 'close' },
  };
  if (options.fence === 'duplicate' || options.fence === 'create' || options.fence === 'message') {
    const duplicate = options.fence === 'duplicate';
    archState.operations.other = {
      ...open, operationId: 'other',
      kind: duplicate ? 'session.duplicate' : options.fence === 'create' ? 'session.create' : 'message.send',
      session: duplicate ? { pendingPath: '__pending__:duplicate', sourcePath: missing } : { pendingPath: missing },
      causal: { ...open.causal, selectionToken: 'other' },
    };
  }
  if (options.fence === 'epoch') state.bumpSessionDataEpoch(missing);
  if (options.fence === 'generation') state.adoptBackendGeneration(1);
  if (options.fence === 'settled') dispatchArch({ kind: 'OpenSessionResult', corrId: 'settled',
    sessionPath: missing, operationId: open.operationId, operationAttempt: open.attempt,
    backendGeneration: open.backendGeneration, ok: true, successEvidence: 'snapshot-applied' });
  if (options.fence === 'superseded') {
    state.supersedeSelectionOwnership();
    dispatchArch({ kind: 'Command', cmd: { kind: 'SelectSession', corrId: 'healthy', sessionPath: healthy } });
    dispatchArch({ kind: 'NoticeShown', notice: 'Current notice' });
  }
  rejectOpen(options.error ?? new BackendRpcError('open', 'session.open', 'SESSION_NOT_FOUND', 'missing'));
  await openCompletion;
  return { archState, calls, missing, healthy };
}

test('confirmed missing restored Loading tab is removed, unpinned, ungrouped and persisted with healthy fallback', async (t) => {
  const { archState, calls, missing, healthy } = await restoredOpen(t);
  assert.deepEqual(archState.sessions.openTabPaths, [healthy]);
  assert.equal(archState.sessions.activeSessionPath, healthy);
  assert.equal(archState.sessions.sessions.some((session) => session.path === missing), false);
  assert.deepEqual(archState.sessions.pinnedTabPaths, [healthy]);
  assert.deepEqual(archState.sessions.pinnedTabGroups, []);
  assert.deepEqual(calls.filter((call) => call.kind === 'persistTabs').at(-1), {
    kind: 'persistTabs', openTabPaths: [healthy], active: healthy, pinnedTabPaths: [healthy], pinnedTabGroups: [],
  });
});

test('confirmed missing only restored tab leaves null selection', async (t) => {
  const { archState } = await restoredOpen(t, { onlyTab: true });
  assert.deepEqual(archState.sessions.openTabPaths, []);
  assert.equal(archState.sessions.activeSessionPath, null);
});

test('ENOTDIR host confirmation also removes a missing restored tab', async (t) => {
  const { archState, healthy } = await restoredOpen(t, { notDirectory: true });
  assert.deepEqual(archState.sessions.openTabPaths, [healthy]);
});

test('a definitive generic RPC rejection still needs fresh host absence evidence', async (t) => {
  const { archState, healthy } = await restoredOpen(t, {
    error: new BackendRpcError('open', 'session.open', 'INTERNAL_ERROR', 'open failed'),
  });
  assert.deepEqual(archState.sessions.openTabPaths, [healthy]);
});

for (const [label, options] of [
  ['EACCES', { error: new BackendRpcError('open', 'session.open', 'EACCES', 'denied') }],
  ['forgetting an existing file', { present: true }],
  ['transport failure', { error: new Error('transport failed') }],
  ['correlated transport failure', { error: new Error('transport failed'), correlatedTransportFailure: true }],
  ['timeout', { error: new RequestTimeoutError('open') }],
  ...(['running', 'hidden-running', 'closing', 'duplicate', 'create', 'message', 'settled', 'epoch', 'generation'] as const)
    .map((fence) => [fence, { fence }] as const),
] as const) {
  test(`restored Loading tab is retained after ${label}`, async (t) => {
    const { archState, missing } = await restoredOpen(t, options);
    assert.ok(archState.sessions.openTabPaths.includes(missing));
    assert.ok(archState.sessions.sessions.some((session) => session.path === missing));
    if (label === 'transport failure' || label === 'correlated transport failure' || label === 'timeout') {
      const operation = Object.values(archState.operations).find((candidate) => candidate.kind === 'session.open')!;
      assert.equal(operation.phase, 'ambiguous');
      assert.equal(operation.terminal, undefined);
      assert.equal(archState.sessions.activeSessionPath, missing);
      assert.equal(archState.settings.notice, null);
    }
    if (label === 'settled') {
      assert.equal(archState.sessions.activeSessionPath, missing);
      assert.equal(archState.settings.notice, null);
      assert.equal(Object.values(archState.operations).find((operation) => operation.kind === 'session.open')?.terminal?.outcome, 'settled');
    }
  });
}

test('superseded confirmed missing failure cannot take focus or notice from healthy selection', async (t) => {
  const { archState, healthy } = await restoredOpen(t, { fence: 'superseded' });
  assert.equal(archState.sessions.activeSessionPath, healthy);
  assert.equal(archState.settings.notice, 'Current notice');
});
