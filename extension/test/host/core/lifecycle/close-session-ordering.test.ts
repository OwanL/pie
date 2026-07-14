/**
 * Integration test pinning the critical behaviors of the closeSession MVI
 * migration (tab lifecycle op 4 of 4):
 *
 * 1. **The next-tab selection fix:** the old CloseSession reducer handler
 *    called `removeSessionFromState` (full eviction, nulled activeSessionPath)
 *    BEFORE the runner's fat `service.closeSession()` could read the original
 *    activeSessionPath — so the next-tab selection was silently skipped. The
 *    new handler computes nextPath FIRST (from the pre-close state), does the
 *    close + select-next, and passes nextPath to the runner via the Effect.
 *
 * 2. **The recursive openSession(nextPath) edge case:** when closing the
 *    active tab and the next tab is NOT yet summarized (a tab is open but its
 *    session hasn't been loaded — e.g. startup tab restore), the runner calls
 *    `service.openSession(nextPath)` to open it in the backend. The openSession
 *    dispatches the OpenSession Command (insert placeholder + re-select +
 *    emit OpenSession Effect → session.open RPC).
 *
 * 3. **Host-side cleanup runs via the runner:** clearSelectionRequestsForPath,
 *    onSessionClosed, clearSessionScope, evict — NOT via the reducer.
 *
 * Uses the real `SessionServiceState` + `SessionTabActions` (timeout disabled
 * to avoid a 60s timer leak); `dispatchArch` runs the real reducer so the
 * optimistic setup is applied synchronously.
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

test('CloseSession reducer selects the next tab BEFORE the runner runs — fixing the double-execution bug where removeSessionFromState nulled activeSessionPath first', () => {
  // The reducer's CloseSession handler computes nextPath from the PRE-close
  // state (activeSessionPath = A, openTabPaths = [A, B]), selects B, and
  // passes nextPath=B to the Effect. The runner's closeSession receives
  // nextPath=B — it does NOT need to re-read activeSessionPath (which was
  // nulled by the old removeSessionFromState).
  const A = '/workspace/a.jsonl';
  const B = '/workspace/b.jsonl';
  const summaryA: SessionSummary = { path: A, name: 'Alpha', cwd: '/w', modifiedAt: '2024-01-01T00:00:00.000Z', messageCount: 3 };
  const summaryB: SessionSummary = { path: B, name: 'Beta', cwd: '/w', modifiedAt: '2024-01-02T00:00:00.000Z', messageCount: 5 };

  let archState: ArchState = {
    ...createInitialArchState(),
    sessions: {
      ...createInitialArchState().sessions,
      sessions: [summaryA, summaryB],
      openTabPaths: [A, B],
      activeSessionPath: A,
    },
  };
  const getArchState = () => archState;

  const dispatchArch = (event: Event) => {
    archState = reducer(archState, event).state;
  };

  const context = createExtensionContext();
  const backend = { request: async () => ({}) } as any;
  const state = new SessionServiceState(context, backend, () => undefined, getArchState, dispatchArch, 0);

  // Dispatch the CloseSession Command directly (as the message-router does).
  dispatchArch({ kind: 'Command', cmd: { kind: 'CloseSession', corrId: 'c1', sessionPath: A } });

  // The reducer synchronously: removed A from openTabPaths, selected B.
  assert.deepEqual(archState.sessions.openTabPaths, [B]);
  assert.equal(archState.sessions.activeSessionPath, B);
  // Summary NOT removed (the session persists for reopening).
  assert.deepEqual(archState.sessions.sessions, [summaryA, summaryB]);
});

test('closeSession → runner host-side cleanup → CloseSessionResult{ok:true} (e2e through the EffectRunner)', async () => {
  const A = '/workspace/a.jsonl';
  const B = '/workspace/b.jsonl';
  const summaryA: SessionSummary = { path: A, name: 'Alpha', cwd: '/w', modifiedAt: '2024-01-01T00:00:00.000Z', messageCount: 3 };
  const summaryB: SessionSummary = { path: B, name: 'Beta', cwd: '/w', modifiedAt: '2024-01-02T00:00:00.000Z', messageCount: 5 };

  let archState: ArchState = {
    ...createInitialArchState(),
    sessions: {
      ...createInitialArchState().sessions,
      sessions: [summaryA, summaryB],
      openTabPaths: [A, B],
      activeSessionPath: A,
    },
  };
  const getArchState = () => archState;
  const context = createExtensionContext();
  const backend = { request: async () => ({}) } as any;

  const dispatchedEvents: Event[] = [];
  function dispatchArch(event: Event): void {
    dispatchedEvents.push(event);
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
      closeSession: (sessionPath: string, nextPath: string | null) => tabs.closeSession(sessionPath, nextPath),
      handleSelectionFailure: (token: string, notice: string) => state.handleSelectionFailure(token, notice),
    },
    dispatch: (e: EffectResultEvent) => dispatchArch(e),
  });
  const runner = new EffectRunner(deps);

  // Dispatch the CloseSession Command (as the message-router does).
  dispatchArch({ kind: 'Command', cmd: { kind: 'CloseSession', corrId: 'c1', sessionPath: A } });

  // Optimistic setup applied synchronously: A closed, B selected.
  assert.equal(archState.sessions.activeSessionPath, B);
  assert.deepEqual(archState.sessions.openTabPaths, [B]);

  // Drain microtasks: runner's CloseSession Effect → tabs.closeSession(A, B) →
  // host-side cleanup → CloseSessionResult{ok:true}.
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));

  // The CloseSessionResult was dispatched.
  const closeResult = dispatchedEvents.find((e) => e.kind === 'CloseSessionResult');
  assert.ok(closeResult, 'CloseSessionResult was dispatched');
  if (closeResult?.kind === 'CloseSessionResult') {
    assert.equal(closeResult.ok, true);
    assert.equal(closeResult.sessionPath, A);
  }

  // B was not re-opened (it's already summarized — no recursive openSession).
  // If openSession had been called, it would dispatch an OpenSession Command.
  const openSessionCmd = dispatchedEvents.find((e) => e.kind === 'Command' && e.cmd.kind === 'OpenSession');
  assert.equal(openSessionCmd, undefined, 'no recursive openSession for an already-summarized nextPath');
});

test('closeSession → recursive openSession(nextPath) when nextPath is NOT summarized (the startup tab-restore edge case)', async () => {
  // Edge case: tab B is open (in openTabPaths) but NOT in the sessions list
  // (not summarized, not pending). Closing the active tab A → nextPath=B →
  // the runner calls openSession(B) to load it from the backend.
  const A = '/workspace/a.jsonl';
  const B = '/workspace/b.jsonl';
  const summaryA: SessionSummary = { path: A, name: 'Alpha', cwd: '/w', modifiedAt: '2024-01-01T00:00:00.000Z', messageCount: 3 };

  let archState: ArchState = {
    ...createInitialArchState(),
    sessions: {
      ...createInitialArchState().sessions,
      sessions: [summaryA], // B is NOT summarized
      openTabPaths: [A, B],  // but B IS open
      activeSessionPath: A,
    },
  };
  const getArchState = () => archState;
  const context = createExtensionContext();
  const backend = { request: async () => ({}) } as any;

  const dispatchedEvents: Event[] = [];
  function dispatchArch(event: Event): void {
    dispatchedEvents.push(event);
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
      closeSession: (sessionPath: string, nextPath: string | null) => tabs.closeSession(sessionPath, nextPath),
      handleSelectionFailure: (token: string, notice: string) => state.handleSelectionFailure(token, notice),
    },
    dispatch: (e: EffectResultEvent) => dispatchArch(e),
  });
  const runner = new EffectRunner(deps);

  // Dispatch the CloseSession Command.
  dispatchArch({ kind: 'Command', cmd: { kind: 'CloseSession', corrId: 'c1', sessionPath: A } });

  // Optimistic setup: A closed, B selected (even though B is not summarized).
  assert.equal(archState.sessions.activeSessionPath, B);
  assert.deepEqual(archState.sessions.openTabPaths, [B]);

  // Drain microtasks: runner → tabs.closeSession(A, B) → host-side cleanup →
  // sees B is not summarized → openSession(B) → dispatches OpenSession Command.
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));

  // The OpenSession Command was dispatched (recursive open for the unsummarized nextPath).
  const openSessionCmd = dispatchedEvents.find((e) => e.kind === 'Command' && e.cmd.kind === 'OpenSession');
  assert.ok(openSessionCmd, 'recursive openSession was dispatched for the unsummarized nextPath');
  if (openSessionCmd?.kind === 'Command' && openSessionCmd.cmd.kind === 'OpenSession') {
    assert.equal(openSessionCmd.cmd.sessionPath, B);
    // A placeholder was built (since B is not summarized).
    assert.ok(openSessionCmd.cmd.placeholderSummary, 'placeholder summary was built for the unsummarized nextPath');
    assert.equal(openSessionCmd.cmd.placeholderSummary?.isPlaceholder, true);
  }
});
