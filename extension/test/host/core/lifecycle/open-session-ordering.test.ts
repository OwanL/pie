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
import test from 'node:test';
import assert from 'node:assert/strict';

import { NOOP_RUN_OBSERVER } from '../../../../src/host/stats-service';
import { createInitialArchState } from '../../../../src/host/core/arch-state';
import type { ArchState } from '../../../../src/host/core/arch-state';
import { reducer } from '../../../../src/host/core/reducer';
import { SessionServiceState } from '../../../../src/host/session-service/state';
import { SessionTabActions } from '../../../../src/host/session-service/tab-actions';
import type { SessionSummary } from '../../../../src/shared/protocol';
import { EffectRunner, type EffectRunnerDeps } from '../../../../src/host/core/effect-runner';
import type { Event, EffectResultEvent } from '../../../../src/host/core/events';
import { makeEffectRunnerDeps } from '../../../helpers/effect-runner-deps';

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
  const state = new SessionServiceState(context, backend, () => undefined, getArchState, dispatchArch, 0);
  const tabs = new SessionTabActions({
    context,
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
