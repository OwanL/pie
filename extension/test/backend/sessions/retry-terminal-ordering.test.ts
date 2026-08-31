import test from 'node:test';
import assert from 'node:assert/strict';

import { BackendLiveTurnAccumulator } from '../../../src/backend/live-turn-accumulator';
import { handleSdkSessionEvent } from '../../../src/backend/session-event-handler';
import type { ActiveRequest, SessionContext } from '../../../src/backend/server-types';
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
      model: { id: 'model-1', provider: 'provider-1', contextWindow: 100_000 },
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

test('overflow compaction re-arms the finalized request before the SDK automatically continues', () => {
  const harness = createHarness();

  emitAssistantError(harness, 'overflow-entry-1', 'prompt is too long: context window exceeded');
  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'agent_end',
    willRetry: false,
  });

  assert.equal(harness.context.activeRequest, undefined, 'the SDK reports agent_end before checking overflow compaction');

  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'compaction_start',
    reason: 'overflow',
  });
  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'compaction_end',
    reason: 'overflow',
    willRetry: true,
    result: {
      summary: 'Compacted context',
      firstKeptEntryId: 'kept-entry',
      tokensBefore: 100_000,
      estimatedTokensAfter: 20_000,
    },
  });

  const continued = harness.context.activeRequest as ActiveRequest | undefined;
  assert.equal(continued?.id, 'request-1', 'overflow recovery keeps the original request correlation');
  assert.notEqual(continued?.liveTurnAccumulator, harness.accumulator, 'the continuation gets a fresh live turn owner');
  assert.equal(continued?.liveTurnAccumulator?.checkpoint().terminal, undefined);

  handleSdkSessionEvent(harness.deps, harness.context, { type: 'agent_start' });
  handleSdkSessionEvent(harness.deps, harness.context, { type: 'turn_start' });
  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'message_start',
    message: { role: 'assistant' },
  });
  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'message_update',
    message: { role: 'assistant' },
    assistantMessageEvent: { type: 'text_delta', delta: 'continued after compaction' },
  });

  assert.equal(
    harness.emitted.some((entry) =>
      entry.event === 'live.semantic'
      && entry.payload?.kind === 'turn.text'
      && entry.payload?.delta === 'continued after compaction'),
    true,
    'the automatically continued reply remains visible to the host',
  );

  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'message_end',
    sessionEntryId: 'continued-entry',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'continued after compaction' }],
      stopReason: 'stop',
      usage: { input: 20_000, output: 20 },
    },
  });
  handleSdkSessionEvent(harness.deps, harness.context, { type: 'agent_end', willRetry: false });

  assert.equal(harness.context.activeRequest, undefined, 'the continued run settles normally');
  const continuationTerminal = [...harness.emitted].reverse().find((entry) =>
    entry.event === 'live.semantic' && entry.payload?.kind === 'turn.terminal');
  assert.equal(continuationTerminal?.payload?.requestId, 'request-1');
  assert.equal(continuationTerminal?.payload?.durableEntryId, 'continued-entry');
});

test('failed overflow compaction discards the finalized recovery candidate', () => {
  const harness = createHarness();

  emitAssistantError(harness, 'overflow-entry-failed', 'context length exceeded');
  handleSdkSessionEvent(harness.deps, harness.context, { type: 'agent_end', willRetry: false });
  handleSdkSessionEvent(harness.deps, harness.context, { type: 'compaction_start', reason: 'overflow' });
  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'compaction_end',
    reason: 'overflow',
    willRetry: false,
    errorMessage: 'Context overflow recovery failed',
  });

  assert.equal(harness.context.activeRequest, undefined);
  assert.equal(harness.context.overflowRecoveryCandidate, undefined);
});

test('silent zero-output context exhaustion also preserves automatic continuation', () => {
  const harness = createHarness();

  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'message_start',
    message: { role: 'assistant' },
  });
  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'message_end',
    sessionEntryId: 'silent-overflow-entry',
    message: {
      role: 'assistant',
      content: [],
      stopReason: 'length',
      usage: { input: 99_000, output: 0 },
    },
  });
  handleSdkSessionEvent(harness.deps, harness.context, { type: 'agent_end', willRetry: false });
  handleSdkSessionEvent(harness.deps, harness.context, { type: 'compaction_start', reason: 'overflow' });
  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'compaction_end',
    reason: 'overflow',
    willRetry: true,
    result: {
      summary: 'Compacted context',
      firstKeptEntryId: 'kept-entry',
      tokensBefore: 99_000,
      estimatedTokensAfter: 20_000,
    },
  });

  assert.equal(harness.context.activeRequest?.id, 'request-1');
  assert.notEqual(harness.context.activeRequest?.liveTurnAccumulator, harness.accumulator);
});

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
