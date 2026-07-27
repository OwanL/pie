import test from 'node:test';
import assert from 'node:assert/strict';

import { BackendLiveTurnAccumulator } from '../../../src/backend/live-turn-accumulator';
import { handleSdkSessionEvent } from '../../../src/backend/session-event-handler';
import type { SessionContext } from '../../../src/backend/server-types';
import { LIVE_PIPELINE_PROTOCOL_VERSION } from '../../../src/shared/live-pipeline-protocol';

function createHarness() {
  const emitted: Array<{ event: string; payload?: any }> = [];
  const accumulator = new BackendLiveTurnAccumulator({
    protocolVersion: LIVE_PIPELINE_PROTOCOL_VERSION,
    sessionPath: '/session.jsonl',
    requestId: 'request-1',
    turnId: 'turn-1',
    attemptId: 'attempt-1',
    canonicalMessageId: 'request-1:1',
    modelId: 'model-1',
    startedAt: 1_000,
  });
  const context = {
    runtime: {},
    session: {
      isStreaming: true,
      model: { id: 'model-1', provider: 'provider-1' },
      sessionManager: { getBranch: () => [] },
    },
    sessionPath: '/session.jsonl',
    unsubscribe: () => undefined,
    busySeq: 0,
    activeRequest: {
      id: 'request-1',
      messageIndex: 0,
      modelId: 'model-1',
      provider: 'provider-1',
      aborted: false,
      liveTurnAccumulator: accumulator,
    },
  } as unknown as SessionContext;
  const deps = {
    emit: (event: string, payload?: unknown) => emitted.push({ event, payload }),
    emitBusyChanged: () => undefined,
    emitContextUsageChanged: () => undefined,
    emitSessionOpened: async () => undefined,
    emitSessionListChanged: async () => undefined,
    recoverStuckSession: () => undefined,
  };
  return { accumulator, context, deps, emitted };
}

function emitAssistantError(
  harness: ReturnType<typeof createHarness>,
  entryId: string,
  errorMessage: string,
): void {
  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'message_start',
    message: { role: 'assistant' },
  });
  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'message_end',
    sessionEntryId: entryId,
    message: {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage,
      usage: { input: 1, output: 0 },
    },
  });
}

test('a retryable error does not terminalize and tombstone the still-running live turn', () => {
  const harness = createHarness();

  emitAssistantError(harness, 'error-entry-1', 'Connection error.');
  assert.equal(harness.accumulator.checkpoint().terminal, undefined);
  assert.ok(harness.context.activeRequest?.pendingErrorTerminal);
  assert.equal(
    harness.emitted.some((entry) =>
      entry.event === 'live.semantic' && entry.payload?.kind === 'turn.terminal'),
    false,
  );

  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'agent_end',
    willRetry: true,
  });
  assert.equal(harness.accumulator.checkpoint().terminal, undefined);
  assert.equal(harness.context.activeRequest?.pendingErrorTerminal, undefined);

  emitAssistantError(harness, 'error-entry-final', '429 quota exceeded');
  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'agent_end',
    willRetry: false,
  });

  const terminal = harness.context.terminalLiveTurn?.accumulator.checkpoint().terminal;
  assert.equal(terminal?.status, 'error');
  assert.equal(terminal?.durableEntryId, 'error-entry-final');
  assert.equal(harness.context.activeRequest, undefined);
  assert.equal(
    harness.emitted.filter((entry) =>
      entry.event === 'live.semantic' && entry.payload?.kind === 'turn.terminal').length,
    1,
  );
});
