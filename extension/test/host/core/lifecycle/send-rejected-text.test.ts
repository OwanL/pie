import test from 'node:test';
import assert from 'node:assert/strict';

import { createInitialArchState } from '../../../../src/host/core/arch-state';
import { reducer } from '../../../../src/host/core/reducer';
import type { ArchState } from '../../../../src/host/core/arch-state';
import type { Event } from '../../../../src/host/core/events';
import type { Effect } from '../../../../src/host/core/effects';

function dispatch(state: ArchState, event: Event): { state: ArchState; effects: Effect[] } {
  return reducer(state, event);
}

test('SendResult{ok:false} emits sendRejected with the original sent text for draft restoration', () => {
  let state = createInitialArchState();
  state = {
    ...state,
    settings: { ...state.settings, backendReady: true },
    sessions: {
      ...state.sessions,
      sessions: [{ path: '/w/s.jsonl', name: 'S', cwd: '/w', modifiedAt: '2024-01-01T00:00:00.000Z', messageCount: 0 }],
      openTabPaths: ['/w/s.jsonl'],
      activeSessionPath: '/w/s.jsonl',
    },
  };

  // Dispatch a Send Command
  const sendResult = dispatch(state, {
    kind: 'Command',
    cmd: {
      kind: 'Send',
      corrId: 'c1',
      sessionPath: '/w/s.jsonl',
      text: 'hello world',
      inputs: [],
      composedText: 'hello world',
      localId: 'local:c1',
      previousSummary: null,
      timestamp: Date.now(),
    },
  });
  state = sendResult.state;

  // Verify the PendingOp stores the text
  assert.equal(state.pending.ops['c1']?.text, 'hello world', 'PendingOp should store the sent text');

  // Dispatch a SendResult{ok:false}
  const failResult = dispatch(state, {
    kind: 'SendResult',
    corrId: 'c1',
    ok: false,
    error: 'backend down',
    sessionPath: '/w/s.jsonl',
  });

  // Find the PostImperative effect
  const postImperative = failResult.effects.find((e) => e.kind === 'PostImperative');
  assert.ok(postImperative, 'should emit a PostImperative effect');
  if (postImperative && postImperative.kind === 'PostImperative') {
    assert.equal(postImperative.imperativeMessage.type, 'sendRejected');
    assert.equal(postImperative.imperativeMessage.text, 'hello world', 'sendRejected should carry the original sent text');
    assert.equal(postImperative.imperativeMessage.sessionPath, '/w/s.jsonl');
    assert.equal(postImperative.imperativeMessage.localId, 'local:c1');
  }
});

test('EditResult{ok:false} reopens the host-projected inline editor without sendRejected', () => {
  let state = createInitialArchState();
  state = {
    ...state,
    settings: { ...state.settings, backendReady: true },
    sessions: {
      ...state.sessions,
      sessions: [{ path: '/w/s.jsonl', name: 'S', cwd: '/w', modifiedAt: '2024-01-01T00:00:00.000Z', messageCount: 1 }],
      openTabPaths: ['/w/s.jsonl'],
      activeSessionPath: '/w/s.jsonl',
    },
    transcript: {
      ...state.transcript,
      bySession: {
        '/w/s.jsonl': [{ id: 'msg1', role: 'user', text: 'orig', timestamp: '2024-01-01T00:00:00.000Z' } as any],
      },
    },
  };

  // Dispatch an Edit Command
  const editResult = dispatch(state, {
    kind: 'Command',
    cmd: {
      kind: 'Edit',
      corrId: 'c2',
      sessionPath: '/w/s.jsonl',
      messageId: 'msg1',
      text: 'edited text',
      inputs: [],
      composedText: 'edited text',
      userParts: undefined,
      localId: 'local:c2',
      timestamp: Date.now(),
    },
  });
  state = editResult.state;

  // Edit rollback state is distinct from the bottom-composer send payload.
  assert.equal(state.pending.ops['c2']?.text, undefined, 'Edit PendingOp should not use send text');
  assert.deepEqual(state.pending.ops['c2']?.editDraft, {
    messageId: 'msg1', text: 'edited text', inputs: [],
  });

  // Dispatch EditResult{ok:false}
  const failResult = dispatch(state, {
    kind: 'EditResult',
    corrId: 'c2',
    ok: false,
    error: 'backend down',
    sessionPath: '/w/s.jsonl',
  });

  // Should NOT emit PostImperative
  const postImperative = failResult.effects.find((e) => e.kind === 'PostImperative');
  assert.equal(postImperative, undefined, 'EditResult{ok:false} should not emit sendRejected');
  assert.equal(failResult.state.transcript.editingMessageIdBySession['/w/s.jsonl'], 'msg1');
  assert.deepEqual(failResult.state.transcript.editingDraftBySession['/w/s.jsonl'], {
    messageId: 'msg1', text: 'edited text', inputs: [],
  });
});
