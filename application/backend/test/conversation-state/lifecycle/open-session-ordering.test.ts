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
import { BackendRpcError } from '../../../agent-connection/client';
import { RequestTimeoutError } from '../../../agent-connection/request-tracker';
import assert from 'node:assert/strict';

import { NOOP_RUN_OBSERVER } from '../../../analytics-views';
import { createInitialArchState } from '../../../conversation-state/arch-state';
import type { ArchState } from '../../../conversation-state/arch-state';
import { reducer } from '../../../conversation-state/reducer';
import { SessionServiceState } from '../../../session-actions/state';
import { SessionTabActions } from '../../../session-actions/tab-actions';
import type { SessionSummary } from '../../../../lib/protocol/index.js';
import { EffectRunner, type EffectRunnerDeps } from '../../../conversation-state/effects/effect-runner';
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

  // Backend rejects session.open; everything else resolves.
  const backend = {
    request: async (method: string): Promise<unknown> => {
      if (method === 'session.open') throw new Error('boom');
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

  const state = new SessionServiceState(backend, () => undefined, getArchState, dispatchArch, 0);
  const tabs = new SessionTabActions({
    scheduleRender: () => undefined, runObserver: NOOP_RUN_OBSERVER,
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

  tabs.openSession(NEW);

  // Optimistic setup applied synchronously.
  assert.equal(archState.sessions.activeSessionPath, NEW);
  assert.ok(archState.sessions.openTabPaths.includes(NEW));

  // Drain microtasks: backend rejection -> handleSelectionFailure -> recovery dispatches.
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));

  // Final state equals the pre-open state: active restored to OLD, opened
  // tab + placeholder gone, no pending run-summary, a notice surfaced.
  assert.equal(archState.sessions.activeSessionPath, OLD);
  assert.deepEqual(archState.sessions.openTabPaths, [OLD]);
  assert.deepEqual(archState.sessions.sessions, [oldSummary]);
  assert.equal(archState.sessions.openTabPaths.includes(NEW), false);
  assert.equal(NEW in archState.composer.activeRunSummaryBySession, false);
  assert.equal(archState.settings.notice, 'Failed to open session: boom');
});

// Exercise restored Loading tabs through the real ingress/reducer/effect/failure
// chain. Filesystem evidence is fresh, not inferred from a catalog or RPC code.
async function restoredOpen(t: TestContext, options: {
  onlyTab?: boolean;
  error?: Error;
  present?: boolean;
  notDirectory?: boolean;
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
  const backend = { request: (method: string) => method === 'session.open'
    ? new Promise((_, reject) => { rejectOpen = reject; }) : Promise.resolve({}) } as any;
  const dispatchArch = (event: Event) => {
    const result = reducer(archState, event);
    archState = result.state;
    for (const effect of result.effects) runner.run(effect);
  };
  const state = new SessionServiceState(backend, () => undefined, () => archState, dispatchArch, 0);
  const tabs = new SessionTabActions({ state, getArchState: () => archState, dispatchArch,
    scheduleRender: () => undefined, runObserver: NOOP_RUN_OBSERVER });
  const { deps, calls } = makeEffectRunnerDeps({
    backend,
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
  for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve));
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
    backendGeneration: open.backendGeneration, ok: true });
  if (options.fence === 'superseded') {
    state.supersedeSelectionOwnership();
    dispatchArch({ kind: 'Command', cmd: { kind: 'SelectSession', corrId: 'healthy', sessionPath: healthy } });
    dispatchArch({ kind: 'NoticeShown', notice: 'Current notice' });
  }
  rejectOpen(options.error ?? new BackendRpcError('open', 'session.open', 'SESSION_NOT_FOUND', 'missing'));
  for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
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
  ['timeout', { error: new RequestTimeoutError('open') }],
  ...(['running', 'hidden-running', 'closing', 'duplicate', 'create', 'message', 'settled', 'epoch', 'generation'] as const)
    .map((fence) => [fence, { fence }] as const),
] as const) {
  test(`restored Loading tab is retained after ${label}`, async (t) => {
    const { archState, missing } = await restoredOpen(t, options);
    assert.ok(archState.sessions.openTabPaths.includes(missing));
    assert.ok(archState.sessions.sessions.some((session) => session.path === missing));
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
