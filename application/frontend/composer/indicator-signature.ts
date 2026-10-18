import type { ChatMessage, SystemPromptEntry, ToolCall } from '../../lib/protocol/index.js';

/** Content fingerprints preserve indicator memoization across structured-cloned
 * host snapshots. Revisions identify live tools; legacy bodies use hashes so
 * same-length replacements invalidate without retaining large bodies in keys. */

/** Scans the transcript for streaming rows. Prose uses append-only lengths;
 * draft tool revisions (or legacy argument digests) also invalidate tool-only
 * updates. The retained key is bounded, not the traversal cost. */
export function streamingContentSignature(transcript: readonly ChatMessage[]): string {
  const parts: string[] = [];
  for (const m of transcript) {
    if (m.status !== 'streaming') continue;
    const toolCalls = (m.toolCalls ?? [])
      .filter((toolCall) => toolCall.status === 'drafting' || toolCall.status === 'ready')
      .map((toolCall) => {
        const hasLiveRevision = typeof toolCall.seq === 'number'
          && Number.isFinite(toolCall.seq) && toolCall.seq > 0;
        const argsText = toolCall.argumentsText
          ?? (typeof toolCall.input === 'string' ? toolCall.input : '');
        const argumentRevision = hasLiveRevision
          ? `seq:${toolCall.seq}`
          : `args:${boundedStringSignature(argsText)}`;
        return `${toolCallContextSignature(toolCall)}:${argumentRevision}`;
      })
      .join(';');
    const legacyDraft = m.draftingToolCall
      ? `${m.draftingToolCall.id}:${boundedStringSignature(m.draftingToolCall.name)}:${boundedStringSignature(m.draftingToolCall.argumentsText)}`
      : '';
    parts.push(`${m.id}:${m.markdown.length}:${(m.thinking ?? '').length}:tools:${toolCalls}:draft:${legacyDraft}`);
  }
  return parts.join(',');
}

// Prompt fingerprints must include content, not just length: same-length edits
// can change BPE counts. Availability/disabled state also affects contributions.
const FINGERPRINT_OFFSET = 2166136261;
const FINGERPRINT_PRIME = 16777619;
const SECOND_FINGERPRINT_OFFSET = 0x9e3779b9;

/** Full-content fingerprint with fixed-size storage, including same-length edits. */
function boundedStringSignature(value: string): string {
  let first = FINGERPRINT_OFFSET;
  let second = SECOND_FINGERPRINT_OFFSET;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, FINGERPRINT_PRIME);
    second = Math.imul(second ^ (code + index), 2246822519);
  }
  return `${value.length}:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`;
}

/** Match the value-to-text path used by context-window token estimation, but
 * retain only a bounded length/hash pair in the invalidation signature. */
function boundedValueSignature(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return `string:${boundedStringSignature(value)}`;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? 'undefined'
      : `json:${boundedStringSignature(serialized)}`;
  } catch {
    return `string:${boundedStringSignature(String(value))}`;
  }
}

/**
 * Signature of the fields from a tool call that affect
 * `buildContextWindowBreakdown`. Live calls use the host-owned monotonic seq
 * as their bounded preview revision; durability-confirmed terminal calls use
 * their stable entry identity, and legacy calls without either revision use a
 * content hash so a same-length result edit still invalidates. This mirrors
 * the breakdown token cache's immutable/revisioned contract without copying
 * result bodies into a memo key.
 */
export function toolCallContextSignature(toolCall: ToolCall): string {
  const hasLiveRevision = typeof toolCall.seq === 'number'
    && Number.isFinite(toolCall.seq) && toolCall.seq > 0;
  const hasDurableRevision = Boolean(toolCall.durableEntryId);
  const revision = hasDurableRevision
    ? `durable:${boundedStringSignature(toolCall.durableEntryId!)}`
    : hasLiveRevision
      ? `seq:${toolCall.seq}`
      : `result:${boundedValueSignature(toolCall.result)}`;
  // A live seq advances for every assembled tool state change and a durable
  // entry is immutable, so avoid re-hashing a potentially large input on every
  // structured-cloned snapshot. Legacy records without either revision need
  // the content hash because their input/result can change under one id.
  const input = hasDurableRevision || hasLiveRevision
    ? 'revisioned'
    : boundedValueSignature(toolCall.input);
  return [
    `id:${boundedStringSignature(toolCall.id)}`,
    `name:${boundedStringSignature(toolCall.name)}`,
    `status:${toolCall.status}`,
    revision,
    `input:${input}`,
  ].join(';');
}

/**
 * Signature of every transcript field read by `buildContextWindowBreakdown`.
 * Stable message rows use their ids and live rows use bounded lengths; tool
 * payloads use fixed-size hashes when no lifecycle revision is available and
 * otherwise use that revision. Message/tool counts and identities remain in the
 * digest so supported replacements cannot leave a stale breakdown behind.
 */
export function contextBreakdownTranscriptSignature(transcript: readonly ChatMessage[]): string {
  let first = FINGERPRINT_OFFSET;
  let second = SECOND_FINGERPRINT_OFFSET;
  const append = (value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      first = Math.imul(first ^ code, FINGERPRINT_PRIME);
      second = Math.imul(second ^ (code + index), 2246822519);
    }
    first = Math.imul(first ^ 0, FINGERPRINT_PRIME);
    second = Math.imul(second ^ 0, 2246822519);
  };

  for (const message of transcript) {
    append(message.id);
    append(message.role);
    append(message.status);
    append(message.customType ?? '');
    // Completed transcript rows are immutable by the host protocol; their
    // stable entry/id is therefore the bounded revision. Streaming prose is
    // append-only, so its length captures each estimation change. Queued user
    // rows remain editable before send, so hash their bounded body instead.
    const stableRevision = `stable:${boundedStringSignature(message.durableEntryId ?? message.id)}`;
    const markdownSignature = message.status === 'streaming' && typeof message.markdown === 'string'
      ? `streaming:${message.markdown.length}`
      : message.status === 'queued'
        ? `queued:${boundedValueSignature(message.markdown)}`
        : stableRevision;
    const thinkingSignature = message.status === 'streaming' && typeof message.thinking === 'string'
      ? `streaming:${message.thinking.length}`
      : message.status === 'queued'
        ? `queued:${boundedValueSignature(message.thinking)}`
        : stableRevision;
    append(`markdown:${markdownSignature}`);
    append(`thinking:${thinkingSignature}`);

    if (message.role !== 'assistant') continue;
    const partToolCalls = message.parts
      ?.filter((part) => part.kind === 'toolCall')
      .map((part) => part.toolCall) ?? [];
    const toolCalls = partToolCalls.length > 0 ? partToolCalls : (message.toolCalls ?? []);
    append(`tools:${toolCalls.length}`);
    for (const toolCall of toolCalls) append(toolCallContextSignature(toolCall));
  }

  return `${transcript.length}:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`;
}

export function systemPromptsSignature(systemPrompts: readonly SystemPromptEntry[]): string {
  let acc = `${systemPrompts.length}`;
  for (const p of systemPrompts) {
    // `disabled` affects whether the prompt is sent and therefore its token
    // contribution. Hash the text instead of embedding a potentially large
    // prompt body in every ViewState-derived key.
    acc += `|${p.availability}:${p.disabled === true ? 1 : 0}:${boundedStringSignature(p.text)}`;
  }
  return acc;
}
