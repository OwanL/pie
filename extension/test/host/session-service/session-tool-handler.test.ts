import assert from 'node:assert/strict';
import test from 'node:test';

import { createInitialArchState } from '../../../src/host/core/arch-state';
import { onToolFinished, onToolStarted } from '../../../src/host/session-service/handlers/tools';
import type { ToolCall } from '../../../src/shared/protocol';

test('canonical semantic tool handlers keep observers but skip legacy transcript ToolCall events', () => {
  const sessionPath = '/workspace/session.jsonl';
  const archState = createInitialArchState();
  const observed: ToolCall[] = [];
  const dispatched: unknown[] = [];
  const deps = {
    getArchState: () => archState,
    dispatchArch: (event: unknown) => dispatched.push(event),
    runObserver: {
      onToolStarted: (_path: string, toolCall: ToolCall) => observed.push(toolCall),
      onToolFinished: (_path: string, toolCall: ToolCall) => observed.push(toolCall),
    } as any,
    state: { touchSessionTranscript: () => undefined } as any,
    scheduleRender: () => undefined,
    requireEventSessionPath: (_eventName: string, path?: string) => path ?? null,
  };

  onToolStarted({
    requestId: 'req', sessionPath, messageId: 'live-message', toolCallId: 'tool',
    name: 'read', input: {}, startedAt: 10, parallelGroupId: 'batch',
  }, deps, { skipTranscriptMutation: true });
  onToolFinished({
    requestId: 'req', sessionPath, messageId: 'live-message', toolCallId: 'tool',
    name: 'read', input: {}, result: 'done', status: 'completed', parallelGroupId: 'batch',
  }, deps, { skipTranscriptMutation: true });

  assert.deepEqual(dispatched, []);
  assert.equal(observed.length, 2);
  assert.equal(observed[0]?.parallelGroupId, 'batch');
  assert.equal(observed[1]?.parallelGroupId, 'batch');
});

test('tool.finished keeps backend name and input when the owner message is unavailable', () => {
  const sessionPath = '/workspace/session.jsonl';
  const archState = createInitialArchState();
  let observed: ToolCall | undefined;
  const dispatched: unknown[] = [];

  onToolFinished({
    requestId: 'req-1',
    sessionPath,
    messageId: 'missing-owner',
    toolCallId: 'tool-1',
    name: 'bash',
    input: { command: 'npm test' },
    result: { exitCode: 1 },
    status: 'failed',
    durationMs: 250,
  }, {
    getArchState: () => archState,
    dispatchArch: (event) => dispatched.push(event),
    runObserver: {
      onToolFinished: (_path: string, toolCall: ToolCall) => { observed = toolCall; },
    } as any,
    state: { touchSessionTranscript: () => undefined } as any,
    scheduleRender: () => undefined,
    requireEventSessionPath: (_eventName, path) => path ?? null,
  });

  assert.equal(observed?.name, 'bash');
  assert.deepEqual(observed?.input, { command: 'npm test' });
  assert.equal(observed?.durationMs, 250);
  assert.deepEqual(dispatched, [{
    kind: 'ToolCall',
    sessionPath,
    messageId: 'missing-owner',
    toolCall: observed,
  }]);
});
