import { BackendLiveTurnAccumulator } from '../live-turn-accumulator';
import { handleSdkSessionEvent, type BackendSessionEventHandlerDeps } from '../session-event-handler';
import type { SessionContext } from '../../coordinator/server-types.js';
import { LIVE_PIPELINE_PROTOCOL_VERSION } from '../../lib/rpc/live-pipeline.js';

export function createHarness() {
  const emitted: Array<{ event: string; payload?: any }> = [];
  const busyEvents: boolean[] = [];
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
      id: 'request-1', messageIndex: 0, modelId: 'model-1',
      provider: 'provider-1', aborted: false, liveTurnAccumulator: accumulator,
    },
  } as unknown as SessionContext;
  const deps: BackendSessionEventHandlerDeps = {
    emit: (event, payload) => { emitted.push({ event, payload }); },
    emitBusyChanged: (_context, busy) => { busyEvents.push(busy); },
    emitContextUsageChanged: () => undefined,
    emitSessionOpened: async () => undefined,
    emitSessionListChanged: async () => undefined,
  };
  return { accumulator, context, deps, emitted, busyEvents };
}

export function emitAssistantError(
  harness: ReturnType<typeof createHarness>,
  entryId: string,
  errorMessage: string,
): void {
  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'message_start', message: { role: 'assistant' },
  });
  handleSdkSessionEvent(harness.deps, harness.context, {
    type: 'message_end', sessionEntryId: entryId,
    message: {
      role: 'assistant', content: [], stopReason: 'error', errorMessage,
      usage: { input: 1, output: 0 },
    },
  });
}
