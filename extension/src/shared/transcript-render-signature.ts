import type { ViewState } from './protocol/webview';

/**
 * Compact identity for the transcript state that must be visible after a
 * snapshot commit. The tail is sufficient: live status changes only occur on
 * the current assistant turn, while the count catches structural changes.
 *
 * This is intentionally deterministic and dependency-free so the host and
 * webview can calculate the same value. It is a correctness checksum, not a
 * cryptographic hash.
 */
export function transcriptRenderSignature(state: Pick<
  ViewState,
  | 'activeSession'
  | 'busy'
  | 'prepassPhase'
  | 'retryStatus'
  | 'transcript'
  | 'waitingForSlot'
>): string {
  const tail = state.transcript.slice(-3).map((message) => ({
    id: message.id,
    status: message.status,
    markdownLength: message.markdown.length,
    markdownFingerprint: fnv1a(message.markdown),
    thinkingLength: message.thinking?.length ?? 0,
    thinkingFingerprint: fnv1a(message.thinking ?? ''),
    draftingToolCall: message.draftingToolCall
      ? [
          message.draftingToolCall.id,
          message.draftingToolCall.name,
          message.draftingToolCall.argumentsText.length,
          fnv1a(message.draftingToolCall.argumentsText),
        ]
      : null,
    toolCalls: (message.toolCalls ?? []).map((tool) => [
      tool.id,
      tool.name,
      tool.status,
      serializedIdentity(tool.result),
    ]),
  }));
  const source = JSON.stringify({
    sessionPath: state.activeSession?.path ?? null,
    busy: state.busy,
    prepassPhase: state.prepassPhase,
    retryStatus: state.retryStatus,
    waitingForSlot: state.waitingForSlot,
    transcriptCount: state.transcript.length,
    tail,
  });
  return fnv1a(source);
}

function serializedIdentity(value: unknown): [length: number, fingerprint: string] {
  if (value === undefined) return [0, fnv1a('')];
  try {
    const serialized = JSON.stringify(value) ?? '';
    return [serialized.length, fnv1a(serialized)];
  } catch {
    return [-1, 'unserializable'];
  }
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
