import assert from 'node:assert/strict';
import test from 'node:test';

import { dispatchSessionBackendEvent } from '../src/host/core/event-dispatch';
import type { SessionBackendEventHandlers } from '../src/host/core/event-dispatch';

function createHandlers() {
  const calls: Array<{ name: string; payload: unknown }> = [];

  const handlers: SessionBackendEventHandlers = {
    onSessionOpened: (payload) => calls.push({ name: 'session.opened', payload }),
    onSessionListChanged: (payload) => calls.push({ name: 'session.list.changed', payload }),
    onMessageStarted: (payload) => calls.push({ name: 'message.started', payload }),
    onMessageDelta: (payload) => calls.push({ name: 'message.delta', payload }),
    onMessageThinking: (payload) => calls.push({ name: 'message.thinking', payload }),
    onToolStarted: (payload) => calls.push({ name: 'tool.started', payload }),
    onToolFinished: (payload) => calls.push({ name: 'tool.finished', payload }),
    onToolProgress: (payload) => calls.push({ name: 'tool.progress', payload }),
    onMessageFinished: (payload) => calls.push({ name: 'message.finished', payload }),
    onCustomMessage: (payload) => calls.push({ name: 'message.custom', payload }),
    onMessageAborted: (payload) => calls.push({ name: 'message.aborted', payload }),
    onPreflightFailed: (payload) => calls.push({ name: 'preflight.failed', payload }),
    onBusyChanged: (payload) => calls.push({ name: 'busy.changed', payload }),
    onContextUsageChanged: (payload) => calls.push({ name: 'contextUsage.changed', payload }),
    onExtensionUIRequest: (payload) => calls.push({ name: 'extension_ui.request', payload }),
    onError: (payload) => calls.push({ name: 'error', payload }),
  };

  return { handlers, calls };
}

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
