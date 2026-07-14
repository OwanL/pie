/**
 * Integration test pinning the `addFilesystemPaths` MVI migration (the LAST
 * Phase 2 method-orchestration-lift).
 *
 * The host-side entry (`service.addFilesystemPaths`) resolves the target
 * session (possibly via `createNewSession()` — the entanglement the handoff
 * flagged) + cleans the paths, then dispatches the `AddFilesystemPaths` Command.
 * The reducer owns the composer-input append. No Effect or runner side effect.
 *
 * Tests two scenarios:
 * 1. Existing active session → attaches to it (no createNewSession).
 * 2. No active session → createNewSession() → attaches to the pending path
 *    (the entanglement: a file-picker attach can spawn a new session).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { NOOP_RUN_OBSERVER } from '../../../../src/host/stats-service';
import { createInitialArchState } from '../../../../src/host/core/arch-state';
import type { ArchState } from '../../../../src/host/core/arch-state';
import { reducer } from '../../../../src/host/core/reducer';
import { SessionServiceState } from '../../../../src/host/session-service/state';
import { SessionTabActions } from '../../../../src/host/session-service/tab-actions';
import { SessionMessageActions } from '../../../../src/host/session-service/message-actions';
import type { SessionSummary } from '../../../../src/shared/protocol';
import type { Event } from '../../../../src/host/core/events';

function createExtensionContext(): any {
  return {
    globalState: { update: async () => undefined },
    workspaceState: { update: async () => undefined },
  };
}

test('addFilesystemPaths attaches to the active session when one exists (no createNewSession)', async () => {
  const SESSION = '/workspace/existing.jsonl';
  const summary: SessionSummary = {
    path: SESSION, name: 'Existing', cwd: '/w', modifiedAt: '2024-01-01T00:00:00.000Z', messageCount: 3,
  };
  let archState: ArchState = {
    ...createInitialArchState(),
    sessions: {
      ...createInitialArchState().sessions,
      sessions: [summary],
      openTabPaths: [SESSION],
      activeSessionPath: SESSION,
    },
  };
  const getArchState = () => archState;

  const dispatchedCommands: Event[] = [];
  const dispatchArch = (event: Event) => {
    dispatchedCommands.push(event);
    archState = reducer(archState, event).state;
  };

  const context = createExtensionContext();
  const backend = { request: async () => ({}) } as any;
  const state = new SessionServiceState(context, backend, () => undefined, getArchState, dispatchArch, 0);
  const tabs = new SessionTabActions({
    context, scheduleRender: () => undefined, runObserver: NOOP_RUN_OBSERVER,
    state, getArchState, dispatchArch,
  });
  const messages = new SessionMessageActions({
    context, backend, scheduleRender: () => undefined,
    state, createNewSession: () => tabs.createNewSession(), getArchState, dispatchArch,
  });

  await messages.addFilesystemPaths(SESSION, ['/a/file.ts', '/b/dir'], 'picker');

  // The AddFilesystemPaths Command was dispatched with the EXISTING session path.
  const addCmd = dispatchedCommands.find(
    (e) => e.kind === 'Command' && e.cmd.kind === 'AddFilesystemPaths',
  );
  assert.ok(addCmd, 'AddFilesystemPaths Command was dispatched');
  if (addCmd?.kind === 'Command' && addCmd.cmd.kind === 'AddFilesystemPaths') {
    assert.equal(addCmd.cmd.sessionPath, SESSION);
    assert.deepEqual(addCmd.cmd.paths, ['/a/file.ts', '/b/dir']);
    assert.equal(addCmd.cmd.source, 'picker');
  }

  // No CreateSession Command (the session already existed).
  const createCmd = dispatchedCommands.find(
    (e) => e.kind === 'Command' && e.cmd.kind === 'CreateSession',
  );
  assert.equal(createCmd, undefined, 'no CreateSession — the session already existed');

  // The reducer appended the inputs.
  const inputs = archState.composer.pendingComposerInputsBySession[SESSION];
  assert.equal(inputs?.length, 2);
  assert.equal((inputs?.[0] as any).path, '/a/file.ts');
  assert.equal((inputs?.[1] as any).path, '/b/dir');
});

test('addFilesystemPaths with no active session calls createNewSession() then attaches to the pending path (the entanglement)', async () => {
  // No active session, no open tabs — the file-picker attach spawns a new session.
  let archState: ArchState = createInitialArchState();
  const getArchState = () => archState;

  const dispatchedCommands: Event[] = [];
  const dispatchArch = (event: Event) => {
    dispatchedCommands.push(event);
    archState = reducer(archState, event).state;
  };

  const context = createExtensionContext();
  const backend = { request: async () => ({}) } as any;
  const state = new SessionServiceState(context, backend, () => undefined, getArchState, dispatchArch, 0);
  const tabs = new SessionTabActions({
    context, scheduleRender: () => undefined, runObserver: NOOP_RUN_OBSERVER,
    state, getArchState, dispatchArch,
  });
  const messages = new SessionMessageActions({
    context, backend, scheduleRender: () => undefined,
    state, createNewSession: () => tabs.createNewSession(), getArchState, dispatchArch,
  });

  await messages.addFilesystemPaths(undefined, ['/a/file.ts'], 'picker');

  // createNewSession() was called → CreateSession Command dispatched.
  const createCmd = dispatchedCommands.find(
    (e) => e.kind === 'Command' && e.cmd.kind === 'CreateSession',
  );
  assert.ok(createCmd, 'CreateSession Command was dispatched (no active session)');
  const pendingPath = createCmd?.kind === 'Command' && createCmd.cmd.kind === 'CreateSession'
    ? createCmd.cmd.sessionPath
    : undefined;
  assert.ok(pendingPath, 'a pending path was generated');

  // AddFilesystemPaths Command dispatched with the PENDING path.
  const addCmd = dispatchedCommands.find(
    (e) => e.kind === 'Command' && e.cmd.kind === 'AddFilesystemPaths',
  );
  assert.ok(addCmd, 'AddFilesystemPaths Command was dispatched');
  if (addCmd?.kind === 'Command' && addCmd.cmd.kind === 'AddFilesystemPaths') {
    assert.equal(addCmd.cmd.sessionPath, pendingPath);
    assert.deepEqual(addCmd.cmd.paths, ['/a/file.ts']);
  }

  // The reducer appended the inputs to the pending session.
  const inputs = archState.composer.pendingComposerInputsBySession[pendingPath!];
  assert.equal(inputs?.length, 1);
  assert.equal((inputs?.[0] as any).path, '/a/file.ts');
  assert.equal(inputs?.[0]?.name, 'file.ts');
});

test('addFilesystemPaths with no paths or invalid paths dispatches no Command', async () => {
  const SESSION = '/workspace/existing.jsonl';
  const summary: SessionSummary = {
    path: SESSION, name: 'Existing', cwd: '/w', modifiedAt: '2024-01-01T00:00:00.000Z', messageCount: 3,
  };
  let archState: ArchState = {
    ...createInitialArchState(),
    sessions: {
      ...createInitialArchState().sessions,
      sessions: [summary],
      openTabPaths: [SESSION],
      activeSessionPath: SESSION,
    },
  };
  const getArchState = () => archState;
  const dispatchedCommands: Event[] = [];
  const dispatchArch = (event: Event) => {
    dispatchedCommands.push(event);
    archState = reducer(archState, event).state;
  };

  const context = createExtensionContext();
  const backend = { request: async () => ({}) } as any;
  const state = new SessionServiceState(context, backend, () => undefined, getArchState, dispatchArch, 0);
  const tabs = new SessionTabActions({
    context, scheduleRender: () => undefined, runObserver: NOOP_RUN_OBSERVER,
    state, getArchState, dispatchArch,
  });
  const messages = new SessionMessageActions({
    context, backend, scheduleRender: () => undefined,
    state, createNewSession: () => tabs.createNewSession(), getArchState, dispatchArch,
  });

  // Empty paths → no Command.
  await messages.addFilesystemPaths(SESSION, [], 'picker');
  assert.equal(dispatchedCommands.length, 0, 'no Command for empty paths');

  // Whitespace-only paths → no Command (host-side entry filters them).
  await messages.addFilesystemPaths(SESSION, ['  ', ''], 'picker');
  assert.equal(dispatchedCommands.length, 0, 'no Command for whitespace-only paths');
});
