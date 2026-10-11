import assert from 'node:assert/strict';
import test from 'node:test';
import { initialArchState, reducer, type ArchState } from '../../../conversation-state/reducer';
import { selectViewState } from '../../../conversation-state/projections/projection';
import type { SendCommand } from '../../../conversation-state/commands';

const PATH = '/session.jsonl';
function base(): ArchState {
  return { ...initialArchState,
    settings: { ...initialArchState.settings, backendReady: true },
    sessions: { ...initialArchState.sessions, activeSessionPath: PATH, openTabPaths: [PATH] },
  };
}
function arm(state = base(), pending = true) {
  return reducer(state, { kind: 'Command', cmd: {
    kind: 'SetPruningRefreshPending', corrId: 'arm', sessionPath: PATH, pending,
  } }).state;
}
function send(overrides: Partial<SendCommand> = {}): SendCommand {
  return { kind: 'Send', corrId: 'send', operationId: 'op', operationAttempt: 1,
    operationSource: { kind: 'host' }, backendGeneration: 1, composerSend: true,
    sessionPath: PATH, text: 'hello', inputs: [], composedText: 'hello',
    localId: 'local', previousSummary: null, timestamp: 1, ...overrides };
}
test('refresh is host-owned per tab, projected, cancellable, and cleared on scope cleanup', () => {
  const state = arm();
  assert.equal(selectViewState(state).pruningRefreshPending, true);
  assert.equal(selectViewState({ ...state, sessions: { ...state.sessions, activeSessionPath: '/other' } }).pruningRefreshPending, false);
  assert.equal(arm(state, false).composer.pruningRefreshPendingBySession[PATH], false);
  const cleared = reducer(state, { kind: 'SessionScopeCleared', sessionPath: PATH, removeSessionSummary: false }).state;
  assert.equal(cleared.composer.pruningRefreshPendingBySession[PATH], undefined);
  assert.equal(arm({ ...state, sessions: { ...state.sessions, openTabPaths: [] } }).composer, state.composer);
});
test('idle nonempty composer admission captures intent; definitive rejection rearms, ambiguity does not', () => {
  const result = reducer(arm(), { kind: 'Command', cmd: send() });
  assert.equal(result.state.composer.pruningRefreshPendingBySession[PATH], undefined);
  assert.equal(result.state.pending.ops.send.refreshPruning, true);
  assert.equal(result.effects.find(e => e.kind === 'SendRpc')?.refreshPruning, true);
  assert.equal(JSON.parse(result.state.operations.op.intentFingerprint!).refreshPruning, true);
  const delayed = reducer(result.state, { kind: 'SendOperationDelayed', operationId: 'op', operationAttempt: 1, sessionPath: PATH, backendGeneration: 1 }).state;
  assert.equal(delayed.composer.pruningRefreshPendingBySession[PATH], undefined);
  const failed = reducer(result.state, { kind: 'SendResult', corrId: 'send', sessionPath: PATH, ok: false, error: 'rejected' }).state;
  assert.equal(failed.composer.pruningRefreshPendingBySession[PATH], true);
});
test('busy followups, internal sends and empty sends never consume the refresh', () => {
  const state = arm();
  const cases: [ArchState, SendCommand][] = [
    [{ ...state, sessions: { ...state.sessions, runningSessionPaths: [PATH] } }, send()],
    [state, send({ composerSend: false })],
    [state, send({ text: '', composedText: '' })],
  ];
  for (const [input, cmd] of cases) {
    const result = reducer(input, { kind: 'Command', cmd });
    assert.equal(result.state.composer.pruningRefreshPendingBySession[PATH], true);
    assert.equal(result.state.pending.ops.send.refreshPruning, false);
  }
});
test('preflight failure rearms the consumed intent after acknowledgement', () => {
  const admitted = reducer(arm(), { kind: 'Command', cmd: send() }).state;
  const accepted = reducer(admitted, { kind: 'SendResult', corrId: 'send', sessionPath: PATH, ok: true, requestId: 'request' }).state;
  const failed = reducer(accepted, { kind: 'PreflightFailed', sessionPath: PATH, requestId: 'request', error: 'preflight rejected' }).state;
  assert.equal(failed.composer.pruningRefreshPendingBySession[PATH], true);
});
test('pending-path migration retains armed state', () => {
  const migrated = reducer(arm(), { kind: 'PendingPathReplaced', oldPendingPath: PATH, newSessionPath: '/real.jsonl' }).state;
  assert.equal(migrated.composer.pruningRefreshPendingBySession[PATH], undefined);
  assert.equal(migrated.composer.pruningRefreshPendingBySession['/real.jsonl'], true);
});

test('pending-tab queue migrates immutable refresh and changed-intent retries are rejected', () => {
  const pendingPath = '__pending__:one';
  const state = base();
  const armed = { ...state, sessions: { ...state.sessions, openTabPaths: [pendingPath] },
    composer: { ...state.composer, pruningRefreshPendingBySession: { [pendingPath]: true } } };
  const queued = reducer(armed, { kind: 'Command', cmd: send({ sessionPath: pendingPath }) }).state;
  assert.equal(queued.pending.sendQueueBySession[pendingPath][0].refreshPruning, true);
  const migrated = reducer(queued, { kind: 'PendingPathReplaced', oldPendingPath: pendingPath, newSessionPath: PATH });
  const entry = migrated.effects.find(e => e.kind === 'DrainPendingSendQueue')!.entries[0];
  assert.equal(entry.refreshPruning, true);
  assert.equal(JSON.parse(migrated.state.operations.op.intentFingerprint!).refreshPruning, true);
  const admitted = reducer(migrated.state, { kind: 'Command', cmd: send({ refreshPruning: true }) });
  assert.equal(admitted.effects.find(e => e.kind === 'SendRpc')?.refreshPruning, true);
  const changed = reducer(admitted.state, { kind: 'Command', cmd: send({ refreshPruning: false, operationAttempt: 2 }) });
  assert.equal(changed.effects.some(e => e.kind === 'SendRpc'), false);
});

test('backend-ready queue retains immutable refresh on replay', () => {
  const state = arm();
  const queued = reducer({ ...state, settings: { ...state.settings, backendReady: false } }, { kind: 'Command', cmd: send() }).state;
  const entry = queued.pending.backendReadyQueueBySession[PATH][0];
  assert.equal(entry.refreshPruning, true);
  const replay = reducer({ ...queued, settings: { ...queued.settings, backendReady: true }, pending: { ...queued.pending, backendReadyQueueBySession: {} } }, { kind: 'Command', cmd: send({ refreshPruning: entry.refreshPruning }) });
  assert.equal(replay.effects.find(e => e.kind === 'SendRpc')?.refreshPruning, true);
});
