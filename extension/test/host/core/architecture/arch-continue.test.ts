import assert from 'node:assert/strict';
import test from 'node:test';

import { initialArchState, reducer, type ArchState } from '../../../../src/host/core/reducer';

const SESSION = '/repo/interrupted.jsonl';

function readyState(): ArchState {
  return {
    ...initialArchState,
    settings: { ...initialArchState.settings, backendReady: true },
    sessions: {
      ...initialArchState.sessions,
      interruptSettledSessionPaths: [SESSION],
    },
  };
}

test('Continue marks the session running, clears the interrupt fence, and emits no user-message mutation', () => {
  const state = readyState();
  const result = reducer(state, {
    kind: 'Command',
    cmd: { kind: 'Continue', corrId: 'continue-1', sessionPath: SESSION },
  });

  assert.deepEqual(result.effects, [
    { kind: 'ContinueRpc', corrId: 'continue-1', sessionPath: SESSION },
  ]);
  assert.deepEqual(result.state.sessions.runningSessionPaths, [SESSION]);
  assert.deepEqual(result.state.sessions.interruptSettledSessionPaths, []);
  assert.equal(result.state.transcript.bySession[SESSION], undefined);
  assert.deepEqual(result.state.pending.ops, {});
});

test('failed continuation returns the session to idle and surfaces a session-owned notice', () => {
  const started = reducer(readyState(), {
    kind: 'Command',
    cmd: { kind: 'Continue', corrId: 'continue-2', sessionPath: SESSION },
  }).state;

  const failed = reducer(started, {
    kind: 'ContinueResult',
    corrId: 'continue-2',
    sessionPath: SESSION,
    ok: false,
    error: 'not interrupted',
  });

  assert.deepEqual(failed.state.sessions.runningSessionPaths, []);
  assert.equal(failed.state.settings.notice, 'Could not continue the interrupted response.');
  assert.equal(failed.state.settings.noticeRaw, 'not interrupted');
  assert.equal(failed.state.settings.noticeSessionPath, SESSION);
  assert.equal(failed.effects[0]?.kind, 'Log');
});
