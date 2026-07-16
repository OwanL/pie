import assert from 'node:assert/strict';
import test from 'node:test';

import { dispatchSessionBackendEvent } from '../../../../src/host/core/event-dispatch';
import type { SessionBackendEventHandlers } from '../../../../src/host/core/event-dispatch';

function createHandlers() {
  const calls: Array<{ name: string; payload: unknown }> = [];

  const handlers: SessionBackendEventHandlers = {
    onTurnSemantic: (payload) => calls.push({ name: 'live.semantic', payload }),
    onLiveLifecycle: (payload) => calls.push({ name: 'live.lifecycle', payload }),
    onSessionOpened: (payload) => calls.push({ name: 'session.opened', payload }),
    onSessionListChanged: (payload) => calls.push({ name: 'session.list.changed', payload }),
    onMessageStarted: (payload) => calls.push({ name: 'message.started', payload }),
    onMessageDelta: (payload) => calls.push({ name: 'message.delta', payload }),
    onMessageThinking: (payload) => calls.push({ name: 'message.thinking', payload }),
    onMessageToolCallDelta: (payload) => calls.push({ name: 'message.toolCallDelta', payload }),
    onToolStarted: (payload) => calls.push({ name: 'tool.started', payload }),
    onToolFinished: (payload) => calls.push({ name: 'tool.finished', payload }),
    onToolProgress: (payload) => calls.push({ name: 'tool.progress', payload }),
    onMessageFinished: (payload) => calls.push({ name: 'message.finished', payload }),
    onCustomMessage: (payload) => calls.push({ name: 'message.custom', payload }),
    onMessageAborted: (payload) => calls.push({ name: 'message.aborted', payload }),
    onPreflightFailed: (payload) => calls.push({ name: 'preflight.failed', payload }),
    onQueuedDelivered: (payload) => calls.push({ name: 'message.queuedDelivered', payload }),
    onRetryStarted: (payload) => calls.push({ name: 'retry.started', payload }),
    onRetryEnded: (payload) => calls.push({ name: 'retry.ended', payload }),
    onRetryMeasured: (payload) => calls.push({ name: 'retry.measured', payload }),
    onCompaction: (payload) => calls.push({ name: 'compaction.ended', payload }),
    onOperationalError: (payload) => calls.push({ name: 'operational-error', payload }),
    onRetryStuck: (payload) => calls.push({ name: 'retry.stuck', payload }),
    onBusyChanged: (payload) => calls.push({ name: 'busy.changed', payload }),
    onContextUsageChanged: (payload) => calls.push({ name: 'contextUsage.changed', payload }),
    onExtensionUIRequest: (payload) => calls.push({ name: 'extension_ui.request', payload }),
    onError: (payload) => calls.push({ name: 'error', payload }),
  };

  return { handlers, calls };
}

test('dispatchSessionBackendEvent validates sequenced live envelopes', () => {
  const { handlers, calls } = createHandlers();
  const payload = {
    protocolVersion: 5, sessionPath: '/workspace/session.jsonl', requestId: 'request',
    turnId: 'turn', attemptId: 'attempt', seq: 1, occurredAt: 100,
    kind: 'turn.started', canonicalMessageId: 'message', startedAt: 90,
  };
  dispatchSessionBackendEvent({ event: 'live.semantic', payload }, handlers);
  dispatchSessionBackendEvent({ event: 'live.semantic', payload: { ...payload, seq: 0 } }, handlers);
  dispatchSessionBackendEvent({ event: 'live.semantic', payload: { ...payload, protocolVersion: 6 } }, handlers);
  dispatchSessionBackendEvent({ event: 'live.semantic', payload: {
    ...payload, kind: 'tool.progress', executionId: 'execution', seq: 100, baseSeq: 1,
    baseProgressRevision: 0, progressRevision: 1,
    update: { kind: 'snapshot', preview: { kind: 'generic', summary: 'invalid jump' } },
  } }, handlers);
  assert.deepEqual(calls, [{ name: 'live.semantic', payload }]);
});

test('dispatchSessionBackendEvent routes message.custom payloads', () => {
  const { handlers, calls } = createHandlers();
  const payload = {
    requestId: 'req-1',
    sessionPath: '/workspace/session.jsonl',
    message: {
      id: 'req-1:custom:1',
      role: 'system' as const,
      createdAt: '2026-01-01T00:00:00.000Z',
      markdown: 'Kept 4/14 skills',
      status: 'completed' as const,
      customType: 'pruning-result',
      customDetails: {
        includedSkills: ['systematic-debugging'],
        excludedSkills: ['frontend-design'],
        includedTools: ['read'],
        excludedTools: ['web_search'],
        mode: 'auto' as const,
        skillTokensSaved: 100,
        toolTokensSaved: 50,
      },
    },
  };

  dispatchSessionBackendEvent({ event: 'message.custom', payload }, handlers);

  assert.deepEqual(calls, [{ name: 'message.custom', payload }]);
});

test('dispatchSessionBackendEvent preserves terminal tool metadata', () => {
  const { handlers, calls } = createHandlers();
  const payload = {
    requestId: 'req-tool',
    sessionPath: '/workspace/session.jsonl',
    messageId: 'message-1',
    toolCallId: 'tool-1',
    name: 'bash',
    input: { command: 'npm test' },
    result: { exitCode: 0 },
    status: 'completed' as const,
    durationMs: 25,
  };

  dispatchSessionBackendEvent({ event: 'tool.finished', payload }, handlers);

  assert.deepEqual(calls, [{ name: 'tool.finished', payload }]);
});

test('dispatchSessionBackendEvent routes preflight.failed payloads', () => {
  const { handlers, calls } = createHandlers();
  const payload = {
    requestId: 'req-9',
    sessionPath: '/workspace/session.jsonl',
    error: 'Prompt rejected before PI accepted the request.',
  };

  dispatchSessionBackendEvent({ event: 'preflight.failed', payload }, handlers);

  assert.deepEqual(calls, [{ name: 'preflight.failed', payload }]);
});

test('dispatchSessionBackendEvent routes message.aborted payloads with interruption metadata', () => {
  const { handlers, calls } = createHandlers();
  const payload = {
    requestId: 'req-2',
    sessionPath: '/workspace/session.jsonl',
    messageId: 'req-2:1',
    userInitiated: false,
    reason: 'The session stopped unexpectedly before the assistant finished responding.',
  };

  dispatchSessionBackendEvent({ event: 'message.aborted', payload }, handlers);

  assert.deepEqual(calls, [{ name: 'message.aborted', payload }]);
});

test('dispatchSessionBackendEvent drops a malformed preflight.failed payload', () => {
  const { handlers, calls } = createHandlers();
  // Missing `error` — fails the guard, must be dropped (not cast-and-hoped).
  const payload = { requestId: 'req-9', sessionPath: '/workspace/session.jsonl' };

  dispatchSessionBackendEvent({ event: 'preflight.failed', payload }, handlers);

  assert.deepEqual(calls, []);
});

test('dispatchSessionBackendEvent drops a malformed message.aborted payload', () => {
  const { handlers, calls } = createHandlers();
  const payload = {
    requestId: 'req-2',
    sessionPath: '/workspace/session.jsonl',
    userInitiated: 'nope',
  };

  dispatchSessionBackendEvent({ event: 'message.aborted', payload }, handlers);

  assert.deepEqual(calls, []);
});

test('dispatchSessionBackendEvent routes tool-call draft deltas', () => {
  const { handlers, calls } = createHandlers();
  const payload = {
    requestId: 'req-1',
    sessionPath: '/workspace/session.jsonl',
    messageId: 'assistant-1',
    toolCallId: 'tc-1',
    name: 'bash',
    delta: '{"command":',
  };

  dispatchSessionBackendEvent({ event: 'message.toolCallDelta', payload }, handlers);

  assert.deepEqual(calls, [{ name: 'message.toolCallDelta', payload }]);
});

test('dispatchSessionBackendEvent routes correlated retry timing', () => {
  const { handlers, calls } = createHandlers();
  const payload = {
    sessionPath: '/workspace/session.jsonl',
    requestId: 'req-1',
    retryId: 'req-1:2',
    measuredDelayMs: 4_025,
    durationMs: 5_100,
  };
  dispatchSessionBackendEvent({ event: 'retry.measured', payload }, handlers);
  assert.deepEqual(calls, [{ name: 'retry.measured', payload }]);
});

test('dispatchSessionBackendEvent routes operational-error payloads', () => {
  const { handlers, calls } = createHandlers();
  const payload = {
    code: 'INTERRUPT_ABORT_STUCK',
    message: 'message.interrupt: session.abort() did not settle within 30000ms — activeRequest force-cleared.',
    sessionPath: '/workspace/session.jsonl',
    requestId: 'req-1',
  };

  dispatchSessionBackendEvent({ event: 'operational-error', payload }, handlers);

  assert.deepEqual(calls, [{ name: 'operational-error', payload }]);
});

test('dispatchSessionBackendEvent routes operational-error without a requestId', () => {
  const { handlers, calls } = createHandlers();
  const payload = {
    code: 'RETRY_STUCK',
    message: 'A retry has not completed within 90000ms.',
    sessionPath: '/workspace/session.jsonl',
  };

  dispatchSessionBackendEvent({ event: 'operational-error', payload }, handlers);

  assert.deepEqual(calls, [{ name: 'operational-error', payload }]);
});

test('dispatchSessionBackendEvent routes retry.stuck payloads', () => {
  const { handlers, calls } = createHandlers();
  const payload = {
    sessionPath: '/workspace/session.jsonl',
    delayMs: 30_000,
    graceMs: 60_000,
    requestId: 'req-1',
  };

  dispatchSessionBackendEvent({ event: 'retry.stuck', payload }, handlers);

  assert.deepEqual(calls, [{ name: 'retry.stuck', payload }]);
});

test('dispatchSessionBackendEvent drops a malformed operational-error payload', () => {
  const { handlers, calls } = createHandlers();
  // Missing `message` — fails the guard, must be dropped.
  const payload = { code: 'RETRY_STUCK', sessionPath: '/workspace/session.jsonl' };

  dispatchSessionBackendEvent({ event: 'operational-error', payload }, handlers);

  assert.deepEqual(calls, []);
});

test('dispatchSessionBackendEvent drops a malformed retry.stuck payload', () => {
  const { handlers, calls } = createHandlers();
  // `graceMs` is a string — fails the guard, must be dropped.
  const payload = { sessionPath: '/workspace/session.jsonl', delayMs: 30_000, graceMs: '60000' };

  dispatchSessionBackendEvent({ event: 'retry.stuck', payload }, handlers);

  assert.deepEqual(calls, []);
});
