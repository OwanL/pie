import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendClient } from '../../agent-connection/client';
import { createInitialArchState } from '../../conversation-state/arch-state';
import { reducer } from '../../conversation-state/reducer';
import { EffectRunner } from '../../conversation-state/effects/effect-runner';
import { NOOP_RUN_OBSERVER } from '../../analytics-views';
import { SessionServiceState } from '../../session-actions/state';
import { applySessionOpenedPayload } from '../../session-actions/handlers/attach';
import { onOperationalError } from '../../session-actions/handlers/session';
import { makeEffectRunnerDeps } from '../helpers/effect-runner-deps';
import type { Event } from '../../conversation-state/events';
import type { OperationalErrorPayload, SessionOpenedPayload } from '../../../lib/protocol/index.js';

const A = '/workspace/a.jsonl';
const B = '/workspace/b.jsonl';
function fixture() {
  let arch = createInitialArchState();
  arch.sessions.openTabPaths = [A, B];
  arch.sessions.activeSessionPath = A;
  const dispatchArch = (event: Event) => { arch = reducer(arch, event).state; };
  const state = new SessionServiceState(new BackendClient(), () => {}, () => arch, dispatchArch, 0);
  const deps = {
    state, dispatchArch, getArchState: () => arch, scheduleRender: () => {},
    runObserver: NOOP_RUN_OBSERVER,
    platform: {} as Parameters<typeof onOperationalError>[1]['platform'],
    requireEventSessionPath: (_name: string, sessionPath?: string) => sessionPath ?? null,
  };
  const open = (path = A, extra: Partial<SessionOpenedPayload> = {}) => applySessionOpenedPayload({
    session: { path, name: 'Session', cwd: '/workspace', modifiedAt: new Date(0).toISOString(), messageCount: 0 },
    transcript: [], busy: false,
    transcriptWindow: { totalCount: 0, loadedStart: 0, loadedEnd: 0, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false },
    runtimeReady: true, ...extra,
  }, deps);
  const loss = (extra: Partial<OperationalErrorPayload> = {}) => onOperationalError({
    sessionPath: A, code: 'SESSION_WORKER_EXITED', certainty: 'definitive',
    incidentId: 'exit-a', severity: 'error', phase: 'runtime', message: 'Worker exited',
    recovery: { retry: false, restart: false, showLogs: true }, ...extra,
  } as OperationalErrorPayload, deps);
  const rejectCreate = () => {
    arch = { ...arch, operations: { ...arch.operations, create: {
      kind: 'session.create', operationId: 'create',
      causal: { selectionToken: 'owner' }, session: { pendingPath: 'pending:new' },
      terminal: { outcome: 'failed' },
    } as unknown as typeof arch.operations[string] } };
  };
  return { state, deps, open, loss, rejectCreate };
}

test('definitive worker loss clears only its runtime hint, preserves snapshot, and dedupes after replacement', () => {
  const f = fixture();
  f.open(); f.open(B);
  f.loss();
  assert.equal(f.state.isSessionRuntimeKnown(A), false);
  assert.equal(f.state.isSessionSnapshotKnown(A), true);
  assert.equal(f.state.isSessionRuntimeKnown(B), true);
  f.open();
  f.loss();
  assert.equal(f.state.isSessionRuntimeKnown(A), true);
});

test('ambiguous worker loss and generic operational errors do not clear readiness', () => {
  const f = fixture(); f.open();
  f.loss({ certainty: 'ambiguous', incidentId: 'ambiguous' });
  f.loss({ code: 'OTHER_ERROR', incidentId: 'generic' });
  assert.equal(f.state.isSessionRuntimeKnown(A), true);
});

test('authoritative cold attach clears runtime only; legacy omission still marks ready', () => {
  const f = fixture(); f.open(); f.open(B);
  f.open(A, { runtimeReady: false });
  assert.equal(f.state.isSessionRuntimeKnown(A), false);
  assert.equal(f.state.isSessionSnapshotKnown(A), true);
  assert.equal(f.state.isSessionRuntimeKnown(B), true);
  f.open(A, { runtimeReady: undefined });
  assert.equal(f.state.isSessionRuntimeKnown(A), true);
});

test('data-epoch stale cold attach cannot clear a fresh runtime hint', () => {
  const f = fixture(); f.open();
  const selectionToken = f.state.beginSelectionRequest(A, undefined, true, false, 0);
  f.state.bumpSessionDataEpoch(A);
  f.open(A, { runtimeReady: false, selectionToken });
  assert.equal(f.state.isSessionRuntimeKnown(A), true);
});

test('rejected create cold attach cannot clear a fresh runtime hint', () => {
  const f = fixture(); f.open();
  f.rejectCreate();
  f.open(A, { runtimeReady: false, operationId: 'create', selectionToken: 'wrong' });
  assert.equal(f.state.isSessionRuntimeKnown(A), true);
});

test('actual EffectRunner reads readiness after hot attach then loss for send and continue budgets', async () => {
  const f = fixture(); f.open(); f.open(B);
  const observed: Array<{ path: string; budget: number }> = [];
  const { deps } = makeEffectRunnerDeps({
    backend: {
      async request<T>(_method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<T> {
        observed.push({ path: (params as { sessionPath: string }).sessionPath, budget: options?.timeoutMs ?? 10_000 });
        return { requestId: `request-${observed.length}` } as T;
      },
    },
    serviceOverrides: { isSessionRuntimeReady: (path) => f.state.isSessionRuntimeKnown(path) },
  });
  const runner = new EffectRunner(deps);
  try {
    f.loss();
    runner.run({ kind: 'SendRpc', corrId: 'send-a', operationId: 'send-a', backendGeneration: 0, sessionPath: A, text: 'hi', inputs: [], composedText: 'hi', localId: 'local-a' });
    runner.run({ kind: 'ContinueRpc', corrId: 'continue-a', sessionPath: A });
    runner.run({ kind: 'SendRpc', corrId: 'send-b', operationId: 'send-b', backendGeneration: 0, sessionPath: B, text: 'hi', inputs: [], composedText: 'hi', localId: 'local-b' });
    runner.run({ kind: 'ContinueRpc', corrId: 'continue-b', sessionPath: B });
    for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(observed.filter((entry) => entry.path === A).map((entry) => entry.budget), [120_000, 120_000]);
    assert.deepEqual(observed.filter((entry) => entry.path === B).map((entry) => entry.budget), [10_000, 10_000]);
  } finally { runner.dispose(); }
});
