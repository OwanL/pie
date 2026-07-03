import test from 'node:test';
import assert from 'node:assert/strict';

import { reducer, initialArchState, type ArchState } from '../src/host/core/reducer';
import { selectViewState } from '../src/host/core/projection';
import type { Event } from '../src/host/core/events';
import type { ChatMessage, SessionSummary } from '../src/shared/protocol';

// A state with backendReady=true — needed because the Send Command handler
// queues into backendReadyQueueBySession when !backendReady (Phase 3 chunk 2).
const readyState: ArchState = {
  ...initialArchState,
  settings: { ...initialArchState.settings, backendReady: true },
};

test('reducer: initial state has empty pending ops and sessions records', () => {
  assert.deepEqual(initialArchState.pending.ops, {});
  assert.deepEqual(initialArchState.sessions.sessions, []);
  assert.deepEqual(initialArchState.sessions.interruptInFlightBySession, {});
});

test('reducer: SendResult for unknown corrId is a no-op (state unchanged, no effects)', () => {
  const event: Event = {
    kind: 'SendResult',
    corrId: 'c1',
    sessionPath: '/a',
    ok: true,
  };

  const result = reducer(initialArchState, event);

  assert.deepEqual(result.state, initialArchState);
  assert.deepEqual(result.effects, []);
});

test('reducer: SessionListChanged preserves summaries for open active tabs missing from payload', () => {
  const existingSummary = {
    path: '/session/a',
    name: 'New Session',
    cwd: '/workspace',
    modifiedAt: new Date().toISOString(),
    messageCount: 0,
    isPlaceholder: true,
  };

  const state: ArchState = {
    ...initialArchState,
    sessions: {
      ...initialArchState.sessions,
      sessions: [existingSummary],
      openTabPaths: ['/session/a'],
      activeSessionPath: '/session/a',
    },
  };

  const event: Event = {
    kind: 'SessionListChanged',
    sessionSummaries: [],
  };

  const result = reducer(state, event);

  assert.equal(result.state.sessions.sessions.length, 1);
  assert.equal(result.state.sessions.sessions[0]?.path, '/session/a');
  assert.equal(result.state.sessions.activeSessionPath, '/session/a');
});

test('reducer: Interrupt command sets interruptInFlight and returns InterruptRpc effect', () => {
  const event: Event = {
    kind: 'Command',
    cmd: { kind: 'Interrupt', corrId: 'c1', sessionPath: '/session/a' },
  };

  const result = reducer(initialArchState, event);

  assert.equal(result.state.sessions.interruptInFlightBySession['/session/a'], true);
  assert.equal(result.effects.length, 1);
  assert.deepEqual(result.effects[0], {
    kind: 'InterruptRpc',
    corrId: 'c1',
    sessionPath: '/session/a',
  });
});

test('reducer: Interrupt does not affect other sessions', () => {
  const stateWithB: ArchState = {
    ...initialArchState,
    sessions: {
      ...initialArchState.sessions,
      interruptInFlightBySession: { '/b': false },
    },
  };

  const event: Event = {
    kind: 'Command',
    cmd: { kind: 'Interrupt', corrId: 'c2', sessionPath: '/a' },
  };

  const result = reducer(stateWithB, event);

  assert.equal(result.state.sessions.interruptInFlightBySession['/a'], true);
  assert.equal(result.state.sessions.interruptInFlightBySession['/b'], false);
});

test('reducer: InterruptResult{ok:true} clears interruptInFlight and sets running=false directly', () => {
  const state: ArchState = {
    ...initialArchState,
    sessions: {
      ...initialArchState.sessions,
      runningSessionPaths: ['/a'],
      interruptInFlightBySession: { '/a': true },
    },
  };

  const event: Event = {
    kind: 'InterruptResult',
    corrId: 'c1',
    sessionPath: '/a',
    ok: true,
  };

  const result = reducer(state, event);

  assert.equal(result.state.sessions.interruptInFlightBySession['/a'], false);
  // Watchdog: running=false set directly in state
  assert.ok(!result.state.sessions.runningSessionPaths.includes('/a'), 'running should be cleared for /a');
  // No SyncEffect — running state is mutated directly
  assert.equal(result.effects.length, 0);
});

test('reducer: InterruptResult{ok:false} clears flag and produces Log effect', () => {
  const state: ArchState = {
    ...initialArchState,
    sessions: {
      ...initialArchState.sessions,
      interruptInFlightBySession: { '/a': true },
    },
  };

  const event: Event = {
    kind: 'InterruptResult',
    corrId: 'c1',
    sessionPath: '/a',
    ok: false,
    error: 'connection lost',
  };

  const result = reducer(state, event);

  assert.equal(result.state.sessions.interruptInFlightBySession['/a'], false);
  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0]?.kind, 'Log');
  if (result.effects[0]?.kind === 'Log') {
    assert.equal(result.effects[0].level, 'error');
    assert.match(result.effects[0].message, /Interrupt failed/);
    assert.deepEqual(result.effects[0].data, { error: 'connection lost' });
  }
});

test('reducer: non-Interrupt Command passes through unchanged', () => {
  const event: Event = {
    kind: 'Command',
    cmd: { kind: 'Send', corrId: 'c1', sessionPath: '/a', text: 'hello', inputs: [], composedText: 'hello', localId: 'local:1', previousSummary: null, timestamp: 1 },
  };

  // Send is now handled by the reducer (Phase 4), so it should NOT pass through unchanged.
  const result = reducer(readyState, event);
  assert.ok(result.effects.length > 0, 'Send should produce effects');
});

// ─── Phase 4: Send ──────────────────────────────────────────────────────────

test('reducer: Send command inserts optimistic message and produces SendRpc', () => {
  const event: Event = {
    kind: 'Command',
    cmd: {
      kind: 'Send', corrId: 'c-send', sessionPath: '/s',
      text: 'raw', inputs: [], composedText: 'composed', localId: 'loc-1',
      userParts: [{ kind: 'text', text: 'raw' }], previousSummary: null,
      timestamp: 1,
    },
  };

  const result = reducer(readyState, event);

  // Pending entry recorded.
  assert.deepEqual(result.state.pending.ops['c-send'], {
    kind: 'send',
    sessionPath: '/s',
    localId: 'loc-1',
    previousSummary: null,
    text: 'raw',
    inputs: [],
    startedAt: 1,
  });

  // Optimistic user message inserted in transcript.
  const transcript = result.state.transcript.bySession['/s'];
  assert.ok(transcript, 'transcript should exist for session');
  assert.equal(transcript!.length, 1);
  assert.equal(transcript![0]?.id, 'loc-1');
  assert.equal(transcript![0]?.role, 'user');

  // Only SendRpc effect now (no InsertOptimisticMessage).
  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0]?.kind, 'SendRpc');
  if (result.effects[0]?.kind === 'SendRpc') {
    assert.equal(result.effects[0].text, 'raw');
    assert.deepEqual(result.effects[0].inputs, []);
  }
});

test('reducer: SendResult{ok:true} moves the rollback snapshot ops→promoted (composer inputs cleared at send time, not ack)', () => {
  // Brief C: pending composer inputs are cleared at SEND time (handleSend
  // captures the snapshot onto the PendingOp and clears
  // `pendingComposerInputsBySession`), so SendResult{ok:true} no longer clears
  // them — the inputs ride on the promoted snapshot for a post-ack rollback.
  const state: ArchState = {
    ...initialArchState,
    composer: {
      ...initialArchState.composer,
      pendingComposerInputsBySession: { '/s': [{ id: 'in1', kind: 'filesystemPathRef', path: '/f', name: 'f', source: 'picker' }] },
    },
    pending: {
      ...initialArchState.pending,
      ops: { 'c-ok': { kind: 'send', sessionPath: '/s', localId: 'loc-1', previousSummary: null, startedAt: 0 } },
    },
  };

  const result = reducer(state, { kind: 'SendResult', corrId: 'c-ok', sessionPath: '/s', ok: true });

  assert.equal(result.state.pending.ops['c-ok'], undefined);
  // The op MOVED to promoted (early-ack retention for a post-ack rollback).
  assert.deepEqual(result.state.pending.promoted['c-ok'], {
    kind: 'send',
    sessionPath: '/s',
    localId: 'loc-1',
    previousSummary: null,
    startedAt: 0,
  });
  // Composer inputs are NOT cleared at ack time (send time owns the clear).
  // In the real flow handleSend already cleared them; this artificial state
  // skipped handleSend, so they remain — confirming SendResult{ok:true} is
  // no longer responsible for the clear.
  assert.deepEqual(result.state.composer.pendingComposerInputsBySession['/s'], [
    { id: 'in1', kind: 'filesystemPathRef', path: '/f', name: 'f', source: 'picker' },
  ]);
  // No effects — state mutation only.
  assert.equal(result.effects.length, 0);
});

// ─── Phase 2: Composer input Commands (router→reducer path) ──────────────────
// The router dispatches AddComposerInput/RemoveComposerInput Commands straight to
// the reducer (no Effect, no service call). These tests lock in that live path so
// the dead SessionService.addComposerInput/removeComposerInput methods can be
// hard-deleted without regressing behavior.

test('reducer: AddComposerInput appends a composer input with a derived id and emits no effects', () => {
  const event: Event = {
    kind: 'Command',
    cmd: {
      kind: 'AddComposerInput',
      corrId: 'c-add',
      sessionPath: '/s',
      input: { kind: 'filesystemPathRef', path: '/f', name: 'f', source: 'picker' },
    },
  };

  const result = reducer(initialArchState, event);

  const inputs = result.state.composer.pendingComposerInputsBySession['/s'];
  assert.ok(inputs, 'composer inputs should exist for the session');
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].id, 'c-add:input');
  assert.equal(inputs[0].kind, 'filesystemPathRef');
  // The reducer owns the change; no Effect is needed (no service call).
  assert.equal(result.effects.length, 0);
});

test('reducer: AddComposerInput preserves existing inputs when appending', () => {
  const state: ArchState = {
    ...initialArchState,
    composer: {
      ...initialArchState.composer,
      pendingComposerInputsBySession: {
        '/s': [{ id: 'in1', kind: 'filesystemPathRef', path: '/f1', name: 'f1', source: 'picker' }],
      },
    },
  };

  const event: Event = {
    kind: 'Command',
    cmd: {
      kind: 'AddComposerInput',
      corrId: 'c-add2',
      sessionPath: '/s',
      input: { kind: 'filesystemPathRef', path: '/f2', name: 'f2', source: 'drop' },
    },
  };

  const result = reducer(state, event);

  const inputs = result.state.composer.pendingComposerInputsBySession['/s'];
  assert.ok(inputs);
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0].id, 'in1');
  assert.equal(inputs[1].id, 'c-add2:input');
  assert.equal(result.effects.length, 0);
});

test('reducer: RemoveComposerInput filters out the matching input id and emits no effects', () => {
  const state: ArchState = {
    ...initialArchState,
    composer: {
      ...initialArchState.composer,
      pendingComposerInputsBySession: {
        '/s': [
          { id: 'in1', kind: 'filesystemPathRef', path: '/f1', name: 'f1', source: 'picker' },
          { id: 'in2', kind: 'filesystemPathRef', path: '/f2', name: 'f2', source: 'drop' },
        ],
      },
    },
  };

  const event: Event = {
    kind: 'Command',
    cmd: { kind: 'RemoveComposerInput', corrId: 'c-rm', sessionPath: '/s', inputId: 'in1' },
  };

  const result = reducer(state, event);

  const inputs = result.state.composer.pendingComposerInputsBySession['/s'];
  assert.ok(inputs);
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].id, 'in2');
  assert.equal(result.effects.length, 0);
});

test('reducer: SendResult{ok:false} clears pending, removes optimistic, restores name, notifies', () => {
  const prevSummary = { path: '/s', name: 'Old', cwd: '/', modifiedAt: '', messageCount: 0 };
  const state: ArchState = {
    ...initialArchState,
    transcript: {
      ...initialArchState.transcript,
      bySession: { '/s': [{ id: 'loc-2', role: 'user' as const, createdAt: '', markdown: 'hello', status: 'completed' as const }] },
      windowBySession: { '/s': { totalCount: 1, loadedStart: 0, loadedEnd: 1, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: true } },
    },
    sessions: {
      ...initialArchState.sessions,
      sessions: [{ path: '/s', name: 'Modified', cwd: '/', modifiedAt: '', messageCount: 1 }],
    },
    pending: {
      ...initialArchState.pending,
      ops: { 'c-fail': { kind: 'send', sessionPath: '/s', localId: 'loc-2', previousSummary: prevSummary, startedAt: 0 } },
    },
  };

  const result = reducer(state, { kind: 'SendResult', corrId: 'c-fail', sessionPath: '/s', ok: false, error: 'timeout' });

  assert.equal(result.state.pending.ops['c-fail'], undefined);
  // Optimistic message removed from transcript.
  assert.ok(!result.state.transcript.bySession['/s']?.some((m: ChatMessage) => m.id === 'loc-2'), 'optimistic message should be removed');
  // Notice set directly in state.
  assert.match(result.state.settings.notice!, /Couldn't send/);
  // Session summary restored.
  const restored = result.state.sessions.sessions.find(s => s.path === '/s');
  assert.equal(restored?.name, 'Old');
  // Only PostImperative remains as a real side-effect effect.
  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0]?.kind, 'PostImperative');
});

test('reducer: SendResult{ok:false} without previousSummary does not restore session name', () => {
  const state: ArchState = {
    ...initialArchState,
    transcript: {
      ...initialArchState.transcript,
      bySession: { '/s': [{ id: 'loc-3', role: 'user' as const, createdAt: '', markdown: 'hi', status: 'completed' as const }] },
      windowBySession: { '/s': { totalCount: 1, loadedStart: 0, loadedEnd: 1, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: true } },
    },
    pending: {
      ...initialArchState.pending,
      ops: { 'c-fail2': { kind: 'send', sessionPath: '/s', localId: 'loc-3', previousSummary: null, startedAt: 0 } },
    },
  };

  const result = reducer(state, { kind: 'SendResult', corrId: 'c-fail2', sessionPath: '/s', ok: false, error: 'err' });

  assert.equal(result.state.pending.ops['c-fail2'], undefined);
  // No previousSummary, so sessions list is unchanged.
  assert.deepEqual(result.state.sessions.sessions, []);
  // But notice and message removal still happened.
  assert.ok(result.state.settings.notice);
});

test('reducer: SendResult for unknown corrId is a no-op', () => {
  const result = reducer(initialArchState, { kind: 'SendResult', corrId: 'unknown', sessionPath: '/s', ok: true });
  assert.deepEqual(result.state, initialArchState);
  assert.deepEqual(result.effects, []);
});

// ─── Phase 4: Edit ──────────────────────────────────────────────────────────

test('reducer: Edit command records pending, inserts optimistic message, produces EditRpc', () => {
  const event: Event = {
    kind: 'Command',
    cmd: { kind: 'Edit', corrId: 'c-edit', sessionPath: '/s', messageId: 'msg-1', text: 'new text', localId: 'loc-e1', timestamp: 1 },
  };

  const result = reducer(initialArchState, event);

  assert.deepEqual(result.state.pending.ops['c-edit'], {
    kind: 'edit',
    sessionPath: '/s',
    localId: 'loc-e1',
    previousSummary: null,
    startedAt: 1,
  });

  // Optimistic user message in transcript.
  const transcript = result.state.transcript.bySession['/s'];
  assert.ok(transcript, 'transcript should exist');
  assert.equal(transcript![0]?.id, 'loc-e1');
  assert.equal(transcript![0]?.role, 'user');

  // Only EditRpc effect now.
  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0]?.kind, 'EditRpc');
  if (result.effects[0]?.kind === 'EditRpc') {
    assert.equal(result.effects[0].messageId, 'msg-1');
    assert.equal(result.effects[0].text, 'new text');
  }
});

test('reducer: EditResult{ok:true} (early-ack) moves the rollback snapshot ops→promoted carrying requestId', () => {
  // Mirror of the SendResult{ok:true} promote test: the edit op MOVES to
  // pending.promoted (not deleted) so a post-ack PreflightFailed can still roll
  // it back. Dropped at the commit point (first MessageStarted for requestId).
  const state: ArchState = {
    ...initialArchState,
    pending: {
      ...initialArchState.pending,
      ops: { 'c-edit-ok': { kind: 'edit', sessionPath: '/s', localId: 'loc-e2', previousSummary: null, startedAt: 0 } },
    },
  };

  const result = reducer(state, { kind: 'EditResult', corrId: 'c-edit-ok', sessionPath: '/s', ok: true, requestId: 'req-e2' });

  assert.equal(result.state.pending.ops['c-edit-ok'], undefined);
  assert.deepEqual(result.state.pending.promoted['c-edit-ok'], {
    kind: 'edit',
    sessionPath: '/s',
    localId: 'loc-e2',
    previousSummary: null,
    requestId: 'req-e2',
    startedAt: 0,
  });
  assert.deepEqual(result.effects, []);
});

test('reducer: EditResult{ok:false} clears pending, removes optimistic, sets notice', () => {
  const state: ArchState = {
    ...initialArchState,
    transcript: {
      ...initialArchState.transcript,
      bySession: { '/s': [{ id: 'loc-e3', role: 'user' as const, createdAt: '', markdown: 'edit', status: 'completed' as const }] },
      windowBySession: { '/s': { totalCount: 1, loadedStart: 0, loadedEnd: 1, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: true } },
    },
    pending: {
      ...initialArchState.pending,
      ops: { 'c-edit-fail': { kind: 'edit', sessionPath: '/s', localId: 'loc-e3', previousSummary: null, startedAt: 0 } },
    },
  };

  const result = reducer(state, { kind: 'EditResult', corrId: 'c-edit-fail', sessionPath: '/s', ok: false, error: 'denied' });

  assert.equal(result.state.pending.ops['c-edit-fail'], undefined);
  // Notice set directly in state.
  assert.match(result.state.settings.notice!, /Couldn't edit/);
  // Optimistic message removed from transcript.
  assert.ok(!result.state.transcript.bySession['/s']?.some((m: ChatMessage) => m.id === 'loc-e3'), 'optimistic edit message should be removed');
  // No SyncEffects — all state mutations are direct.
  assert.deepEqual(result.effects, []);
});

// ─── Phase 5: Alias lifecycle ─────────────────────────────────────────────────

test('reducer: MessageStarted with new requestId creates currentTurn and assistant message in transcript', () => {
  const event: Event = {
    kind: 'MessageStarted',
    sessionPath: '/s',
    messageId: 'msg-1',
    requestId: 'req-1',
    modelId: 'gpt-5',
    thinkingLevel: 'high',
    timestamp: 1,
  };

  const result = reducer(initialArchState, event);

  // currentTurnBySession updated
  assert.deepEqual(result.state.pending.currentTurnBySession['/s'], { requestId: 'req-1', firstMessageId: 'msg-1', firstMessageIndex: 0 });
  // No alias created
  assert.equal(result.state.pending.messageIdAlias['msg-1'], undefined);
  // Assistant message created in transcript
  const msg = result.state.transcript.bySession['/s']?.find((m: ChatMessage) => m.id === 'msg-1');
  assert.ok(msg, 'assistant message should exist in transcript');
  assert.equal(msg!.role, 'assistant');
  assert.equal(msg!.status, 'streaming');
  assert.equal(msg!.modelId, 'gpt-5');
  assert.equal(msg!.thinkingLevel, 'high');
  // No SyncEffects
  assert.equal(result.effects.length, 0);
});

test('reducer: MessageStarted with same requestId creates alias and updates canonical message', () => {
  // Seed an existing message in transcript
  const state: ArchState = {
    ...initialArchState,
    transcript: {
      ...initialArchState.transcript,
      bySession: {
        '/s': [{ id: 'msg-1', role: 'assistant' as const, createdAt: '', markdown: 'hello', status: 'completed' as const, parts: [], toolCalls: [] }],
      },
      windowBySession: { '/s': { totalCount: 1, loadedStart: 0, loadedEnd: 1, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: true } },
    },
    pending: {
      ...initialArchState.pending,
      currentTurnBySession: { '/s': { requestId: 'req-1', firstMessageId: 'msg-1' } },
    },
  };

  const event: Event = {
    kind: 'MessageStarted',
    sessionPath: '/s',
    messageId: 'msg-2',
    requestId: 'req-1',
    modelId: 'gpt-5',
    timestamp: 1,
  };

  const result = reducer(state, event);

  // Alias recorded
  assert.deepEqual(result.state.pending.messageIdAlias['msg-2'], { canonicalId: 'msg-1', sessionPath: '/s' });
  // currentTurn unchanged
  assert.deepEqual(result.state.pending.currentTurnBySession['/s'], { requestId: 'req-1', firstMessageId: 'msg-1' });
  // Canonical message updated to streaming status with continuation separator
  const canonical = result.state.transcript.bySession['/s']?.find((m: ChatMessage) => m.id === 'msg-1');
  assert.ok(canonical, 'canonical message should still exist');
  assert.equal(canonical!.status, 'streaming');
  // No SyncEffects
  assert.equal(result.effects.length, 0);
});

test('reducer: MessageStarted without requestId does not update currentTurnBySession', () => {
  const event: Event = {
    kind: 'MessageStarted',
    sessionPath: '/s',
    messageId: 'msg-x',
    timestamp: 1,
  };

  const result = reducer(initialArchState, event);

  assert.equal(result.state.pending.currentTurnBySession['/s'], undefined);
  // Assistant message created in transcript
  const msg = result.state.transcript.bySession['/s']?.find((m: ChatMessage) => m.id === 'msg-x');
  assert.ok(msg, 'message should exist');
  assert.equal(msg!.status, 'streaming');
});

test('reducer: MessageDelta appends text to message directly in state', () => {
  const state: ArchState = {
    ...initialArchState,
    transcript: {
      ...initialArchState.transcript,
      bySession: {
        '/s': [{ id: 'm1', role: 'assistant' as const, createdAt: '', markdown: '', status: 'streaming' as const, parts: [], toolCalls: [] }],
      },
    },
  };

  const result = reducer(state, {
    kind: 'MessageDelta',
    sessionPath: '/s',
    messageId: 'm1',
    delta: 'hello',
  });

  const msg = result.state.transcript.bySession['/s']?.find((m: ChatMessage) => m.id === 'm1');
  assert.equal(msg?.markdown, 'hello');
  assert.equal(result.effects.length, 0);
});

test('reducer: MessageDelta resolves alias before appending', () => {
  const state: ArchState = {
    ...initialArchState,
    pending: {
      ...initialArchState.pending,
      messageIdAlias: { 'alias-1': { canonicalId: 'canonical-1', sessionPath: '/s' } },
    },
    transcript: {
      ...initialArchState.transcript,
      bySession: {
        '/s': [{ id: 'canonical-1', role: 'assistant' as const, createdAt: '', markdown: '', status: 'streaming' as const, parts: [], toolCalls: [] }],
      },
    },
  };

  const result = reducer(state, {
    kind: 'MessageDelta',
    sessionPath: '/s',
    messageId: 'alias-1',
    delta: 'hello',
  });

  const msg = result.state.transcript.bySession['/s']?.find((m: ChatMessage) => m.id === 'canonical-1');
  assert.equal(msg?.markdown, 'hello');
  assert.equal(result.effects.length, 0);
});

test('reducer: MessageDelta with unknown messageId passes through unchanged', () => {
  const result = reducer(initialArchState, {
    kind: 'MessageDelta',
    sessionPath: '/s',
    messageId: 'direct-id',
    delta: 'world',
  });

  // No effect, no state change (message doesn't exist)
  assert.deepEqual(result.state, initialArchState);
  assert.equal(result.effects.length, 0);
});

test('reducer: MessageThinking resolves alias and appends reasoning', () => {
  const state: ArchState = {
    ...initialArchState,
    pending: {
      ...initialArchState.pending,
      messageIdAlias: { 'alias-t': { canonicalId: 'canonical-t', sessionPath: '/s' } },
    },
    transcript: {
      ...initialArchState.transcript,
      bySession: {
        '/s': [{ id: 'canonical-t', role: 'assistant' as const, createdAt: '', markdown: '', status: 'streaming' as const, parts: [], toolCalls: [] }],
      },
    },
  };

  const result = reducer(state, {
    kind: 'MessageThinking',
    sessionPath: '/s',
    messageId: 'alias-t',
    thinking: 'plan',
  });

  const msg = result.state.transcript.bySession['/s']?.find((m: ChatMessage) => m.id === 'canonical-t');
  assert.equal(msg?.thinking, 'plan');
  assert.equal(result.effects.length, 0);
});

test('reducer: ToolCall resolves alias and upserts tool call directly', () => {
  const state: ArchState = {
    ...initialArchState,
    pending: {
      ...initialArchState.pending,
      messageIdAlias: { 'alias-tc': { canonicalId: 'canonical-tc', sessionPath: '/s' } },
    },
    transcript: {
      ...initialArchState.transcript,
      bySession: {
        '/s': [{ id: 'canonical-tc', role: 'assistant' as const, createdAt: '', markdown: '', status: 'streaming' as const, parts: [], toolCalls: [] }],
      },
    },
  };

  const toolCall = { id: 'tool-1', name: 'bash', input: { command: 'ls' }, status: 'running' as const };
  const result = reducer(state, {
    kind: 'ToolCall',
    sessionPath: '/s',
    messageId: 'alias-tc',
    toolCall,
  });

  const msg = result.state.transcript.bySession['/s']?.find((m: ChatMessage) => m.id === 'canonical-tc');
  assert.ok(msg, 'message should exist');
  assert.equal(msg!.toolCalls?.length, 1);
  assert.equal(msg!.toolCalls![0]?.id, 'tool-1');
  assert.equal(result.effects.length, 0);
});

test('reducer: MessageFinished preserves streaming tool-call input when final message has empty arguments', () => {
  const state: ArchState = {
    ...initialArchState,
    transcript: {
      ...initialArchState.transcript,
      bySession: {
        '/s': [{
          id: 'msg-1',
          role: 'assistant' as const,
          createdAt: '',
          markdown: '',
          status: 'streaming' as const,
          parts: [{ kind: 'toolCall', toolCall: { id: 'tool-1', name: 'bash', input: { command: 'ls' }, status: 'running' } }],
          toolCalls: [{ id: 'tool-1', name: 'bash', input: { command: 'ls' }, status: 'running' }],
        }],
      },
      windowBySession: { '/s': { totalCount: 1, loadedStart: 0, loadedEnd: 1, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: true } },
    },
  };

  const message: ChatMessage = {
    id: 'msg-1',
    role: 'assistant',
    createdAt: '',
    markdown: 'done',
    status: 'completed',
    parts: [{ kind: 'toolCall', toolCall: { id: 'tool-1', name: 'bash', input: {}, status: 'completed', result: 'ok' } }],
    toolCalls: [{ id: 'tool-1', name: 'bash', input: {}, status: 'completed', result: 'ok' }],
  };

  const result = reducer(state, { kind: 'MessageFinished', sessionPath: '/s', message });
  const msg = result.state.transcript.bySession['/s']?.find((m: ChatMessage) => m.id === 'msg-1');
  assert.ok(msg);
  assert.deepEqual(msg!.toolCalls?.[0]?.input, { command: 'ls' });
  assert.equal(msg!.toolCalls?.[0]?.status, 'completed');
  assert.equal(msg!.toolCalls?.[0]?.result, 'ok');
});

test('reducer: MessageFinished resolves alias and merges into canonical message', () => {
  const state: ArchState = {
    ...initialArchState,
    pending: {
      ...initialArchState.pending,
      messageIdAlias: { 'alias-fin': { canonicalId: 'canonical-fin', sessionPath: '/s' } },
    },
    transcript: {
      ...initialArchState.transcript,
      bySession: {
        '/s': [{ id: 'canonical-fin', role: 'assistant' as const, createdAt: '', markdown: 'streaming', status: 'streaming' as const, parts: [], toolCalls: [] }],
      },
      windowBySession: { '/s': { totalCount: 1, loadedStart: 0, loadedEnd: 1, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: true } },
    },
  };

  const message: ChatMessage = {
    id: 'alias-fin', role: 'assistant', createdAt: '', markdown: 'done', status: 'completed',
  };

  const result = reducer(state, { kind: 'MessageFinished', sessionPath: '/s', message });
  // Since it's an alias, the message is merged into the canonical message
  const canonical = result.state.transcript.bySession['/s']?.find((m: ChatMessage) => m.id === 'canonical-fin');
  assert.ok(canonical, 'canonical message should still exist');
  assert.equal(canonical!.status, 'completed');
  assert.equal(result.effects.length, 0);
});

test('reducer: MessageFinished alias overwrites the canonical turn-latency breakdown with the latest segment', () => {
  const state: ArchState = {
    ...initialArchState,
    pending: {
      ...initialArchState.pending,
      messageIdAlias: { 'alias-lat': { canonicalId: 'canonical-lat', sessionPath: '/s' } },
    },
    transcript: {
      ...initialArchState.transcript,
      bySession: {
        '/s': [{
          id: 'canonical-lat', role: 'assistant' as const, createdAt: '', markdown: 'first', status: 'streaming' as const, parts: [], toolCalls: [],
          // Prior segment's latency — must be overwritten by the continuation.
          turnLatencyMs: 5_000, overheadMs: 1_000, providerLatencyMs: 4_000,
        }],
      },
      windowBySession: { '/s': { totalCount: 1, loadedStart: 0, loadedEnd: 1, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: true } },
    },
  };

  // Continuation segment with its own (smaller) latency breakdown.
  const message: ChatMessage = {
    id: 'alias-lat', role: 'assistant', createdAt: '', markdown: ' done', status: 'completed',
    turnLatencyMs: 800, overheadMs: 100, providerLatencyMs: 700,
  };

  const result = reducer(state, { kind: 'MessageFinished', sessionPath: '/s', message });
  const canonical = result.state.transcript.bySession['/s']?.find((m: ChatMessage) => m.id === 'canonical-lat');
  assert.ok(canonical);
  assert.equal(canonical!.turnLatencyMs, 800, 'latest segment latency overwrites the prior value');
  assert.equal(canonical!.overheadMs, 100);
  assert.equal(canonical!.providerLatencyMs, 700);
});

test('reducer: MessageFinished alias leaves prior latency intact when the continuation is unmeasured', () => {
  const state: ArchState = {
    ...initialArchState,
    pending: {
      ...initialArchState.pending,
      messageIdAlias: { 'alias-lat2': { canonicalId: 'canonical-lat2', sessionPath: '/s' } },
    },
    transcript: {
      ...initialArchState.transcript,
      bySession: {
        '/s': [{
          id: 'canonical-lat2', role: 'assistant' as const, createdAt: '', markdown: 'first', status: 'streaming' as const, parts: [], toolCalls: [],
          turnLatencyMs: 800, overheadMs: 100, providerLatencyMs: 700,
        }],
      },
      windowBySession: { '/s': { totalCount: 1, loadedStart: 0, loadedEnd: 1, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: true } },
    },
  };

  // Continuation with no latency fields (e.g. produced no content delta).
  const message: ChatMessage = {
    id: 'alias-lat2', role: 'assistant', createdAt: '', markdown: ' done', status: 'completed',
  };

  const result = reducer(state, { kind: 'MessageFinished', sessionPath: '/s', message });
  const canonical = result.state.transcript.bySession['/s']?.find((m: ChatMessage) => m.id === 'canonical-lat2');
  assert.ok(canonical);
  assert.equal(canonical!.turnLatencyMs, 800, 'unmeasured continuation does not clobber a prior reading');
  assert.equal(canonical!.overheadMs, 100);
  assert.equal(canonical!.providerLatencyMs, 700);
});

test('reducer: MessageFinished without alias upserts message directly', () => {
  const message: ChatMessage = {
    id: 'direct-id', role: 'assistant', createdAt: '', markdown: 'done', status: 'completed',
  };

  const result = reducer(initialArchState, { kind: 'MessageFinished', sessionPath: '/s', message });
  const msg = result.state.transcript.bySession['/s']?.find((m: ChatMessage) => m.id === 'direct-id');
  assert.ok(msg, 'message should exist in transcript');
  assert.equal(msg!.status, 'completed');
  assert.equal(result.effects.length, 0);
});

test('reducer: MessageAborted resolves alias and sets status directly in state', () => {
  const state: ArchState = {
    ...initialArchState,
    pending: {
      ...initialArchState.pending,
      messageIdAlias: { 'alias-abort': { canonicalId: 'canonical-abort', sessionPath: '/s' } },
    },
    transcript: {
      ...initialArchState.transcript,
      bySession: {
        '/s': [{ id: 'canonical-abort', role: 'assistant' as const, createdAt: '', markdown: 'text', status: 'streaming' as const, parts: [], toolCalls: [] }],
      },
    },
  };

  const result = reducer(state, { kind: 'MessageAborted', sessionPath: '/s', messageId: 'alias-abort' });
  const msg = result.state.transcript.bySession['/s']?.find((m: ChatMessage) => m.id === 'canonical-abort');
  assert.ok(msg, 'canonical message should exist');
  assert.equal(msg!.status, 'interrupted');
  assert.equal(result.effects.length, 0);
});

test('reducer: MessageAborted stamps unexpected interruption reason onto the message when available', () => {
  const state: ArchState = {
    ...initialArchState,
    transcript: {
      ...initialArchState.transcript,
      bySession: {
        '/s': [{ id: 'assistant-1', role: 'assistant' as const, createdAt: '', markdown: 'text', status: 'streaming' as const, parts: [], toolCalls: [] }],
      },
    },
  };

  const result = reducer(state, {
    kind: 'MessageAborted',
    sessionPath: '/s',
    messageId: 'assistant-1',
    userInitiated: false,
    reason: 'Backend dropped req-99 before completion.',
  });
  const msg = result.state.transcript.bySession['/s']?.find((m: ChatMessage) => m.id === 'assistant-1');
  assert.ok(msg, 'assistant message should exist');
  assert.equal(msg!.status, 'interrupted');
  assert.equal(msg!.errorDetail, 'Backend dropped request before completion.');
  assert.equal(result.effects.length, 0);
});

test('reducer: MessageAborted without messageId is a no-op', () => {
  const result = reducer(initialArchState, { kind: 'MessageAborted', sessionPath: '/s', messageId: undefined });
  assert.deepEqual(result.state, initialArchState);
  assert.deepEqual(result.effects, []);
});

test('reducer: full alias lifecycle — multi-turn accumulation', () => {
  // Turn 1: MessageStarted creates first turn
  let { state } = reducer(initialArchState, {
    kind: 'MessageStarted', sessionPath: '/s', messageId: 'req1:1', requestId: 'req1', modelId: 'gpt-5',
    timestamp: 1,
  });

  // Verify assistant message created
  let msg = state.transcript.bySession['/s']?.find((m: ChatMessage) => m.id === 'req1:1');
  assert.ok(msg, 'first assistant message should exist');
  assert.equal(msg!.status, 'streaming');

  // Delta on first message appends text
  let r = reducer(state, { kind: 'MessageDelta', sessionPath: '/s', messageId: 'req1:1', delta: 'hello' });
  state = r.state;
  msg = state.transcript.bySession['/s']?.find((m: ChatMessage) => m.id === 'req1:1');
  assert.equal(msg?.markdown, 'hello');

  // Turn 2: same requestId → alias created
  r = reducer(state, {
    kind: 'MessageStarted', sessionPath: '/s', messageId: 'req1:2', requestId: 'req1',
    timestamp: 1,
  });
  state = r.state;
  assert.deepEqual(state.pending.messageIdAlias['req1:2'], { canonicalId: 'req1:1', sessionPath: '/s' });

  // Delta on aliased ID resolves to canonical and appends
  r = reducer(state, { kind: 'MessageDelta', sessionPath: '/s', messageId: 'req1:2', delta: 'world' });
  state = r.state;
  msg = state.transcript.bySession['/s']?.find((m: ChatMessage) => m.id === 'req1:1');
  assert.ok(msg?.markdown?.includes('world'), 'delta should append to canonical message');

  // Finished on aliased ID merges into canonical
  const finMsg: ChatMessage = { id: 'req1:2', role: 'assistant', createdAt: '', markdown: 'world', status: 'completed' };
  r = reducer(state, { kind: 'MessageFinished', sessionPath: '/s', message: finMsg });
  state = r.state;
  msg = state.transcript.bySession['/s']?.find((m: ChatMessage) => m.id === 'req1:1');
  assert.ok(msg, 'canonical message should persist');
  assert.equal(msg!.status, 'completed');
});

test('reducer: BusyChanged running=true adds session to runningSessionPaths', () => {
  const result = reducer(initialArchState, {
    kind: 'BusyChanged',
    sessionPath: '/s',
    running: true,
  });

  assert.ok(result.state.sessions.runningSessionPaths.includes('/s'));
  assert.equal(result.state.sessions.unreadFinishedSessionPaths.length, 0);
  assert.deepEqual(result.effects, []);
});

test('reducer: BusyChanged running=false when was running adds to unreadFinishedSessionPaths', () => {
  // First mark the session as running
  const state = reducer(initialArchState, {
    kind: 'BusyChanged',
    sessionPath: '/s',
    running: true,
  }).state;

  assert.ok(state.sessions.runningSessionPaths.includes('/s'));

  // Now mark it as not running
  const result = reducer(state, {
    kind: 'BusyChanged',
    sessionPath: '/s',
    running: false,
  });

  assert.equal(result.state.sessions.runningSessionPaths.includes('/s'), false);
  assert.ok(result.state.sessions.unreadFinishedSessionPaths.includes('/s'));
  assert.deepEqual(result.effects, []);
});

test('reducer: BusyChanged running=false when never running does NOT add to unreadFinishedSessionPaths', () => {
  const result = reducer(initialArchState, {
    kind: 'BusyChanged',
    sessionPath: '/s',
    running: false,
  });

  assert.equal(result.state.sessions.runningSessionPaths.includes('/s'), false);
  assert.equal(result.state.sessions.unreadFinishedSessionPaths.includes('/s'), false);
  assert.equal(result.state.sessions.unreadFinishedSessionPaths.length, 0);
  assert.deepEqual(result.effects, []);
});

test('reducer: BusyChanged running=false for a session that finished earlier does not re-add to unreadFinishedSessionPaths', () => {
  // Mark as running, then finished
  let state = reducer(initialArchState, {
    kind: 'BusyChanged', sessionPath: '/s', running: true,
  }).state;
  state = reducer(state, {
    kind: 'BusyChanged', sessionPath: '/s', running: false,
  }).state;

  assert.equal(state.sessions.runningSessionPaths.includes('/s'), false);
  assert.ok(state.sessions.unreadFinishedSessionPaths.includes('/s'));

  // A second BusyChanged(false) should not re-add
  const result = reducer(state, {
    kind: 'BusyChanged', sessionPath: '/s', running: false,
  });

  assert.equal(result.state.sessions.runningSessionPaths.includes('/s'), false);
  assert.ok(result.state.sessions.unreadFinishedSessionPaths.includes('/s'));
  assert.equal(result.state.sessions.unreadFinishedSessionPaths.length, 1);
  assert.deepEqual(result.effects, []);
});

test('reducer: Send command with duplicate localId upserts existing optimistic message instead of appending', () => {
  const localId = 'local:test:dup';
  const sessionPath = '/s';

  // First Send command inserts the optimistic message
  const state1 = reducer(readyState, {
    kind: 'Command',
    cmd: {
      kind: 'Send',
      corrId: 'c1',
      sessionPath,
      text: 'first',
      inputs: [],
      composedText: 'first',
      localId,
      userParts: undefined,
      previousSummary: null,
      timestamp: 1,
    },
  }).state;

  assert.equal(state1.transcript.bySession[sessionPath]?.length, 1);
  assert.equal(state1.transcript.bySession[sessionPath]?.[0]?.markdown, 'first');

  // Second Send command with same localId should upsert, not duplicate
  const state2 = reducer(state1, {
    kind: 'Command',
    cmd: {
      kind: 'Send',
      corrId: 'c2',
      sessionPath,
      text: 'second',
      inputs: [],
      composedText: 'second',
      localId,
      userParts: undefined,
      previousSummary: null,
      timestamp: 1,
    },
  }).state;

  assert.equal(state2.transcript.bySession[sessionPath]?.length, 1);
  assert.equal(state2.transcript.bySession[sessionPath]?.[0]?.markdown, 'second');
});

// ─── Phase 4: Additional command coverage ───────────────────────────────────

test('reducer: DuplicateSession command optimistically opens the copy tab adjacent to the source and emits PersistTabs + DuplicateSession', () => {
  const source: SessionSummary = { path: '/src', name: 'Src', cwd: '/w', modifiedAt: '2024-01-01T00:00:00.000Z', messageCount: 3 };
  const placeholder: SessionSummary = { path: '/__pending__:1-x', name: 'Src (copy)', cwd: '/w', modifiedAt: '2024-02-01T00:00:00.000Z', messageCount: 3, isPlaceholder: true };
  const state: ArchState = {
    ...initialArchState,
    sessions: { ...initialArchState.sessions, sessions: [source], openTabPaths: ['/src'], activeSessionPath: '/src' },
  };
  const event: Event = {
    kind: 'Command',
    cmd: { kind: 'DuplicateSession', corrId: 'c-dup', sessionPath: '/__pending__:1-x', sourceSessionPath: '/src', placeholderSummary: placeholder, selectionToken: 'tok' },
  };
  const result = reducer(state, event);
  // Placeholder copy summary unshifted; copy tab spliced in adjacent to the source.
  assert.deepEqual(result.state.sessions.sessions, [placeholder, source]);
  assert.deepEqual(result.state.sessions.openTabPaths, ['/src', '/__pending__:1-x']);
  assert.equal(result.state.sessions.activeSessionPath, '/__pending__:1-x');
  assert.equal(result.effects.length, 2);
  assert.equal(result.effects[0]?.kind, 'PersistTabs');
  assert.equal(result.effects[1]?.kind, 'DuplicateSession');
  if (result.effects[1]?.kind === 'DuplicateSession') {
    assert.equal(result.effects[1].sourceSessionPath, '/src');
    assert.equal(result.effects[1].selectionToken, 'tok');
  }
});

test('reducer: HydrateModel command produces HydrateModel effect, state unchanged', () => {
  const event: Event = {
    kind: 'Command',
    cmd: { kind: 'HydrateModel', corrId: 'c-hydrate', sessionPath: '/s' },
  };

  const result = reducer(initialArchState, event);

  assert.deepEqual(result.state, initialArchState);
  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0]?.kind, 'HydrateModel');
  if (result.effects[0]?.kind === 'HydrateModel') {
    assert.equal(result.effects[0].corrId, 'c-hydrate');
    assert.equal(result.effects[0].sessionPath, '/s');
  }
});

test('reducer: MoveSessionTab command reorders openTabPaths and emits PersistTabs effect', () => {
  const state: ArchState = {
    ...initialArchState,
    sessions: {
      ...initialArchState.sessions,
      openTabPaths: ['/a', '/b', '/c'],
      activeSessionPath: '/b',
    },
  };

  const event: Event = {
    kind: 'Command',
    cmd: { kind: 'MoveSessionTab', corrId: 'c-move', sessionPath: undefined, fromIndex: 0, toIndex: 2 },
  };

  const result = reducer(state, event);

  assert.deepEqual(result.state.sessions.openTabPaths, ['/b', '/c', '/a']);
  assert.equal(result.state.sessions.activeSessionPath, '/b');
  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0]?.kind, 'PersistTabs');
  if (result.effects[0]?.kind === 'PersistTabs') {
    assert.equal(result.effects[0].corrId, 'c-move');
    assert.deepEqual(result.effects[0].openTabPaths, ['/b', '/c', '/a']);
    assert.equal(result.effects[0].activeSessionPath, '/b');
  }
});

test('reducer: MoveSessionTab with out-of-range fromIndex leaves openTabPaths unchanged', () => {
  const state: ArchState = {
    ...initialArchState,
    sessions: {
      ...initialArchState.sessions,
      openTabPaths: ['/a', '/b', '/c'],
      activeSessionPath: null,
    },
  };

  const event: Event = {
    kind: 'Command',
    cmd: { kind: 'MoveSessionTab', corrId: 'c-oob', sessionPath: undefined, fromIndex: 99, toIndex: 0 },
  };

  const result = reducer(state, event);

  assert.deepEqual(result.state.sessions.openTabPaths, ['/a', '/b', '/c']);
  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0]?.kind, 'PersistTabs');
  if (result.effects[0]?.kind === 'PersistTabs') {
    assert.deepEqual(result.effects[0].openTabPaths, ['/a', '/b', '/c']);
    assert.equal(result.effects[0].activeSessionPath, null);
  }
});

test('reducer: MoveSessionTab clamps toIndex to the last position', () => {
  const state: ArchState = {
    ...initialArchState,
    sessions: {
      ...initialArchState.sessions,
      openTabPaths: ['/a', '/b', '/c'],
      activeSessionPath: '/a',
    },
  };

  const event: Event = {
    kind: 'Command',
    cmd: { kind: 'MoveSessionTab', corrId: 'c-clamp', sessionPath: undefined, fromIndex: 0, toIndex: 99 },
  };

  const result = reducer(state, event);

  assert.deepEqual(result.state.sessions.openTabPaths, ['/b', '/c', '/a']);
  if (result.effects[0]?.kind === 'PersistTabs') {
    assert.deepEqual(result.effects[0].openTabPaths, ['/b', '/c', '/a']);
    assert.equal(result.effects[0].activeSessionPath, '/a');
  }
});

test('reducer: AddFilesystemPaths command appends filesystemPathRef inputs to pendingComposerInputsBySession (no effect — no backend RPC)', () => {
  const state: ArchState = {
    ...initialArchState,
    sessions: { ...initialArchState.sessions, openTabPaths: ['/s'] },
  };
  const event: Event = {
    kind: 'Command',
    cmd: { kind: 'AddFilesystemPaths', corrId: 'c-afp', sessionPath: '/s', paths: ['/a/file.ts', '/b/dir'], source: 'picker' },
  };

  const result = reducer(state, event);

  // No effect — purely a composer-input mutation (no backend RPC).
  assert.deepEqual(result.effects, []);
  // Two inputs appended with IDs from corrId + index.
  const inputs = result.state.composer.pendingComposerInputsBySession['/s'];
  assert.equal(inputs?.length, 2);
  assert.equal(inputs?.[0]?.kind, 'filesystemPathRef');
  assert.equal(inputs?.[0]?.id, 'c-afp:input:0');
  assert.equal(inputs?.[0]?.path, '/a/file.ts');
  assert.equal(inputs?.[0]?.name, 'file.ts');
  assert.equal(inputs?.[0]?.source, 'picker');
  assert.equal(inputs?.[1]?.kind, 'filesystemPathRef');
  assert.equal(inputs?.[1]?.id, 'c-afp:input:1');
  assert.equal(inputs?.[1]?.path, '/b/dir');
  assert.equal(inputs?.[1]?.name, 'dir');
});

// ──────────────────────────────────────────────────────────────────────────
// Transcript paging — in-flight guard + request-identity bookkeeping.
//
// Phase 2 cutover: the in-flight guard + request identity moved from the
// host-side Map/Set on SessionMessageActions into reducer-owned state
// (TranscriptState.pagingInFlightBySession), keyed by the Command corrId —
// consistent with send/edit PendingOp correlation. The epoch/window/open-tabs
// staleness re-checks + LRU eviction stay host-side for now (Phase 3/4).
// ──────────────────────────────────────────────────────────────────────────

test('reducer: LoadOlderTranscript command sets the in-flight flag (keyed by corrId) and emits the effect', () => {
  const event: Event = {
    kind: 'Command',
    cmd: { kind: 'LoadOlderTranscript', corrId: 'c-old', sessionPath: '/s' },
  };

  const result = reducer(initialArchState, event);

  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0]?.kind, 'LoadOlderTranscript');
  if (result.effects[0]?.kind === 'LoadOlderTranscript') {
    assert.equal(result.effects[0].corrId, 'c-old');
    assert.equal(result.effects[0].sessionPath, '/s');
  }
  assert.equal(result.state.transcript.pagingInFlightBySession['/s'], 'c-old');
});

test('reducer: LoadNewerTranscript command sets the in-flight flag and emits the effect', () => {
  const event: Event = {
    kind: 'Command',
    cmd: { kind: 'LoadNewerTranscript', corrId: 'c-new', sessionPath: '/s' },
  };

  const result = reducer(initialArchState, event);

  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0]?.kind, 'LoadNewerTranscript');
  assert.equal(result.state.transcript.pagingInFlightBySession['/s'], 'c-new');
});

test('reducer: JumpToLatestTranscript command sets the in-flight flag and emits the effect', () => {
  const event: Event = {
    kind: 'Command',
    cmd: { kind: 'JumpToLatestTranscript', corrId: 'c-jump', sessionPath: '/s' },
  };

  const result = reducer(initialArchState, event);

  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0]?.kind, 'JumpToLatestTranscript');
  assert.equal(result.state.transcript.pagingInFlightBySession['/s'], 'c-jump');
});

test('reducer: a second paging Command while one is in flight is dropped (in-flight guard)', () => {
  // First request sets the in-flight flag.
  const afterFirst = reducer(initialArchState, {
    kind: 'Command',
    cmd: { kind: 'LoadOlderTranscript', corrId: 'c-1', sessionPath: '/s' },
  }).state;
  assert.equal(afterFirst.transcript.pagingInFlightBySession['/s'], 'c-1');

  // A second Command for the same session arrives while the first RPC is in flight.
  const result = reducer(afterFirst, {
    kind: 'Command',
    cmd: { kind: 'LoadOlderTranscript', corrId: 'c-2', sessionPath: '/s' },
  });

  // Guard: no effect is emitted (the click is dropped) and the flag is unchanged.
  assert.deepEqual(result.effects, []);
  assert.equal(result.state.transcript.pagingInFlightBySession['/s'], 'c-1');
  assert.deepEqual(result.state, afterFirst);
});

test('reducer: LoadOlderTranscriptResult clears the in-flight flag when its corrId is the current request', () => {
  const afterCommand = reducer(initialArchState, {
    kind: 'Command',
    cmd: { kind: 'LoadOlderTranscript', corrId: 'c-old', sessionPath: '/s' },
  }).state;
  assert.equal(afterCommand.transcript.pagingInFlightBySession['/s'], 'c-old');

  const result = reducer(afterCommand, {
    kind: 'LoadOlderTranscriptResult',
    corrId: 'c-old',
    sessionPath: '/s',
    ok: true,
  });

  assert.equal(result.state.transcript.pagingInFlightBySession['/s'], undefined);
  assert.deepEqual(result.effects, []);
});

test('reducer: LoadOlderTranscriptResult failure clears the in-flight flag and logs', () => {
  const afterCommand = reducer(initialArchState, {
    kind: 'Command',
    cmd: { kind: 'LoadOlderTranscript', corrId: 'c-old', sessionPath: '/s' },
  }).state;

  const result = reducer(afterCommand, {
    kind: 'LoadOlderTranscriptResult',
    corrId: 'c-old',
    sessionPath: '/s',
    ok: false,
    error: 'boom',
  });

  assert.equal(result.state.transcript.pagingInFlightBySession['/s'], undefined);
  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0]?.kind, 'Log');
});

test('reducer: a stale LoadOlderTranscriptResult (corrId no longer current) does not clear the in-flight flag', () => {
  // Simulate a close+reopen race: the old request 'c-1' was superseded after
  // SessionScopeCleared cleared the flag, then a new request 'c-2' took over.
  const afterNew = reducer(initialArchState, {
    kind: 'Command',
    cmd: { kind: 'LoadOlderTranscript', corrId: 'c-2', sessionPath: '/s' },
  }).state;
  assert.equal(afterNew.transcript.pagingInFlightBySession['/s'], 'c-2');

  // The OLD request's result arrives — its corrId no longer matches the flag.
  const result = reducer(afterNew, {
    kind: 'LoadOlderTranscriptResult',
    corrId: 'c-1',
    sessionPath: '/s',
    ok: true,
  });

  // The new request's flag is preserved; the stale result is dropped.
  assert.equal(result.state.transcript.pagingInFlightBySession['/s'], 'c-2');
  assert.deepEqual(result.effects, []);
});

test('reducer: a LoadOlderTranscriptResult for a session with no in-flight paging request is a safe no-op', () => {
  // No Command has set the flag for /s, so there is nothing to clear and no
  // spurious effect (ok:true → no Log).
  const result = reducer(initialArchState, {
    kind: 'LoadOlderTranscriptResult',
    corrId: 'c-orphan',
    sessionPath: '/s',
    ok: true,
  });

  assert.deepEqual(result.state, initialArchState);
  assert.deepEqual(result.effects, []);
});

test('reducer: a stale LoadOlderTranscriptResult failure logs but does not clear the current request\'s in-flight flag', () => {
  // Current request is c-2; a stale failed result arrives for the older c-1.
  const afterNew = reducer(initialArchState, {
    kind: 'Command',
    cmd: { kind: 'LoadOlderTranscript', corrId: 'c-2', sessionPath: '/s' },
  }).state;
  assert.equal(afterNew.transcript.pagingInFlightBySession['/s'], 'c-2');

  const result = reducer(afterNew, {
    kind: 'LoadOlderTranscriptResult',
    corrId: 'c-1',
    sessionPath: '/s',
    ok: false,
    error: 'stale boom',
  });

  // The current request's flag is preserved; the stale failure is still logged.
  assert.equal(result.state.transcript.pagingInFlightBySession['/s'], 'c-2');
  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0]?.kind, 'Log');
});

test('reducer: SessionScopeCleared clears the in-flight paging flag for the session', () => {
  const afterCommand = reducer(initialArchState, {
    kind: 'Command',
    cmd: { kind: 'LoadOlderTranscript', corrId: 'c-old', sessionPath: '/s' },
  }).state;
  assert.equal(afterCommand.transcript.pagingInFlightBySession['/s'], 'c-old');

  const result = reducer(afterCommand, {
    kind: 'SessionScopeCleared',
    sessionPath: '/s',
    removeSessionSummary: false,
  });

  assert.equal(result.state.transcript.pagingInFlightBySession['/s'], undefined);
});

test('reducer: RecordOutcome command produces RecordOutcome effect, state unchanged', () => {
  const event: Event = {
    kind: 'Command',
    cmd: { kind: 'RecordOutcome', corrId: 'c-out', sessionPath: '/s', outcome: { resolution: 'resolved', satisfaction: 5 } },
  };

  const result = reducer(initialArchState, event);

  assert.deepEqual(result.state, initialArchState);
  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0]?.kind, 'RecordOutcome');
  if (result.effects[0]?.kind === 'RecordOutcome') {
    assert.equal(result.effects[0].corrId, 'c-out');
    assert.equal(result.effects[0].sessionPath, '/s');
    assert.deepEqual(result.effects[0].outcome, { resolution: 'resolved', satisfaction: 5 });
  }
});

test('reducer: StartNewTask command produces StartNewTask effect, state unchanged', () => {
  const event: Event = {
    kind: 'Command',
    cmd: { kind: 'StartNewTask', corrId: 'c-start', sessionPath: '/s' },
  };

  const result = reducer(initialArchState, event);

  assert.deepEqual(result.state, initialArchState);
  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0]?.kind, 'StartNewTask');
  if (result.effects[0]?.kind === 'StartNewTask') {
    assert.equal(result.effects[0].corrId, 'c-start');
    assert.equal(result.effects[0].sessionPath, '/s');
  }
});

test('reducer: ContinueTask command produces ContinueTask effect, state unchanged', () => {
  const event: Event = {
    kind: 'Command',
    cmd: { kind: 'ContinueTask', corrId: 'c-cont', sessionPath: '/s' },
  };

  const result = reducer(initialArchState, event);

  assert.deepEqual(result.state, initialArchState);
  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0]?.kind, 'ContinueTask');
  if (result.effects[0]?.kind === 'ContinueTask') {
    assert.equal(result.effects[0].corrId, 'c-cont');
    assert.equal(result.effects[0].sessionPath, '/s');
  }
});

// ─── Phase 4: CloseSessionResult ────────────────────────────────────────────

test('reducer: CloseSessionResult{ok:true} returns unchanged state with no effects', () => {
  const result = reducer(initialArchState, { kind: 'CloseSessionResult', corrId: 'c-close', ok: true });
  assert.deepEqual(result.state, initialArchState);
  assert.deepEqual(result.effects, []);
});

test('reducer: CloseSessionResult{ok:false} is a no-op (close is purely host-side, no reducer reconciliation needed)', () => {
  // Mirrors CreateSessionResult/DuplicateSessionResult/OpenSessionResult: the
  // reducer already did the optimistic tab-close + select-next + map clearing.
  // The runner's CloseSession Effect does host-side cleanup (no backend RPC),
  // so the result event has no reducer state to reconcile.
  const result = reducer(initialArchState, { kind: 'CloseSessionResult', corrId: 'c-close', ok: false, error: 'network' });
  assert.deepEqual(result.state, initialArchState);
  assert.deepEqual(result.effects, []);
});

// ─── Phase 4: requestIdToLocalId reconciliation ───────────────────────────────

test('reducer: SendResult{ok:true} with requestId stores requestIdToLocalId mapping', () => {
  const state: ArchState = {
    ...initialArchState,
    pending: {
      ...initialArchState.pending,
      ops: {
        'c-send': { kind: 'send', sessionPath: '/s', localId: 'loc-1', previousSummary: null, startedAt: 0 },
      },
    },
  };

  const result = reducer(state, {
    kind: 'SendResult',
    corrId: 'c-send',
    sessionPath: '/s',
    ok: true,
    requestId: 'req-1',
  });

  assert.deepEqual(result.state.pending.requestIdToLocalId['req-1'], {
    sessionPath: '/s',
    localId: 'loc-1',
  });
});

test('reducer: MessageStarted cleans up requestIdToLocalId mapping without corrupting transcript', () => {
  const state: ArchState = {
    ...initialArchState,
    transcript: {
      ...initialArchState.transcript,
      bySession: {
        '/s': [{ id: 'loc-1', role: 'user' as const, createdAt: '', markdown: 'hello', status: 'completed' as const }],
      },
      windowBySession: { '/s': { totalCount: 1, loadedStart: 0, loadedEnd: 1, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: true } },
    },
    pending: {
      ...initialArchState.pending,
      requestIdToLocalId: {
        'req-1': { sessionPath: '/s', localId: 'loc-1' },
      },
    },
  };

  const result = reducer(state, {
    kind: 'MessageStarted',
    sessionPath: '/s',
    messageId: 'real-msg-1',
    requestId: 'req-1',
    timestamp: 1,
  });

  // The optimistic user message must keep its localId — MessageStarted carries
  // the assistant message ID, not the user message ID.
  const msg = result.state.transcript.bySession['/s']?.find((m: ChatMessage) => m.id === 'loc-1');
  assert.ok(msg, 'optimistic user message should keep localId');
  assert.equal(msg!.role, 'user');
  // Mapping should be cleaned up to avoid leaks.
  assert.equal(result.state.pending.requestIdToLocalId['req-1'], undefined);
});

test('reducer: MessageStarted without matching requestIdToLocalId leaves transcript untouched', () => {
  const state: ArchState = {
    ...initialArchState,
    transcript: {
      ...initialArchState.transcript,
      bySession: {
        '/s': [{ id: 'loc-1', role: 'user' as const, createdAt: '', markdown: 'hello', status: 'completed' as const }],
      },
      windowBySession: { '/s': { totalCount: 1, loadedStart: 0, loadedEnd: 1, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: true } },
    },
    pending: {
      ...initialArchState.pending,
      requestIdToLocalId: {
        'req-other': { sessionPath: '/s', localId: 'loc-1' },
      },
    },
  };

  const result = reducer(state, {
    kind: 'MessageStarted',
    sessionPath: '/s',
    messageId: 'real-msg-1',
    requestId: 'req-1',
    timestamp: 1,
  });

  // Local message should still exist under localId.
  const msg = result.state.transcript.bySession['/s']?.find((m: ChatMessage) => m.id === 'loc-1');
  assert.ok(msg, 'local message should remain untouched');
  // req-other mapping should still exist since requestId was req-1, not req-other.
  assert.deepEqual(result.state.pending.requestIdToLocalId['req-other'], { sessionPath: '/s', localId: 'loc-1' });
});

test('reducer: SetComposerDraft command stores draft text for a session', () => {
  const event: Event = {
    kind: 'Command',
    cmd: { kind: 'SetComposerDraft', corrId: 'c-draft', sessionPath: '/s', text: 'hello world' },
  };

  const result = reducer(initialArchState, event);

  assert.equal(result.state.composer.draftTextBySession['/s'], 'hello world');
  assert.deepEqual(result.effects, []);
});

test('reducer: Send command clears the persisted draft for the session', () => {
  const state: ArchState = {
    ...readyState,
    composer: {
      ...readyState.composer,
      draftTextBySession: { '/s': 'should clear' },
    },
  };

  const event: Event = {
    kind: 'Command',
    cmd: {
      kind: 'Send', corrId: 'c-send', sessionPath: '/s',
      text: 'raw', inputs: [], composedText: 'composed', localId: 'loc-1',
      userParts: undefined, previousSummary: null, timestamp: 1,
    },
  };

  const result = reducer(state, event);

  assert.equal(result.state.composer.draftTextBySession['/s'], undefined);
});

test('reducer: Edit command does not clear the persisted draft', () => {
  const state: ArchState = {
    ...initialArchState,
    transcript: {
      ...initialArchState.transcript,
      bySession: { '/s': [{ id: 'msg-1', role: 'user' as const, createdAt: '', markdown: 'original', status: 'completed' as const }] },
      windowBySession: { '/s': { totalCount: 1, loadedStart: 0, loadedEnd: 1, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: true } },
    },
    composer: {
      ...initialArchState.composer,
      draftTextBySession: { '/s': 'keep me' },
    },
  };

  const event: Event = {
    kind: 'Command',
    cmd: { kind: 'Edit', corrId: 'c-edit', sessionPath: '/s', messageId: 'msg-1', text: 'edited', localId: 'loc-e1', timestamp: 1 },
  };

  const result = reducer(state, event);

  assert.equal(result.state.composer.draftTextBySession['/s'], 'keep me');
});

// ─── Phase 4: DuplicateSessionResult ───────────────────

test('reducer: DuplicateSessionResult{ok:true} returns unchanged state with no effects', () => {
  const result = reducer(initialArchState, { kind: 'DuplicateSessionResult', corrId: 'c-dup', ok: true });
  assert.deepEqual(result.state, initialArchState);
  assert.deepEqual(result.effects, []);
});

test('reducer: DuplicateSessionResult{ok:false} is a no-op (recovery is host-driven via handleSelectionFailure)', () => {
  // Mirrors CreateSessionResult/OpenSessionResult: the reducer has no pending
  // snapshot to reconcile — failure recovery is host-driven by
  // handleSelectionFailure (which dispatches SessionScopeCleared +
  // SelectSession-fallback + NoticeShown to undo the optimistic setup), so the
  // result event must not produce a Log or mutate state.
  const result = reducer(initialArchState, { kind: 'DuplicateSessionResult', corrId: 'c-dup', ok: false, error: 'fail' });
  assert.deepEqual(result.state, initialArchState);
  assert.deepEqual(result.effects, []);
});

// ─── Phase 2: SetPrefs unread-finished clear ─────────────────────────────────

test('reducer: SetPrefs with suppressCompletionNotifications=true clears unreadFinishedSessionPaths and emits SetPrefsRpc', () => {
  const state: ArchState = {
    ...initialArchState,
    sessions: {
      ...initialArchState.sessions,
      unreadFinishedSessionPaths: ['/x', '/y'],
    },
  };

  const event: Event = {
    kind: 'Command',
    cmd: { kind: 'SetPrefs', corrId: 'c-prefs', prefs: { suppressCompletionNotifications: true } },
  };

  const result = reducer(state, event);

  assert.deepEqual(result.state.sessions.unreadFinishedSessionPaths, []);
  assert.equal(result.state.settings.prefs.suppressCompletionNotifications, true);
  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0]?.kind, 'SetPrefsRpc');
  if (result.effects[0]?.kind === 'SetPrefsRpc') {
    assert.equal(result.effects[0].corrId, 'c-prefs');
    assert.deepEqual(result.effects[0].prefs, { suppressCompletionNotifications: true });
  }
});

test('reducer: SetPrefs not touching suppressCompletionNotifications leaves unreadFinishedSessionPaths unchanged', () => {
  const state: ArchState = {
    ...initialArchState,
    sessions: {
      ...initialArchState.sessions,
      unreadFinishedSessionPaths: ['/x', '/y'],
    },
  };

  const event: Event = {
    kind: 'Command',
    cmd: { kind: 'SetPrefs', corrId: 'c-prefs2', prefs: { autoExpandToolCalls: true } },
  };

  const result = reducer(state, event);

  assert.deepEqual(result.state.sessions.unreadFinishedSessionPaths, ['/x', '/y']);
  assert.equal(result.state.settings.prefs.autoExpandToolCalls, true);
  // suppressCompletionNotifications stays at its default (false) since the
  // command did not touch it, so unread paths are not cleared.
  assert.equal(result.state.settings.prefs.suppressCompletionNotifications, false);
  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0]?.kind, 'SetPrefsRpc');
});

test('reducer: SetPrefs normalizes a partial subagentBuckets patch into a complete object', () => {
  const event: Event = {
    kind: 'Command',
    cmd: {
      kind: 'SetPrefs',
      corrId: 'c-prefs-buckets',
      // Partial patch: only `medium` provided, and with a bad entry.
      // @ts-expect-error intentionally partial/malformed for the normalization test
      prefs: { subagentBuckets: { medium: ['sonnet', 5, ''] } },
    },
  };

  const result = reducer(initialArchState, event);

  // Missing keys filled to empty arrays; non-string/empty entries dropped.
  assert.deepEqual(result.state.settings.prefs.subagentBuckets, {
    small: [],
    medium: ['sonnet'],
    frontier: [],
  });
});

// ─── Phase 2: SetPruningSettings (Option B — reducer owns the optimistic apply) ──

test('reducer: SetPruningSettings applies optimistically and emits the SetPruningSettings effect', () => {
  const state: ArchState = {
    ...initialArchState,
    settings: {
      ...initialArchState.settings,
      pruningSettings: {
        ...initialArchState.settings.pruningSettings,
        mode: 'shadow',
        skillCeiling: 3,
        skillAlwaysKeep: ['keep-me'],
      },
    },
  };

  const event: Event = {
    kind: 'Command',
    cmd: { kind: 'SetPruningSettings', corrId: 'c-prune', settings: { mode: 'off', skillCeiling: 9 } },
  };

  const result = reducer(state, event);

  // Option B: the reducer owns the merge for instant UI. The service keeps its
  // catch+mirror+notice (graceful degradation when PI_CODING_AGENT_DIR is
  // absent), so no snapshot/revert is needed.
  assert.equal(result.state.settings.pruningSettings.mode, 'off');
  assert.equal(result.state.settings.pruningSettings.skillCeiling, 9);
  // Untouched fields are preserved.
  assert.deepEqual(result.state.settings.pruningSettings.skillAlwaysKeep, ['keep-me']);
  // The reducer returns a new state reference (purity).
  assert.notEqual(result.state, state);
  // Thin persistence effect; no snapshot, no revert.
  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0]?.kind, 'SetPruningSettings');
  if (result.effects[0]?.kind === 'SetPruningSettings') {
    assert.deepEqual(result.effects[0].settings, { mode: 'off', skillCeiling: 9 });
  }
});

// ─── Optimistic-op TTL: late result after timeout is a no-op ────────────────

test('reducer: late SendResult after a timeout-induced SendResult{ok:false} is a no-op (!pending guard)', () => {
  const state: ArchState = {
    ...initialArchState,
    transcript: {
      ...initialArchState.transcript,
      bySession: { '/s': [{ id: 'loc-late', role: 'user' as const, createdAt: '', markdown: 'hello', status: 'completed' as const }] },
      windowBySession: { '/s': { totalCount: 1, loadedStart: 0, loadedEnd: 1, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: true } },
    },
    pending: {
      ...initialArchState.pending,
      ops: { 'c-late': { kind: 'send', sessionPath: '/s', localId: 'loc-late', previousSummary: null, startedAt: 0 } },
    },
  };

  // 1. Timeout fires: reducer reverts the optimistic change.
  const afterTimeout = reducer(state, { kind: 'SendResult', corrId: 'c-late', sessionPath: '/s', ok: false, error: 'Timed out waiting for backend response (60s)' });
  assert.equal(afterTimeout.state.pending.ops['c-late'], undefined);
  assert.ok(!afterTimeout.state.transcript.bySession['/s']?.some((m: ChatMessage) => m.id === 'loc-late'), 'optimistic message removed after timeout');
  assert.match(afterTimeout.state.settings.notice!, /Couldn't send/);

  // 2. Late real result arrives: reducer no-ops (pending already removed).
  const afterLate = reducer(afterTimeout.state, { kind: 'SendResult', corrId: 'c-late', sessionPath: '/s', ok: true, requestId: 'req-late' });
  assert.equal(afterLate.state.pending.ops['c-late'], undefined);
  assert.ok(!afterLate.state.transcript.bySession['/s']?.some((m: ChatMessage) => m.id === 'loc-late'), 'optimistic message still absent after late result');
  assert.equal(afterLate.effects.length, 0);
  // State is unchanged from afterTimeout.
  assert.deepEqual(afterLate.state, afterTimeout.state);
});

// ─── Brief A: early-ack two failure windows for send ─────────────────────────
// See docs/STATE_CONTRACT.md § Optimistic Reconciliation "Two failure windows
// for send". message.send now resolves as soon as the prompt is QUEUED (before
// the pruning prepass); a SendResult{ok:true} MOVES the rollback snapshot to
// pending.promoted (it is NOT deleted) so a post-ack PreflightFailed can still
// roll back. The snapshot is dropped at the commit point (first MessageStarted
// for the requestId).

const imgInput = { id: 'in1', kind: 'filesystemPathRef' as const, path: '/f', name: 'f', source: 'picker' as const };
const userWindow = { totalCount: 1, loadedStart: 0, loadedEnd: 1, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: true };

test('reducer: SendResult{ok:true} (early-ack) moves the rollback snapshot ops→promoted carrying inputs', () => {
  // Realistic post-handleSend state: handleSend captured the inputs onto the
  // PendingOp AND cleared `pendingComposerInputsBySession` at send time, so by
  // the time SendResult{ok:true} fires the composer is already clean.
  const state: ArchState = {
    ...initialArchState,
    pending: {
      ...initialArchState.pending,
      ops: { 'c-promote': { kind: 'send', sessionPath: '/s', localId: 'loc-1', previousSummary: null, text: 'hi', inputs: [imgInput], startedAt: 0 } },
    },
  };

  const result = reducer(state, { kind: 'SendResult', corrId: 'c-promote', sessionPath: '/s', ok: true, requestId: 'req-7' });

  // The op left `ops`...
  assert.equal(result.state.pending.ops['c-promote'], undefined);
  // ...and MOVED to `promoted` (not deleted), carrying the inputs snapshot and
  // stamped with requestId so a later PreflightFailed / commit-point can resolve
  // corrId without a reverse map.
  assert.deepEqual(result.state.pending.promoted['c-promote'], {
    kind: 'send',
    sessionPath: '/s',
    localId: 'loc-1',
    previousSummary: null,
    text: 'hi',
    inputs: [imgInput],
    requestId: 'req-7',
    startedAt: 0,
  });
  // Composer inputs were cleared at SEND time (handleSend), not at ack time.
  // SendResult{ok:true} does not touch `pendingComposerInputsBySession`.
  assert.equal(result.state.composer.pendingComposerInputsBySession['/s'], undefined);
  // requestId→localId still recorded for optimistic ID finalization.
  assert.deepEqual(result.state.pending.requestIdToLocalId['req-7'], { sessionPath: '/s', localId: 'loc-1' });
  assert.equal(result.effects.length, 0);
});

test('reducer: post-ack PreflightFailed rolls back via promoted, restores inputs, fires sendRejected', () => {
  // Post-ack state: the send was promoted (SendResult{ok:true}), so composer
  // inputs were cleared and the rollback snapshot lives in `promoted`.
  const state: ArchState = {
    ...initialArchState,
    sessions: { ...initialArchState.sessions, runningSessionPaths: ['/s'] },
    transcript: {
      ...initialArchState.transcript,
      bySession: { '/s': [{ id: 'loc-2', role: 'user' as const, createdAt: '', markdown: 'hey', status: 'completed' as const }] },
      windowBySession: { '/s': userWindow },
    },
    pending: {
      ...initialArchState.pending,
      promoted: { 'c-fl': { kind: 'send', sessionPath: '/s', localId: 'loc-2', previousSummary: null, text: 'hey', inputs: [imgInput], requestId: 'req-9', startedAt: 0 } },
      requestIdToLocalId: { 'req-9': { sessionPath: '/s', localId: 'loc-2' } },
    },
  };

  // Dispatched from the backend prepass-failure bridge WITHOUT corrId (the
  // backend mints requestId but never sees the host corrId); the reducer resolves
  // corrId by scanning promoted for the matching requestId.
  const result = reducer(state, { kind: 'PreflightFailed', sessionPath: '/s', requestId: 'req-9', error: 'prepass blew up' });

  // Promoted snapshot dropped (rollback consumed).
  assert.equal(result.state.pending.promoted['c-fl'], undefined);
  // Optimistic user message removed from transcript.
  assert.ok(!result.state.transcript.bySession['/s']?.some((m: ChatMessage) => m.id === 'loc-2'));
  // Host-side optimistic running state cleared.
  assert.ok(!result.state.sessions.runningSessionPaths.includes('/s'));
  // requestId→localId cleared (the send will never stream).
  assert.equal(result.state.pending.requestIdToLocalId['req-9'], undefined);
  // Composer inputs RESTORED from the promoted snapshot (no data loss).
  assert.deepEqual(result.state.composer.pendingComposerInputsBySession['/s'], [imgInput]);
  // Plain-language error surfaced (Brief H refines the copy).
  assert.match(result.state.settings.notice!, /pruning step failed/);
  assert.match(result.state.settings.notice!, /prepass blew up/);
  // Fires a sendRejected imperative so the webview drops its overlay + restores draft.
  // Brief C: the imperative carries `inputs` so the webview can restore the
  // composer attachments immediately (the host-side restore above is the
  // source of truth the next snapshot confirms).
  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0]?.kind, 'PostImperative');
  if (result.effects[0]?.kind === 'PostImperative') {
    assert.deepEqual(result.effects[0].imperativeMessage, {
      type: 'sendRejected',
      sessionPath: '/s',
      text: 'hey',
      localId: 'loc-2',
      inputs: [imgInput],
    });
  }
});

test('reducer: PreflightFailed with explicit corrId (Brief B send-timer) rolls back the matching promoted op', () => {
  // Brief B's send-timer dispatches PreflightFailed WITH corrId; verify that
  // path resolves without scanning (and that an unknown corrId no-ops).
  const state: ArchState = {
    ...initialArchState,
    sessions: { ...initialArchState.sessions, runningSessionPaths: ['/s'] },
    transcript: {
      ...initialArchState.transcript,
      bySession: { '/s': [{ id: 'loc-b', role: 'user' as const, createdAt: '', markdown: 'go', status: 'completed' as const }] },
      windowBySession: { '/s': userWindow },
    },
    pending: {
      ...initialArchState.pending,
      promoted: { 'c-b': { kind: 'send', sessionPath: '/s', localId: 'loc-b', previousSummary: null, text: 'go', inputs: [], requestId: 'req-b', startedAt: 0 } },
    },
  };

  const result = reducer(state, { kind: 'PreflightFailed', corrId: 'c-b', sessionPath: '/s', requestId: 'req-b', error: 'timed out' });
  assert.equal(result.state.pending.promoted['c-b'], undefined);
  assert.ok(!result.state.transcript.bySession['/s']?.some((m: ChatMessage) => m.id === 'loc-b'));
  assert.equal(result.effects.length, 1);
});

test('reducer: commit-point first MessageStarted drops the promoted snapshot (later failure is in-turn, not rollback)', () => {
  const state: ArchState = {
    ...initialArchState,
    transcript: {
      ...initialArchState.transcript,
      bySession: { '/s': [{ id: 'loc-3', role: 'user' as const, createdAt: '', markdown: 'go', status: 'completed' as const }] },
      windowBySession: { '/s': userWindow },
    },
    pending: {
      ...initialArchState.pending,
      promoted: { 'c-commit': { kind: 'send', sessionPath: '/s', localId: 'loc-3', previousSummary: null, text: 'go', requestId: 'req-11', startedAt: 0 } },
      requestIdToLocalId: { 'req-11': { sessionPath: '/s', localId: 'loc-3' } },
    },
  };

  const result = reducer(state, { kind: 'MessageStarted', sessionPath: '/s', messageId: 'asst-1', requestId: 'req-11', timestamp: 1 });

  // Commit point reached: the promoted rollback snapshot is dropped — a later
  // failure becomes an in-turn error, never a rollback.
  assert.equal(result.state.pending.promoted['c-commit'], undefined);
  // requestIdToLocalId also cleaned up (existing behavior).
  assert.equal(result.state.pending.requestIdToLocalId['req-11'], undefined);
  // The assistant streaming message was inserted.
  assert.ok(result.state.transcript.bySession['/s']?.some((m: ChatMessage) => m.id === 'asst-1'));
});

test('reducer: PreflightFailed after the commit point (promoted already dropped) is a no-op', () => {
  // Post-commit failure: promoted was dropped at MessageStarted, so a later
  // PreflightFailed cannot roll back — it no-ops (the in-turn error path
  // surfaces its own notice).
  const state: ArchState = {
    ...initialArchState,
    settings: { ...initialArchState.settings, notice: null },
    pending: { ...initialArchState.pending }, // promoted empty
  };

  const result = reducer(state, { kind: 'PreflightFailed', sessionPath: '/s', requestId: 'req-gone', error: 'late' });
  assert.deepEqual(result.state, state);
  assert.deepEqual(result.effects, []);
});

test('reducer: post-ack PreflightFailed rolls back an EDIT via promoted (no sendRejected; kind-aware notice)', () => {
  // Post-ack edit failure: the edit was promoted (EditResult{ok:true}), so the
  // rollback snapshot lives in `promoted`. PreflightFailed rolls it back — but,
  // matching the legacy pre-ack EditResult{ok:false} path, edits do NOT fire
  // sendRejected (the inline editor is already closed by the Edit command;
  // restoring the edited text to the composer is a UX change Brief E owns).
  // Pre-Brief-A-fix this path silently lost the rollback (optimistic edit
  // message stuck, running stuck on, no error).
  const state: ArchState = {
    ...initialArchState,
    sessions: { ...initialArchState.sessions, runningSessionPaths: ['/s'] },
    transcript: {
      ...initialArchState.transcript,
      bySession: { '/s': [{ id: 'loc-ee', role: 'user' as const, createdAt: '', markdown: 'edited', status: 'completed' as const }] },
      windowBySession: { '/s': userWindow },
    },
    pending: {
      ...initialArchState.pending,
      promoted: { 'c-edit-fl': { kind: 'edit', sessionPath: '/s', localId: 'loc-ee', previousSummary: null, requestId: 'req-ee', startedAt: 0 } },
    },
  };

  const result = reducer(state, { kind: 'PreflightFailed', sessionPath: '/s', requestId: 'req-ee', error: 'prepass blew up' });

  // Promoted edit snapshot dropped (rollback consumed).
  assert.equal(result.state.pending.promoted['c-edit-fl'], undefined);
  // Optimistic edit message removed from transcript (was stuck before the fix).
  assert.ok(!result.state.transcript.bySession['/s']?.some((m: ChatMessage) => m.id === 'loc-ee'));
  // Host-side optimistic running state cleared (was stuck before the fix).
  assert.ok(!result.state.sessions.runningSessionPaths.includes('/s'));
  // requestId→localId clear (edit never records it, but the delete is a safe no-op).
  assert.equal(result.state.pending.requestIdToLocalId['req-ee'], undefined);
  // Kind-aware notice (Brief H refines the copy).
  assert.match(result.state.settings.notice!, /Couldn't edit/);
  assert.match(result.state.settings.notice!, /prepass blew up/);
  // Edits do NOT fire sendRejected (matches legacy EditResult{ok:false}).
  assert.deepEqual(result.effects, []);
});

test('reducer: prepass phase tracks running→failed (Brief F host-side) + projects prepassPhase/startedAt for the active session', () => {
  // Brief F host-side: pending.prepassBySession tracks the prepass phase, driven
  // by the send lifecycle (promoted op + PreflightFailed). The projection
  // derives prepassPhase/startedAt for the active session (host ViewState; the
  // webview stays passive). startedAt is captured from the Send command
  // timestamp (PURE — no reducer Date.now()).
  const state: ArchState = {
    ...initialArchState,
    sessions: { ...initialArchState.sessions, activeSessionPath: '/s', runningSessionPaths: ['/s'] },
    transcript: {
      ...initialArchState.transcript,
      bySession: { '/s': [{ id: 'loc-pp', role: 'user' as const, createdAt: '', markdown: 'hi', status: 'completed' as const }] },
      windowBySession: { '/s': userWindow },
    },
    pending: {
      ...initialArchState.pending,
      ops: { 'c-pp': { kind: 'send', sessionPath: '/s', localId: 'loc-pp', previousSummary: null, text: 'hi', inputs: [], startedAt: 1000 } },
    },
  };

  // SendResult{ok:true} (early-ack): ops→promoted (carrying startedAt) + prepass phase 'running'.
  let result = reducer(state, { kind: 'SendResult', corrId: 'c-pp', sessionPath: '/s', ok: true, requestId: 'req-pp' });
  assert.equal(result.state.pending.promoted['c-pp']?.requestId, 'req-pp');
  assert.equal(result.state.pending.promoted['c-pp']?.startedAt, 1000);
  assert.equal(result.state.pending.prepassBySession['/s']?.phase, 'running');
  let view = selectViewState(result.state);
  assert.equal(view.prepassPhase, 'running', 'projected prepassPhase running for active session');
  assert.equal(view.prepassStartedAt, 1000, 'projected prepassStartedAt from the promoted op');

  // PreflightFailed (post-ack prepass failure): promoted dropped + phase 'failed'.
  result = reducer(result.state, { kind: 'PreflightFailed', corrId: 'c-pp', sessionPath: '/s', requestId: 'req-pp', error: 'prepass blew up' });
  assert.equal(result.state.pending.promoted['c-pp'], undefined);
  assert.equal(result.state.pending.prepassBySession['/s']?.phase, 'failed');
  view = selectViewState(result.state);
  assert.equal(view.prepassPhase, 'failed', 'projected prepassPhase failed');
  assert.equal(view.prepassStartedAt, null, 'no startedAt once the promoted op is dropped');
});

test('reducer: prepass phase running→succeeded on a pruning-result CustomMessage (Brief F host-side) + projects prepassPhase/latencyMs', () => {
  // Brief F host-side: a pruning-result `message.custom` arrives when the prepass
  // COMPLETES (the skill-pruner `before_agent_start` extension emits it). While
  // the session's phase is 'running' (a promoted op exists, post-ack/pre-
  // commit), this is the success signal → transition to 'succeeded' + capture
  // the latency for the post-hoc summary. See `handleCustomMessage`.
  const state: ArchState = {
    ...initialArchState,
    sessions: { ...initialArchState.sessions, activeSessionPath: '/s', runningSessionPaths: ['/s'] },
    transcript: {
      ...initialArchState.transcript,
      bySession: { '/s': [{ id: 'loc-pp', role: 'user' as const, createdAt: '', markdown: 'hi', status: 'completed' as const }] },
      windowBySession: { '/s': userWindow },
    },
    pending: {
      ...initialArchState.pending,
      ops: { 'c-pp': { kind: 'send', sessionPath: '/s', localId: 'loc-pp', previousSummary: null, text: 'hi', inputs: [], startedAt: 1000 } },
    },
  };

  // SendResult{ok:true} (early-ack): ops→promoted (carrying startedAt) + phase 'running'.
  let result = reducer(state, { kind: 'SendResult', corrId: 'c-pp', sessionPath: '/s', ok: true, requestId: 'req-pp' });
  assert.equal(result.state.pending.prepassBySession['/s']?.phase, 'running');

  // A pruning-result CustomMessage while phase is 'running' → 'succeeded' +
  // captured latencyMs. (message.custom fires on prepass COMPLETION, not start.)
  result = reducer(result.state, {
    kind: 'CustomMessage',
    sessionPath: '/s',
    message: { id: 'cm-prune', role: 'assistant' as const, createdAt: '', markdown: '', status: 'completed' as const, customType: 'pruning-result' as const, customDetails: { prepassLatencyMs: 250 } } as ChatMessage,
  });
  assert.equal(result.state.pending.prepassBySession['/s']?.phase, 'succeeded');
  assert.equal(result.state.pending.prepassBySession['/s']?.latencyMs, 250);
  let view = selectViewState(result.state);
  assert.equal(view.prepassPhase, 'succeeded', 'projected prepassPhase succeeded (promoted op still exists)');
  assert.equal(view.prepassStartedAt, 1000, 'startedAt still projected from the promoted op');
  assert.equal(view.prepassLatencyMs, 250, 'latencyMs projected from the tracked entry');

  // A pruning-result for a session with NO active 'running' prepass does NOT
  // fabricate a 'succeeded' chip (the guard in handleCustomMessage).
  const idleState: ArchState = { ...result.state, pending: { ...result.state.pending, prepassBySession: {} } };
  const noOp = reducer(idleState, {
    kind: 'CustomMessage',
    sessionPath: '/s',
    message: { id: 'cm-prune2', role: 'assistant' as const, createdAt: '', markdown: '', status: 'completed' as const, customType: 'pruning-result' as const, customDetails: { prepassLatencyMs: 999 } } as ChatMessage,
  });
  assert.equal(noOp.state.pending.prepassBySession['/s'], undefined, 'no fabricated chip for a background / already-committed pruning-result');
});

test('reducer: prepass phase running→idle at the commit point (first MessageStarted clears prepassBySession) (Brief F host-side)', () => {
  // Brief F host-side: the commit point (first MessageStarted for the
  // requestId) drops the promoted op AND clears prepassBySession → phase 'idle'.
  // A later in-turn failure is surfaced by the error mapper, never a rollback.
  // Mirror the commit-point test's transcript/window setup (MessageStarted
  // upserts an assistant message). Start from a promoted (post-ack) state.
  const state: ArchState = {
    ...initialArchState,
    sessions: { ...initialArchState.sessions, activeSessionPath: '/s', runningSessionPaths: ['/s'] },
    transcript: {
      ...initialArchState.transcript,
      bySession: { '/s': [{ id: 'loc-pp', role: 'user' as const, createdAt: '', markdown: 'hi', status: 'completed' as const }] },
      windowBySession: { '/s': userWindow },
    },
    pending: {
      ...initialArchState.pending,
      promoted: { 'c-pp': { kind: 'send', sessionPath: '/s', localId: 'loc-pp', previousSummary: null, text: 'hi', requestId: 'req-pp', startedAt: 1000 } },
      requestIdToLocalId: { 'req-pp': { sessionPath: '/s', localId: 'loc-pp' } },
      prepassBySession: { '/s': { phase: 'running', latencyMs: null } },
    },
  };
  let view = selectViewState(state);
  assert.equal(view.prepassPhase, 'running', 'starts running (promoted op exists)');
  assert.equal(view.prepassStartedAt, 1000);

  // Commit point: MessageStarted for the promoted requestId drops the promoted
  // op AND clears prepassBySession → phase 'idle'.
  const result = reducer(state, { kind: 'MessageStarted', sessionPath: '/s', messageId: 'asst-1', requestId: 'req-pp', timestamp: 1 });
  assert.equal(result.state.pending.promoted['c-pp'], undefined, 'promoted op dropped at the commit point');
  assert.equal(result.state.pending.prepassBySession['/s'], undefined, 'prepassBySession cleared → idle');
  view = selectViewState(result.state);
  assert.equal(view.prepassPhase, 'idle', 'projected prepassPhase idle after the commit point');
  assert.equal(view.prepassStartedAt, null, 'no startedAt once the promoted op is dropped');
});

test('reducer: handleError strips internal req-NN ids from the notice (Brief H criterion 1 — no req-NN reaches the user)', () => {
  // A transcript-paging RPC timeout carries `req-NN`; the raw error must not
  // surface verbatim. handleError routes through stripReqIds (shared with
  // revertSetModel's `Failed to set model: …` notice).
  const error = 'Failed to load transcript page: Timed out waiting for response to req-99';
  const result = reducer(initialArchState, { kind: 'Error', error, sessionPath: '/s' } as any);
  assert.ok(result.state.settings.notice, 'an error notice is set');
  assert.ok(!result.state.settings.notice!.includes('req-99'), 'no internal req-NN id reaches the user');
  assert.match(result.state.settings.notice!, /load transcript/, 'the plain-language problem is still named');
  // The verbatim error (with req-NN) is retained as noticeRaw so the webview
  // can reveal it via a 'show more' affordance, without leaking into the
  // short summary.
  assert.equal(result.state.settings.noticeRaw, error, 'noticeRaw carries the unredacted error');
  assert.ok(result.state.settings.noticeRaw!.includes('req-99'), 'the raw detail keeps the req-NN id');
});

test('reducer: handleDismissNotice clears notice, noticeKind, and noticeRaw together', () => {
  const errorState: ArchState = {
    ...initialArchState,
    settings: {
      ...initialArchState.settings,
      notice: 'The model took too long to start this turn.',
      noticeKind: 'send-timeout' as any,
      noticeRaw: 'Timed out waiting for response to req-42',
    },
  };
  const result = reducer(errorState, { kind: 'Command', cmd: { kind: 'DismissNotice' } } as any);
  assert.equal(result.state.settings.notice, null);
  assert.equal(result.state.settings.noticeKind, null);
  assert.equal(result.state.settings.noticeRaw, null, 'noticeRaw is cleared alongside the notice');
});

test('reducer: handleNoticeShown clears noticeRaw for plain info notices (no raw detail to reveal)', () => {
  const errorState: ArchState = {
    ...initialArchState,
    settings: {
      ...initialArchState.settings,
      notice: 'The model took too long to start this turn.',
      noticeKind: 'send-timeout' as any,
      noticeRaw: 'Timed out waiting for response to req-42',
    },
  };
  const result = reducer(errorState, { kind: 'NoticeShown', notice: 'A plain info banner.' } as any);
  assert.equal(result.state.settings.notice, 'A plain info banner.');
  assert.equal(result.state.settings.noticeKind, null);
  assert.equal(result.state.settings.noticeRaw, null, 'a plain notice carries no raw detail');
});

// ─── Brief C: optimistic lifecycle for composer inputs (pasted-image stickiness) ─
// See the UX-reliability remediation (Brief C, §5 of the since-removed plan).
// Pasted images must disappear from the
// composer IMMEDIATELY on send (cleared at send time, not ack time), and on send
// rejection the images must restore on BOTH rollback paths (no data loss):
// pre-ack `SendResult{ok:false}` and post-ack `PreflightFailed`. These tests
// drive the full flow through `handleSend` so the send-time clear + snapshot
// capture are exercised, then assert each rollback path restores inputs
// host-side AND carries `inputs` on the `sendRejected` imperative.

test('reducer: Send command clears pending composer inputs at send time and captures them onto the PendingOp', () => {
  // Heuristic #8: the inputs are already folded into the sent message by
  // MessageRouter, so keeping them as pending cards past send is pure visual
  // debt. handleSend clears `pendingComposerInputsBySession` and stashes the
  // snapshot on the PendingOp so a rollback can hand them back.
  const state: ArchState = {
    ...readyState,
    composer: {
      ...initialArchState.composer,
      pendingComposerInputsBySession: { '/s': [imgInput] },
    },
  };

  const result = reducer(state, {
    kind: 'Command',
    cmd: {
      kind: 'Send',
      corrId: 'c-send-clear',
      sessionPath: '/s',
      text: 'hi',
      inputs: [],
      composedText: 'hi',
      localId: 'loc-send-clear',
      previousSummary: null,
      timestamp: 1,
    },
  });

  // Composer inputs cleared immediately at send time (composer is clean for
  // the next turn, regardless of prepass duration).
  assert.equal(result.state.composer.pendingComposerInputsBySession['/s'], undefined);
  // The snapshot rides on the PendingOp for a rollback restore.
  assert.deepEqual(result.state.pending.ops['c-send-clear']?.inputs, [imgInput]);
});

test('reducer: pre-ack SendResult{ok:false} restores composer inputs host-side and carries inputs on sendRejected', () => {
  // Full flow: handleSend (clears + captures) → SendResult{ok:false} (rollback).
  let state: ArchState = {
    ...readyState,
    composer: {
      ...initialArchState.composer,
      pendingComposerInputsBySession: { '/s': [imgInput] },
    },
    transcript: {
      ...initialArchState.transcript,
      windowBySession: { '/s': userWindow },
    },
  };

  state = reducer(state, {
    kind: 'Command',
    cmd: {
      kind: 'Send',
      corrId: 'c-preack',
      sessionPath: '/s',
      text: 'hi',
      inputs: [],
      composedText: 'hi',
      localId: 'loc-preack',
      previousSummary: null,
      timestamp: 1,
    },
  }).state;

  // Send-time clear: inputs gone from the composer host state.
  assert.equal(state.composer.pendingComposerInputsBySession['/s'], undefined);
  assert.deepEqual(state.pending.ops['c-preack']?.inputs, [imgInput]);

  // Pre-ack failure: the message.send RPC itself rejected.
  const result = reducer(state, {
    kind: 'SendResult',
    corrId: 'c-preack',
    sessionPath: '/s',
    ok: false,
    error: 'backend down',
  });

  // Composer inputs RESTORED from the send-time snapshot (no data loss) so a
  // retry can re-send them.
  assert.deepEqual(result.state.composer.pendingComposerInputsBySession['/s'], [imgInput]);
  // sendRejected carries the inputs so the webview can restore the composer
  // attachments immediately (before the debounced snapshot confirms).
  const postImperative = result.effects.find((e) => e.kind === 'PostImperative');
  assert.ok(postImperative && postImperative.kind === 'PostImperative');
  assert.equal(postImperative!.imperativeMessage.type, 'sendRejected');
  assert.deepEqual(postImperative!.imperativeMessage.inputs, [imgInput]);
  assert.equal(postImperative!.imperativeMessage.text, 'hi');
  assert.equal(postImperative!.imperativeMessage.localId, 'loc-preack');
});

test('reducer: post-ack PreflightFailed (send) restores composer inputs host-side and carries inputs on sendRejected', () => {
  // Full flow: handleSend (clears + captures) → SendResult{ok:true} (promote) →
  // PreflightFailed (post-ack rollback). The prepass fails AFTER the RPC acked.
  let state: ArchState = {
    ...readyState,
    composer: {
      ...initialArchState.composer,
      pendingComposerInputsBySession: { '/s': [imgInput] },
    },
    transcript: {
      ...initialArchState.transcript,
      windowBySession: { '/s': userWindow },
    },
  };

  state = reducer(state, {
    kind: 'Command',
    cmd: {
      kind: 'Send',
      corrId: 'c-postack',
      sessionPath: '/s',
      text: 'hey',
      inputs: [],
      composedText: 'hey',
      localId: 'loc-postack',
      previousSummary: null,
      timestamp: 1,
    },
  }).state;

  // Send-time clear + capture.
  assert.equal(state.composer.pendingComposerInputsBySession['/s'], undefined);
  assert.deepEqual(state.pending.ops['c-postack']?.inputs, [imgInput]);

  // Early ack: the prompt was queued. The snapshot MOVES to promoted (not
  // deleted); composer inputs stay cleared (send time owns the clear).
  state = reducer(state, {
    kind: 'SendResult',
    corrId: 'c-postack',
    sessionPath: '/s',
    ok: true,
    requestId: 'req-postack',
  }).state;
  assert.equal(state.composer.pendingComposerInputsBySession['/s'], undefined);
  assert.deepEqual(state.pending.promoted['c-postack']?.inputs, [imgInput]);

  // Post-ack prepass failure.
  const result = reducer(state, {
    kind: 'PreflightFailed',
    corrId: 'c-postack',
    sessionPath: '/s',
    requestId: 'req-postack',
    error: 'prepass blew up',
  });

  // Composer inputs RESTORED from the promoted snapshot (no data loss).
  assert.deepEqual(result.state.composer.pendingComposerInputsBySession['/s'], [imgInput]);
  // sendRejected carries the inputs.
  const postImperative = result.effects.find((e) => e.kind === 'PostImperative');
  assert.ok(postImperative && postImperative.kind === 'PostImperative');
  assert.equal(postImperative!.imperativeMessage.type, 'sendRejected');
  assert.deepEqual(postImperative!.imperativeMessage.inputs, [imgInput]);
  assert.equal(postImperative!.imperativeMessage.text, 'hey');
  assert.equal(postImperative!.imperativeMessage.localId, 'loc-postack');
});

test('reducer: pre-ack SendResult{ok:false} with no captured inputs restores nothing and omits a non-empty inputs payload', () => {
  // A text-only send (no pending composer inputs) must not resurrect stale
  // attachments on rejection. inputs is [] (captured at send time), so the
  // restore guard (length > 0) is a no-op and sendRejected.inputs is empty.
  let state: ArchState = { ...readyState };
  state = reducer(state, {
    kind: 'Command',
    cmd: {
      kind: 'Send',
      corrId: 'c-textonly',
      sessionPath: '/s',
      text: 'plain',
      inputs: [],
      composedText: 'plain',
      localId: 'loc-textonly',
      previousSummary: null,
      timestamp: 1,
    },
  }).state;
  assert.equal(state.composer.pendingComposerInputsBySession['/s'], undefined);

  const result = reducer(state, {
    kind: 'SendResult',
    corrId: 'c-textonly',
    sessionPath: '/s',
    ok: false,
    error: 'boom',
  });
  // No inputs to restore.
  assert.equal(result.state.composer.pendingComposerInputsBySession['/s'], undefined);
  const postImperative = result.effects.find((e) => e.kind === 'PostImperative');
  assert.ok(postImperative && postImperative.kind === 'PostImperative');
  assert.deepEqual(postImperative!.imperativeMessage.inputs, []);
});

// ─── Brief H: retry-without-pruning threads + restores the prior pruning mode ─
test('reducer: Send command threads priorPruningMode to the SendRpc effect (Brief H retry-without-pruning)', () => {
  const result = reducer(readyState, {
    kind: 'Command',
    cmd: { kind: 'Send', corrId: 'c-rp', sessionPath: '/s', text: 'hi', inputs: [], composedText: 'hi', localId: 'loc-rp', previousSummary: null, priorPruningMode: 'auto', timestamp: 1 },
  });
  const sendRpc = result.effects.find((e) => e.kind === 'SendRpc');
  assert.ok(sendRpc, 'normal-path Send emits a SendRpc effect');
  assert.equal((sendRpc as { priorPruningMode?: string }).priorPruningMode, 'auto', 'priorPruningMode threaded to SendRpc');

  // A normal send (no priorPruningMode) threads undefined — the EffectRunner
  // leaves pruning untouched.
  const normal = reducer(readyState, {
    kind: 'Command',
    cmd: { kind: 'Send', corrId: 'c-norm', sessionPath: '/s', text: 'hi', inputs: [], composedText: 'hi', localId: 'loc-norm', previousSummary: null, timestamp: 1 },
  });
  const normalSendRpc = normal.effects.find((e) => e.kind === 'SendRpc');
  assert.ok(normalSendRpc);
  assert.equal((normalSendRpc as { priorPruningMode?: string }).priorPruningMode, undefined, 'no priorPruningMode on a normal send');
});

test('reducer: BackendReadyWatchdogFired restores pruning for dropped "retry without pruning" sends (Brief H)', () => {
  // A retry-without-pruning queued while the backend was down carries the user's
  // prior mode. If the backend never becomes ready (watchdog fires), the queued
  // send is dropped WITHOUT ever reaching the in-flight restore path — so the
  // reducer emits a SetPruningSettings effect to restore the prior mode, else
  // pruning would be left permanently off.
  const state: ArchState = {
    ...initialArchState,
    settings: { ...initialArchState.settings, backendReady: false, pruningSettings: { ...initialArchState.settings.pruningSettings, mode: 'off' } },
    pending: {
      ...initialArchState.pending,
      backendReadyQueueBySession: {
        '/s': [{ sessionPath: '/s', corrId: 'c-r1', text: 'hi', inputs: [], composedText: 'hi', localId: 'loc-r1', previousSummary: null, timestamp: 1, priorPruningMode: 'auto' }],
      },
    },
  };
  const result = reducer(state, { kind: 'BackendReadyWatchdogFired' } as any);
  const restore = result.effects.find((e) => e.kind === 'SetPruningSettings');
  assert.ok(restore, 'a SetPruningSettings restore effect emitted for the dropped retry');
  assert.equal((restore as { settings: { mode?: string } }).settings.mode, 'auto', 'restored to the captured prior mode');
  assert.match(result.state.settings.notice!, /did not become ready/);
  assert.deepEqual(result.state.pending.backendReadyQueueBySession, {});
});
