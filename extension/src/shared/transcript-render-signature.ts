import type { ViewState } from './protocol/webview';

const TEXT_SAMPLE_CHARS = 192;

/**
 * Compact identity for the transcript state that must be visible after a
 * snapshot commit. It covers the bounded tail plus any earlier streaming
 * message: queued follow-ups can push the still-running tool owner out of the
 * tail, and acknowledging only the tail would bless a visibly stale tool card.
 *
 * Hashing is deliberately bounded. Tool results can contain complete nested
 * subagent transcripts, and this function runs in both processes (twice in the
 * webview) for every streaming snapshot. Each host ToolCall event advances the
 * message's O(1) `toolStateRevision`, so arbitrary partial-result/status
 * changes remain visible to the checksum without serializing result payloads
 * or scanning tool-call collections. Long text and drafted arguments use fixed
 * head/middle/tail samples; their full lengths catch normal append-only
 * streaming.
 *
 * This is deterministic and dependency-free so the host and webview calculate
 * the same value. It is a correctness checksum, not a cryptographic hash.
 */
export function transcriptRenderSignature(state: Pick<
  ViewState,
  | 'activeSession'
  | 'busy'
  | 'prepassPhase'
  | 'retryStatus'
  | 'transcript'
>): string {
  const tailStart = Math.max(0, state.transcript.length - 3);
  const earlierStreaming = state.transcript
    .slice(0, tailStart)
    .filter((message) => message.status === 'streaming')
    .map(messageRenderIdentity);
  const tail = state.transcript.slice(tailStart).map(messageRenderIdentity);
  const source = JSON.stringify({
    sessionPath: state.activeSession?.path ?? null,
    busy: state.busy,
    prepassPhase: state.prepassPhase,
    retryStatus: state.retryStatus,
    transcriptCount: state.transcript.length,
    earlierStreaming,
    tail,
  });
  return fnv1a(source);
}

function messageRenderIdentity(message: ViewState['transcript'][number]) {
  const orderedToolCallCount = message.parts?.reduce(
    (count, part) => count + (part.kind === 'toolCall' ? 1 : 0),
    0,
  ) ?? 0;
  return {
    id: message.id,
    status: message.status,
    markdown: sampledTextIdentity(message.markdown),
    thinking: sampledTextIdentity(message.thinking ?? ''),
    draftingToolCall: message.draftingToolCall
      ? [
          message.draftingToolCall.id,
          message.draftingToolCall.name,
          sampledTextIdentity(message.draftingToolCall.argumentsText),
        ]
      : null,
    toolCallCount: orderedToolCallCount || message.toolCalls?.length || 0,
    toolStateRevision: message.toolStateRevision ?? 0,
  };
}

function sampledTextIdentity(value: string): [length: number, fingerprint: string] {
  if (value.length <= TEXT_SAMPLE_CHARS * 3) {
    return [value.length, fnv1a(value)];
  }

  const middleStart = Math.max(0, Math.floor(value.length / 2) - Math.floor(TEXT_SAMPLE_CHARS / 2));
  const sample = [
    value.slice(0, TEXT_SAMPLE_CHARS),
    value.slice(middleStart, middleStart + TEXT_SAMPLE_CHARS),
    value.slice(-TEXT_SAMPLE_CHARS),
  ].join('\u0000');
  return [value.length, fnv1a(sample)];
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
