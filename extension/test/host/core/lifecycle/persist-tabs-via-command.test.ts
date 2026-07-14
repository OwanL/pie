/**
 * Chunk 4.2: verifies that `saveOpenTabs()` is gone and tab persistence now
 * flows through the `PersistTabs` Command → `PersistTabs` Effect MVI spine.
 *
 * 1. Pure reducer test: the `PersistTabs` Command handler emits a `PersistTabs`
 *    Effect carrying the command's `openTabPaths`/`activeSessionPath` args (a
 *    pass-through, no state change).
 * 2. Integration test: `handleSelectionFailure` dispatches a `PersistTabs`
 *    Command (it used to call `saveOpenTabs()` directly). Uses the real
 *    `SessionServiceState` + real reducer, capturing dispatched events.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createInitialArchState } from '../../../../src/host/core/arch-state';
import type { ArchState } from '../../../../src/host/core/arch-state';
import { reducer } from '../../../../src/host/core/reducer';
import { SessionServiceState } from '../../../../src/host/session-service/state';
import type { SessionSummary } from '../../../../src/shared/protocol';
import type { Event } from '../../../../src/host/core/events';

function createExtensionContext(): any {
  return {
    globalState: { update: async () => undefined },
    workspaceState: { update: async () => undefined },
  };
}

test('PersistTabs Command handler emits a PersistTabs Effect with the command args (pure reducer)', () => {
  const base = createInitialArchState();
  const openTabPaths = ['/workspace/a.jsonl', '/workspace/b.jsonl'];
  const activeSessionPath = '/workspace/b.jsonl';
  const pinnedTabPaths = ['/workspace/a.jsonl'];
  const archState: ArchState = {
    ...base,
    sessions: { ...base.sessions, openTabPaths, pinnedTabPaths, activeSessionPath },
  };

  const result = reducer(archState, {
    kind: 'Command',
    cmd: {
      kind: 'PersistTabs',
      corrId: 'persist:reducer-test',
      openTabPaths,
      activeSessionPath,
      pinnedTabPaths,
    },
  });

  // No state change (pass-through).
  assert.equal(result.state, archState);
  // Exactly one effect, carrying the command's args verbatim.
  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0].kind, 'PersistTabs');
  assert.deepEqual(
    result.effects[0],
    {
      kind: 'PersistTabs',
      corrId: 'persist:reducer-test',
      openTabPaths,
      activeSessionPath,
      pinnedTabPaths,
    },
  );
});

test('handleSelectionFailure dispatches a PersistTabs Command (replaces the old saveOpenTabs() call)', () => {
  const backend = { request: async () => ({}) } as any;
  const context = createExtensionContext();
  const OLD = '/workspace/old.jsonl';
  const REQUESTED = '/workspace/requested.jsonl';
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

  const dispatched: Event[] = [];
  const dispatchArch = (event: Event): void => {
    dispatched.push(event);
    archState = reducer(archState, event).state;
  };

  // timeout = 0 → armSelectionRequestTimeout is a no-op (no 60s timer leak).
  const state = new SessionServiceState(context, backend, () => undefined, getArchState, dispatchArch, 0);

  // Simulate an open-session selection that fails: beginSelectionRequest
  // (wasOpenTab=false so handleSelectionFailure dispatches CloseTab), then
  // drive the failure path.
  const token = state.beginSelectionRequest(REQUESTED, undefined, false, false);
  dispatched.length = 0; // ignore the setup dispatches; we care about failure.

  state.handleSelectionFailure(token, 'open session failed');

  // The failure path must dispatch a PersistTabs Command (it used to call
  // saveOpenTabs() directly).
  const persistCommands = dispatched.filter(
    (e) => e.kind === 'Command' && e.cmd.kind === 'PersistTabs',
  );
  assert.equal(persistCommands.length, 1, 'exactly one PersistTabs Command dispatched');
  const cmd = (persistCommands[0] as Extract<Event, { kind: 'Command' }>).cmd as Extract<
    import('../../../../src/host/core/commands').Command,
    { kind: 'PersistTabs' }
  >;
  // The command carries a snapshot of the current ArchState sessions slice
  // (after the CloseTab + fallback SelectSession were applied synchronously).
  assert.deepEqual(cmd.openTabPaths, archState.sessions.openTabPaths);
  assert.equal(cmd.activeSessionPath, archState.sessions.activeSessionPath);
  assert.deepEqual(cmd.pinnedTabPaths, archState.sessions.pinnedTabPaths);
});
