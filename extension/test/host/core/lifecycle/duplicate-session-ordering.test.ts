/**
 * Integration test pinning the critical ordering invariant of the
 * duplicateSession migration: `beginSelectionRequest` must run BEFORE the
 * reducer optimistically activates the copy tab, so the selection request
 * snapshots the *previous* active path. `handleSelectionFailure` uses that
 * snapshot to restore the previously-active tab on failure — if
 * `beginSelectionRequest` ran after the reducer set `activeSessionPath =
 * pending`, it would snapshot the pending path and recovery would select the
 * wrong tab.
 *
 * Mirrors `create-session-ordering.test.ts`. Uses the real `SessionServiceState`
 * + `SessionTabActions` (timeout disabled to avoid a 60s timer leak);
 * `dispatchArch` runs the real reducer so the optimistic setup is applied
 * synchronously before `duplicateSession()` returns.
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

function createExtensionContext(): any {
  return {
    globalState: { update: async () => undefined },
    workspaceState: { update: async () => undefined },
  };
}

test('duplicateSession mints the selection token before the reducer activates the copy tab (previousActivePath is the old active)', () => {
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
  let capturedPending: string | undefined;
  const dispatchArch = (event: Event) => {
    if (event.kind === 'Command' && event.cmd.kind === 'DuplicateSession') {
      capturedToken = event.cmd.selectionToken;
      capturedPending = event.cmd.sessionPath;
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

  tabs.duplicateSession(OLD);
  const pendingPath = capturedPending!;

  // The reducer activated the copy tab (optimistic setup applied
  // synchronously during the Command dispatch) adjacent to the source.
  assert.equal(archState.sessions.activeSessionPath, pendingPath);
  assert.deepEqual(archState.sessions.openTabPaths, [OLD, pendingPath]);

  // The selection request snapshotted the OLD active path — NOT the pending
  // path — because beginSelectionRequest ran before the Command dispatch. This
  // is what lets handleSelectionFailure restore the previous active tab on
  // failure. (If beginSelectionRequest ran after the reducer set active =
  // pending, previousActivePath would equal pendingPath — a recovery bug.)
  const request = state.getSelectionRequest(capturedToken);
  assert.ok(request, 'a selection request was registered for the duplicate');
  assert.equal(request?.previousActivePath, OLD);
  assert.notEqual(request?.previousActivePath, pendingPath);
});

test('a hidden timed-out duplicate accepts event-before-ack success without reopening', () => {
  const OLD = '/workspace/old-hidden-duplicate.jsonl';
  let archState: ArchState = {
    ...createInitialArchState(),
    sessions: {
      ...createInitialArchState().sessions,
      sessions: [{ path: OLD, name: 'Old', cwd: '/w', modifiedAt: '2024-01-01T00:00:00.000Z', messageCount: 1 }],
      openTabPaths: [OLD],
      activeSessionPath: OLD,
    },
  };
  const context = createExtensionContext();
  const getArchState = () => archState;
  const effects: unknown[] = [];
  let operationId: string | undefined;
  let selectionToken: string | undefined;
  const dispatchArch = (event: Event): void => {
    if (event.kind === 'Command' && event.cmd.kind === 'DuplicateSession') {
      operationId = event.cmd.operationId;
      selectionToken = event.cmd.selectionToken;
    }
    const result = reducer(archState, event);
    archState = result.state;
    effects.push(...result.effects);
  };
  const state = new SessionServiceState(
    context,
    { request: async () => ({}) } as any,
    () => undefined,
    getArchState,
    dispatchArch,
    0,
  );
  const tabs = new SessionTabActions({
    context,
    scheduleRender: () => undefined,
    runObserver: NOOP_RUN_OBSERVER,
    state,
    getArchState,
    dispatchArch,
  });

  tabs.duplicateSession(OLD);
  const pendingPath = archState.sessions.activeSessionPath!;
  state.handleCreateOperationDelayed(selectionToken!, operationId!, 'still duplicating');
  dispatchArch({ kind: 'Command', cmd: { kind: 'CloseSession', corrId: 'hide-duplicate', sessionPath: pendingPath } });

  const resolvedPath = '/workspace/duplicate-resolved.jsonl';
  const payload: SessionOpenedPayload = {
    operationId,
    selectionToken,
    session: { path: resolvedPath, name: 'Old (copy)', cwd: '/w', modifiedAt: '2026-01-01T00:00:00.000Z', messageCount: 1 },
    transcript: [],
    transcriptWindow: { totalCount: 0, loadedStart: 0, loadedEnd: 0, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false },
    busy: false,
  };
  applySessionOpenedPayload(payload, {
    getArchState,
    dispatchArch,
    runObserver: NOOP_RUN_OBSERVER,
    scheduleRender: () => undefined,
    context,
    state,
  });

  assert.equal(archState.operations[operationId!]?.terminal?.outcome, 'settled');
  assert.equal(archState.operations[operationId!]?.kind, 'session.duplicate');
  assert.equal(archState.sessions.openTabPaths.includes(pendingPath), false);
  assert.equal(archState.sessions.openTabPaths.includes(resolvedPath), false);
  assert.equal(archState.sessions.activeSessionPath, OLD);
  assert.equal(effects.filter((effect: any) => effect.kind === 'DrainPendingSendQueue').length, 0);
});

test('duplicateSession → backend session.duplicate rejection → handleSelectionFailure restores the pre-duplicate state (e2e through the EffectRunner)', async () => {
  // Glues the whole riskiest chain in one test: optimistic setup (reducer) →
  // backend RPC rejection (runner) → handleSelectionFailure (host) → reducer
  // transitions that undo the setup. The final ArchState must equal the
  // pre-duplicate state (active restored to OLD, pending copy tab+summary gone,
  // no run-summary, a notice surfaced).
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

  // Backend rejects session.duplicate; everything else resolves.
  const backend = {
    request: async (method: string): Promise<unknown> => {
      if (method === 'session.duplicate') throw new Error('boom');
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

  tabs.duplicateSession(OLD);
  // The reducer synchronously activated the copy tab during the Command
  // dispatch, so activeSessionPath is now the pending copy path. (The backend
  // rejection + handleSelectionFailure recovery run in later microtasks.)
  const pendingPath = archState.sessions.activeSessionPath!;

  // Optimistic setup applied synchronously: copy tab adjacent to source + active.
  assert.equal(archState.sessions.activeSessionPath, pendingPath);
  assert.deepEqual(archState.sessions.openTabPaths, [OLD, pendingPath]);

  // Drain microtasks: backend rejection → handleSelectionFailure → recovery dispatches.
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));

  // Final state equals the pre-duplicate state: active restored to OLD, pending
  // copy tab + summary gone, no pending run-summary, a notice surfaced.
  assert.equal(archState.sessions.activeSessionPath, OLD);
  assert.deepEqual(archState.sessions.openTabPaths, [OLD]);
  assert.deepEqual(archState.sessions.sessions, [oldSummary]);
  assert.equal(archState.sessions.openTabPaths.includes(pendingPath), false);
  assert.equal(pendingPath in archState.composer.activeRunSummaryBySession, false);
  assert.equal(archState.settings.notice, 'Failed to duplicate session: boom');
});
