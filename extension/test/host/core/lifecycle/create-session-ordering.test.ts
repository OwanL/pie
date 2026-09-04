/**
 * Integration test pinning the critical ordering invariant of the createSession
 * migration: `beginSelectionRequest` must run BEFORE the reducer optimistically
 * activates the pending tab, so the selection request snapshots the *previous*
 * active path. `handleSelectionFailure` uses that snapshot to restore the
 * previously-active tab on failure — if `beginSelectionRequest` ran after the
 * reducer set `activeSessionPath = pending`, it would snapshot the pending path
 * and recovery would select the wrong tab.
 *
 * Uses the real `SessionServiceState` + `SessionTabActions` (timeout disabled
 * to avoid a 60s timer leak); `dispatchArch` runs the real reducer so the
 * optimistic setup is applied synchronously before `createNewSession()` returns.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { NOOP_RUN_OBSERVER } from '../../../../src/host/stats-service';
import { createInitialArchState } from '../../../../src/host/core/arch-state';
import type { ArchState } from '../../../../src/host/core/arch-state';
import { reducer } from '../../../../src/host/core/reducer';
import { SessionServiceState } from '../../../../src/host/session-service/state';
import { SessionTabActions } from '../../../../src/host/session-service/tab-actions';
import { applySessionOpenedPayload } from '../../../../src/host/session-service/handlers/attach';
import type { SessionOpenedPayload, SessionSummary } from '../../../../src/shared/protocol';
import { EffectRunner, type EffectRunnerDeps } from '../../../../src/host/core/effect-runner';
import type { Event, EffectResultEvent } from '../../../../src/host/core/events';
import { makeEffectRunnerDeps } from '../../../helpers/effect-runner-deps';
import { RequestTimeoutError } from '../../../../src/shared/request-tracker';

function createExtensionContext(): any {
  return {
    globalState: { update: async () => undefined },
    workspaceState: { update: async () => undefined },
  };
}

test('createNewSession mints the selection token before the reducer activates the pending tab (previousActivePath is the old active)', () => {
  const backend = { request: async () => ({}) } as any;
  const context = createExtensionContext();
  const OLD = '/workspace/old.jsonl';
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
  let capturedOperationId: string | undefined;
  const dispatchArch = (event: Event) => {
    if (event.kind === 'Command' && event.cmd.kind === 'CreateSession') {
      capturedToken = event.cmd.selectionToken;
      capturedOperationId = event.cmd.operationId;
    }
    archState = reducer(archState, event).state;
  };

  // timeout = 0 → armSelectionRequestTimeout is a no-op (no 60s timer leak).
  const state = new SessionServiceState(context, backend, () => undefined, getArchState, dispatchArch, 0);
  const tabs = new SessionTabActions({
    context,
    scheduleRender: () => undefined,
    runObserver: NOOP_RUN_OBSERVER,
    state,
    getArchState,
    dispatchArch,
  });

  const pendingPath = tabs.createNewSession();

  // The reducer activated the pending tab (optimistic setup applied
  // synchronously during the Command dispatch).
  assert.equal(archState.sessions.activeSessionPath, pendingPath);
  assert.ok(archState.sessions.openTabPaths.includes(pendingPath));

  // The selection request snapshotted the OLD active path — NOT the pending
  // path — because beginSelectionRequest ran before the Command dispatch. This
  // is what lets handleSelectionFailure restore the previous active tab on
  // failure. (If beginSelectionRequest ran after the reducer set active =
  // pending, previousActivePath would equal pendingPath — a recovery bug.)
  const request = state.getSelectionRequest(capturedToken);
  assert.ok(request, 'a selection request was registered for the create');
  assert.equal(request?.previousActivePath, OLD);
  assert.notEqual(request?.previousActivePath, pendingPath);

  // Request-start fences are captured per attempt, after lifecycle queue wait.
  archState = { ...archState, settings: { ...archState.settings, modelWriteFence: 1 } };
  state.captureSelectionRequestStart(capturedToken!, 1);

  // A definitive error from the timed-out attempt must not roll back the newer
  // retry that shares the operation identity and selection token.
  state.handleCreateOperationDelayed(capturedToken!, capturedOperationId!, 'delayed', 1);
  assert.equal(tabs.retryCreateSession(capturedOperationId!), true);
  archState = { ...archState, settings: { ...archState.settings, modelWriteFence: 2 } };
  state.captureSelectionRequestStart(capturedToken!, 2);
  const requestFences = state.getSelectionRequest(capturedToken!)?.modelFencesByOperationAttempt;
  assert.equal(requestFences?.[1]?.modelWriteFence, 1);
  assert.equal(requestFences?.[2]?.modelWriteFence, 2);
  state.handleSelectionFailure(capturedToken!, 'stale failure', 1);
  assert.equal(archState.sessions.openTabPaths.includes(pendingPath), true);
  assert.equal(archState.operations[capturedOperationId!]?.phase, 'awaiting-acceptance');

  // A correlated success is authoritative even if session.opened publication
  // never arrives after the backend's durable commit point.
  const acknowledgedPath = '/workspace/acknowledged.jsonl';
  assert.equal(
    state.handleCreateOperationAcknowledged(capturedToken!, capturedOperationId!, acknowledgedPath),
    pendingPath,
  );
  assert.equal(archState.operations[capturedOperationId!]?.terminal?.outcome, 'settled');
  assert.equal(archState.sessions.openTabPaths.includes(acknowledgedPath), true);
  assert.equal(archState.sessions.sessions.some((summary) => summary.path === acknowledgedPath), true);
  assert.equal(archState.sessions.activeSessionPath, acknowledgedPath);
  assert.ok(state.getSelectionRequest(capturedToken!), 'request-start fences remain for a trailing session.opened');
  assert.equal(
    state.handleCreateOperationAcknowledged(capturedToken!, capturedOperationId!, acknowledgedPath),
    undefined,
    'duplicate acknowledgement is a no-op',
  );

  archState = {
    ...archState,
    settings: {
      ...archState.settings,
      modelSettings: { defaultModel: 'newer-model', defaultThinkingLevel: 'high' },
    },
  };
  applySessionOpenedPayload({
    operationId: capturedOperationId,
    operationAttempt: 1,
    selectionToken: capturedToken,
    session: { path: acknowledgedPath, name: 'Acknowledged', cwd: '/w', modifiedAt: '2026-01-01T00:00:00.000Z', messageCount: 0 },
    transcript: [],
    transcriptWindow: { totalCount: 0, loadedStart: 0, loadedEnd: 0, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false },
    busy: false,
    modelSettings: { defaultModel: 'attempt-1-stale', defaultThinkingLevel: 'low' },
  }, {
    getArchState, dispatchArch, runObserver: NOOP_RUN_OBSERVER,
    scheduleRender: () => undefined, context, state,
  });
  assert.equal(archState.settings.modelSettings?.defaultModel, 'newer-model');
  assert.equal(state.getSelectionRequest(capturedToken!), null, 'trailing publication settles the waiter');
});

test('late session.opened reconciles a timed-out create exactly once and a late ack is a no-op', () => {
  const OLD = '/workspace/old.jsonl';
  const oldSummary: SessionSummary = {
    path: OLD, name: 'Old', cwd: '/w', modifiedAt: '2024-01-01T00:00:00.000Z', messageCount: 1,
  };
  let archState: ArchState = {
    ...createInitialArchState(),
    sessions: { ...createInitialArchState().sessions, sessions: [oldSummary], openTabPaths: [OLD], activeSessionPath: OLD },
  };
  const context = createExtensionContext();
  const backend = { request: async () => ({}) } as any;
  const getArchState = () => archState;
  const dispatchedEffects: unknown[] = [];
  let operationId: string | undefined;
  let selectionToken: string | undefined;
  let replacements = 0;
  const dispatchArch = (event: Event): void => {
    if (event.kind === 'Command' && event.cmd.kind === 'CreateSession') {
      operationId = event.cmd.operationId;
      selectionToken = event.cmd.selectionToken;
    }
    const result = reducer(archState, event);
    archState = result.state;
    dispatchedEffects.push(...result.effects);
  };
  const state = new SessionServiceState(context, backend, () => undefined, getArchState, dispatchArch, 0);
  const tabs = new SessionTabActions({
    context, scheduleRender: () => undefined, runObserver: {
      ...NOOP_RUN_OBSERVER,
      replaceSessionPath: () => { replacements += 1; },
    }, state, getArchState, dispatchArch,
  });
  const pendingPath = tabs.createNewSession();
  assert.ok(operationId && selectionToken);
  archState = {
    ...archState,
    pending: {
      ...archState.pending,
      sendQueueBySession: {
        [pendingPath]: [{
          corrId: 'queued-1', text: 'queued', inputs: [], composedText: 'queued',
          localId: 'local-1', previousSummary: null, timestamp: 1,
        }],
      },
    },
  };
  state.handleCreateOperationDelayed(selectionToken!, operationId!, 'still creating');
  assert.equal(archState.operations[operationId!]?.phase, 'ambiguous');

  const resolvedPath = '/workspace/resolved.jsonl';
  const payload: SessionOpenedPayload = {
    operationId,
    selectionToken,
    session: { path: resolvedPath, name: 'Resolved', cwd: '/w', modifiedAt: '2026-01-01T00:00:00.000Z', messageCount: 0 },
    transcript: [],
    transcriptWindow: { totalCount: 0, loadedStart: 0, loadedEnd: 0, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false },
    busy: false,
  };
  const deps = {
    getArchState, dispatchArch, runObserver: {
      ...NOOP_RUN_OBSERVER,
      replaceSessionPath: () => { replacements += 1; },
    }, scheduleRender: () => undefined, context, state,
  };
  applySessionOpenedPayload(payload, deps);
  assert.equal(archState.operations[operationId!]?.terminal?.outcome, 'settled');
  assert.deepEqual(archState.sessions.openTabPaths, [OLD, resolvedPath]);
  assert.equal(archState.sessions.activeSessionPath, resolvedPath);
  assert.equal(replacements, 1);
  assert.equal(dispatchedEffects.filter((effect: any) => effect.kind === 'DrainPendingSendQueue').length, 1);

  // Duplicate event delivery and the late RPC acknowledgement must not repeat
  // path replacement, queue drain, or selection.
  applySessionOpenedPayload(payload, deps);
  dispatchArch({ kind: 'CreateSessionResult', corrId: 'late-ack', operationId, sessionPath: resolvedPath, ok: true });
  assert.deepEqual(archState.sessions.openTabPaths, [OLD, resolvedPath]);
  assert.equal(archState.sessions.activeSessionPath, resolvedPath);
  assert.equal(replacements, 1);
  assert.equal(dispatchedEffects.filter((effect: any) => effect.kind === 'DrainPendingSendQueue').length, 1);
});

test('a hidden delayed create resolves late without reopening or focusing its tab', () => {
  const OLD = '/workspace/old-hidden.jsonl';
  let archState: ArchState = {
    ...createInitialArchState(),
    sessions: {
      ...createInitialArchState().sessions,
      sessions: [{ path: OLD, name: 'Old', cwd: '/w', modifiedAt: '2024-01-01T00:00:00.000Z', messageCount: 1 }],
      openTabPaths: [OLD], activeSessionPath: OLD,
    },
  };
  const context = createExtensionContext();
  const getArchState = () => archState;
  const effects: any[] = [];
  let operationId: string | undefined;
  let selectionToken: string | undefined;
  const dispatchArch = (event: Event): void => {
    if (event.kind === 'Command' && event.cmd.kind === 'CreateSession') {
      operationId = event.cmd.operationId;
      selectionToken = event.cmd.selectionToken;
    }
    const result = reducer(archState, event);
    archState = result.state;
    effects.push(...result.effects);
  };
  const state = new SessionServiceState(context, { request: async () => ({}) } as any, () => undefined, getArchState, dispatchArch, 0);
  const tabs = new SessionTabActions({
    context, scheduleRender: () => undefined, runObserver: NOOP_RUN_OBSERVER,
    state, getArchState, dispatchArch,
  });
  const pendingPath = tabs.createNewSession();
  state.handleCreateOperationDelayed(selectionToken!, operationId!, 'still creating');
  archState = {
    ...archState,
    pending: {
      ...archState.pending,
      sendQueueBySession: {
        [pendingPath]: [{ corrId: 'queued-hidden', text: 'queued', inputs: [], composedText: 'queued', localId: 'local-hidden', previousSummary: null, timestamp: 1 }],
      },
    },
  };
  dispatchArch({ kind: 'Command', cmd: { kind: 'CloseSession', corrId: 'hide', sessionPath: pendingPath } });
  const resolvedPath = '/workspace/hidden-resolved.jsonl';
  applySessionOpenedPayload({
    operationId, selectionToken,
    session: { path: resolvedPath, name: 'Resolved', cwd: '/w', modifiedAt: '2026-01-01T00:00:00.000Z', messageCount: 0 },
    transcript: [],
    transcriptWindow: { totalCount: 0, loadedStart: 0, loadedEnd: 0, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false },
    busy: false,
  }, {
    getArchState, dispatchArch, runObserver: NOOP_RUN_OBSERVER,
    scheduleRender: () => undefined, context, state,
  });
  assert.equal(archState.operations[operationId!]?.terminal?.outcome, 'settled');
  assert.equal(archState.sessions.openTabPaths.includes(pendingPath), false);
  assert.equal(archState.sessions.openTabPaths.includes(resolvedPath), false);
  assert.equal(archState.sessions.activeSessionPath, OLD);
  assert.equal(effects.filter((effect) => effect.kind === 'DrainPendingSendQueue').length, 1);
  assert.deepEqual(archState.sessions.intentionallyHiddenRunningPaths, [resolvedPath]);
  const beforeFirstRun = archState;

  // When the drained send starts, hidden intent survives BusyChanged(true)
  // (and therefore renderer-ready repair) but is pruned on terminal cleanup.
  dispatchArch({ kind: 'BusyChanged', sessionPath: resolvedPath, running: true });
  assert.deepEqual(archState.sessions.intentionallyHiddenRunningPaths, [resolvedPath]);
  dispatchArch({ kind: 'BusyChanged', sessionPath: resolvedPath, running: false });
  assert.deepEqual(archState.sessions.intentionallyHiddenRunningPaths, []);

  // A first-run pre-ack failure is terminal too; it must not strand a
  // running-only hide marker when no busy(false) event will arrive.
  archState = beforeFirstRun;
  dispatchArch({
    kind: 'Command',
    cmd: {
      kind: 'Send', corrId: 'queued-hidden', sessionPath: resolvedPath,
      text: 'queued', inputs: [], composedText: 'queued', localId: 'local-hidden',
      previousSummary: null, timestamp: 1,
    },
  });
  assert.deepEqual(archState.sessions.intentionallyHiddenRunningPaths, [resolvedPath]);
  dispatchArch({
    kind: 'Command',
    cmd: {
      kind: 'Send', corrId: 'queued-hidden-2', sessionPath: resolvedPath,
      text: 'queued 2', inputs: [], composedText: 'queued 2', localId: 'local-hidden-2',
      previousSummary: null, timestamp: 2,
    },
  });
  dispatchArch({
    kind: 'SendResult', corrId: 'queued-hidden', sessionPath: resolvedPath,
    ok: false, error: 'first send failed',
  });
  assert.deepEqual(
    archState.sessions.intentionallyHiddenRunningPaths,
    [resolvedPath],
    'another drained send still owns the hidden first-run intent',
  );
  dispatchArch({
    kind: 'SendResult', corrId: 'queued-hidden-2', sessionPath: resolvedPath,
    ok: false, error: 'second send failed',
  });
  assert.deepEqual(archState.sessions.intentionallyHiddenRunningPaths, []);
});

test('backend-generation death is the definitive cleanup path for a delayed create', () => {
  const OLD = '/workspace/old-generation.jsonl';
  let archState: ArchState = {
    ...createInitialArchState(),
    sessions: {
      ...createInitialArchState().sessions,
      sessions: [{ path: OLD, name: 'Old', cwd: '/w', modifiedAt: '2024-01-01T00:00:00.000Z', messageCount: 1 }],
      openTabPaths: [OLD], activeSessionPath: OLD,
    },
  };
  const context = createExtensionContext();
  const getArchState = () => archState;
  let operationId: string | undefined;
  let selectionToken: string | undefined;
  const dispatchArch = (event: Event): void => {
    if (event.kind === 'Command' && event.cmd.kind === 'CreateSession') {
      operationId = event.cmd.operationId;
      selectionToken = event.cmd.selectionToken;
    }
    archState = reducer(archState, event).state;
  };
  const state = new SessionServiceState(context, { request: async () => ({}) } as any, () => undefined, getArchState, dispatchArch, 0);
  const tabs = new SessionTabActions({
    context, scheduleRender: () => undefined, runObserver: NOOP_RUN_OBSERVER,
    state, getArchState, dispatchArch,
  });
  const pendingPath = tabs.createNewSession();
  state.handleCreateOperationDelayed(selectionToken!, operationId!, 'still creating');
  state.failPendingCreateOperations('PI backend stopped');
  assert.equal(archState.operations[operationId!]?.terminal?.outcome, 'failed');
  assert.equal(archState.sessions.openTabPaths.includes(pendingPath), false);
  assert.equal(archState.sessions.activeSessionPath, OLD);
  assert.equal(state.getSelectionRequest(selectionToken!), null);
});

test('operational incidents are claimed once per backend generation', () => {
  let archState = createInitialArchState();
  const state = new SessionServiceState(
    createExtensionContext(), { request: async () => ({}) } as any, () => undefined,
    () => archState,
    (event) => { archState = reducer(archState, event).state; },
    0,
  );
  assert.equal(state.claimOperationalIncident('incident-1', 'req-1'), true);
  assert.equal(state.claimOperationalIncident('incident-1', 'req-1'), false);
  const generation = state.getBackendGeneration();
  state.resetRuntimeState({ advanceBackendGeneration: false });
  assert.equal(state.getBackendGeneration(), generation, 'process exit cleanup does not pre-increment replacement generation');
  state.resetRuntimeState();
  assert.equal(state.getBackendGeneration(), generation + 1, 'replacement startup advances exactly once');
  assert.equal(state.claimOperationalIncident('incident-1', 'req-1'), true);
});

test('only the typed transport deadline classifies create as delayed', async () => {
  const dispatched: EffectResultEvent[] = [];
  const delayed: unknown[][] = [];
  const ordering: string[] = [];
  const backend = { request: async () => {
    ordering.push('request');
    throw new RequestTimeoutError('req-timeout');
  } } as any;
  const { deps } = makeEffectRunnerDeps({
    backend,
    serviceOverrides: {
      captureSelectionRequestStart: (token: string, attempt?: number) => {
        ordering.push(`capture:${token}:${attempt}`);
      },
      handleCreateOperationDelayed: (...args: unknown[]) => { delayed.push(args); },
    },
    dispatch: (event) => dispatched.push(event),
  });
  new EffectRunner(deps).run({
    kind: 'CreateSession', corrId: 'create-timeout', sessionPath: 'pending:new', cwd: '/w',
    selectionToken: 'selection-timeout', operationId: 'operation-timeout', operationAttempt: 1,
  });
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(delayed.length, 1);
  assert.deepEqual(ordering, ['capture:selection-timeout:1', 'request']);
  assert.equal((dispatched[0] as Extract<EffectResultEvent, { kind: 'CreateSessionResult' }>).operationId, 'operation-timeout');
  assert.equal((dispatched[0] as Extract<EffectResultEvent, { kind: 'CreateSessionResult' }>).ok, false);
});

test('a backend failure merely mentioning timeout is definitive and restores pre-create state', async () => {
  // Glues the whole riskiest chain in one test: optimistic setup (reducer) →
  // backend RPC rejection (runner) → handleSelectionFailure (host) → reducer
  // transitions that undo the setup. The final ArchState must equal the
  // pre-create state (active restored to OLD, pending tab+summary gone, no
  // run-summary, a notice surfaced).
  const OLD = '/workspace/old.jsonl';
  const oldSummary: SessionSummary = {
    path: OLD, name: 'Old', cwd: '/w', modifiedAt: '2024-01-01T00:00:00.000Z', messageCount: 1,
  };
  let archState: ArchState = {
    ...createInitialArchState(),
    sessions: { ...createInitialArchState().sessions, sessions: [oldSummary], openTabPaths: [OLD], activeSessionPath: OLD },
  };
  const getArchState = () => archState;
  const context = createExtensionContext();

  // Backend rejects session.create; everything else resolves.
  const backend = {
    request: async (method: string): Promise<unknown> => {
      if (method === 'session.create') throw new Error('Timed out waiting for response to req-not-a-transport-timeout');
      return {};
    },
  } as any;

  // The dispatch loop mirrors extension-host: run the reducer, then execute the
  // emitted effects via the runner. The runner's result dispatch +
  // handleSelectionFailure's recovery dispatches all re-enter here.
  function dispatchArch(event: Event): void {
    const result = reducer(archState, event);
    archState = result.state;
    for (const effect of result.effects) runner.run(effect);
  }

  const state = new SessionServiceState(context, backend, () => undefined, getArchState, dispatchArch, 0);
  const tabs = new SessionTabActions({
    context, scheduleRender: () => undefined, runObserver: NOOP_RUN_OBSERVER,
    state, getArchState, dispatchArch,
  });

  const { deps } = makeEffectRunnerDeps({
    backend,
    serviceOverrides: {
      handleSelectionFailure: (token: string, notice: string) => state.handleSelectionFailure(token, notice),
    },
    dispatch: (e: EffectResultEvent) => dispatchArch(e),
  });
  const runner = new EffectRunner(deps);

  const pendingPath = tabs.createNewSession();

  // Optimistic setup applied synchronously.
  assert.equal(archState.sessions.activeSessionPath, pendingPath);
  assert.ok(archState.sessions.openTabPaths.includes(pendingPath));

  // Drain microtasks: backend rejection → handleSelectionFailure → recovery dispatches.
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));

  // Final state equals the pre-create state: active restored to OLD, pending
  // tab + summary gone, no pending run-summary, a notice surfaced.
  assert.equal(archState.sessions.activeSessionPath, OLD);
  assert.deepEqual(archState.sessions.openTabPaths, [OLD]);
  assert.deepEqual(archState.sessions.sessions, [oldSummary]);
  assert.equal(archState.sessions.openTabPaths.includes(pendingPath), false);
  assert.equal(pendingPath in archState.composer.activeRunSummaryBySession, false);
  assert.equal(
    archState.settings.notice,
    'Failed to create session: Timed out waiting for response to req-not-a-transport-timeout',
  );
});

test('SDK replacement publication atomically rekeys and activates the selected source tab without reusing operation identity', () => {
  const source = '/workspace/source.jsonl';
  const destination = '/workspace/destination.jsonl';
  let archState: ArchState = {
    ...createInitialArchState(),
    sessions: {
      ...createInitialArchState().sessions,
      sessions: [{ path: source, name: 'Source', cwd: '/w', modifiedAt: '2026-01-01T00:00:00.000Z', messageCount: 1 }],
      openTabPaths: [source],
      activeSessionPath: source,
    },
  };
  const context = createExtensionContext();
  const backend = { request: async () => ({}) } as any;
  const getArchState = () => archState;
  const dispatchArch = (event: Event): void => { archState = reducer(archState, event).state; };
  const state = new SessionServiceState(context, backend, () => undefined, getArchState, dispatchArch, 0);

  const payload: SessionOpenedPayload = {
    replacesSessionPath: source,
    session: { path: destination, name: 'Destination', cwd: '/new', modifiedAt: '2026-01-02T00:00:00.000Z', messageCount: 0 },
    transcript: [],
    transcriptWindow: { totalCount: 0, loadedStart: 0, loadedEnd: 0, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false },
    busy: false,
    runtimeReady: true,
    systemPrompts: [{ id: 'harness', source: 'harness', title: 'Harness', text: 'destination prompt', summary: 'destination', availability: 'available' }],
  };
  assert.equal(payload.selectionToken, undefined);
  assert.equal(payload.operationId, undefined);
  applySessionOpenedPayload(payload, {
    getArchState,
    dispatchArch,
    runObserver: NOOP_RUN_OBSERVER,
    scheduleRender: () => undefined,
    context,
    state,
  });

  assert.deepEqual(archState.sessions.openTabPaths, [destination]);
  assert.equal(archState.sessions.activeSessionPath, destination);
  assert.equal(archState.sessions.sessions.some((summary) => summary.path === source), false);
  assert.equal(archState.sessions.sessions.some((summary) => summary.path === destination), true);
  assert.equal(archState.transcript.systemPromptsBySession[destination]?.[0]?.text, 'destination prompt');
});