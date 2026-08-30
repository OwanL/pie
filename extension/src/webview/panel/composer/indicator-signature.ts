import type { ChatMessage, SystemPromptEntry, ToolCall } from '../../../shared/protocol';
import { getSubagentResultEntries } from '../../../shared/subagent-result';
import { isRecord } from '../../../shared/type-guards';

/**
 * Bounded fingerprints that gate the O(transcript) indicator walks in
 * {@link useComposerIndicators}. The host posts a structured-cloned `ViewState`
 * ~7×/sec while streaming, so the transcript array (and every nested object)
 * gets a fresh reference even when byte-identical. Usage/cost fingerprints use
 * lifecycle fields and revisions; the context-breakdown fingerprint also hashes
 * legacy body-only records, retaining only fixed-size signatures in memo keys.
 *
 * The guarded data is append-only or immutable under the host protocol: usage
 * lands at `MessageFinished`, tool previews advance their seq, and completed
 * durable records do not mutate. Streaming message text is represented by its
 * append-only length. Legacy tool records without those revisions use content
 * hashes so same-length result replacements still invalidate correctly.
 */

/**
 * O(trailing queued follow-ups). Guards {@link buildSessionTokenUsage} and
 * {@link buildCompletedCostSummary}, which sum per-message usage. Usage lands
 * only at `MessageFinished` and is immutable afterwards, so
 * `length + last-non-queued-message id/status/usage-total` captures every
 * transition: appends/removes (length) and a turn finishing (status flips +
 * `usage` appears). Queued follow-ups project after the active assistant turn,
 * so they are skipped to keep that turn in the fingerprint.
 */
export function transcriptUsageSignature(transcript: readonly ChatMessage[]): string {
  const last = lastNonQueuedMessage(transcript);
  return `${transcript.length}|${last?.id ?? ''}|${last?.status ?? ''}|${last?.usage?.totalTokens ?? ''}`;
}

/**
 * O(streaming messages) — in practice O(1) (one streaming message). A
 * fingerprint of the streaming message's growing prose. Used by memos whose
 * result legitimately changes as the streaming content grows: the context-window
 * breakdown's ESTIMATED branch (when no live `contextUsage.tokens` is reported)
 * and the live cost estimate. Empty when nothing is streaming.
 *
 * Uses `markdown.length` + `thinking.length` (not a BPE estimate) deliberately:
 * streaming prose is APPEND-ONLY (the reducer concatenates deltas), so its
 * length strictly grows every delta and the signature changes every delta —
 * exactly when the gated result (an `estimateTextTokens` estimate of that same
 * prose) legitimately changes. A same-length content swap of a streaming
 * message's prose cannot occur mid-stream, so the length proxy is sound here
 * and avoids re-running BPE in the signature on every tick.
 */
export function streamingContentSignature(transcript: readonly ChatMessage[]): string {
  const parts: string[] = [];
  for (const m of transcript) {
    if (m.status !== 'streaming') continue;
    parts.push(`${m.id}:${m.markdown.length}:${(m.thinking ?? '').length}`);
  }
  return parts.join(',');
}

/**
 * O(total prompt text) — prompts are few and usually small. Guards the
 * context-window breakdown's system-prompt contributor, whose value is
 * `estimateTextTokens(prompt.text)` (a real cl100k_base BPE count, which is
 * CONTENT-dependent, not length-dependent). A `text.length` proxy would be
 * unsound: two same-length prompts can tokenize to different token counts, so
 * a same-length system-prompt edit would change the breakdown but not the
 * signature → a stale tooltip. The fixed-size text hash detects any edit while
 * avoiding a copy of the prompt body in every key; availability and disabled
 * state are included because both determine whether the prompt contributes.
 */
const FINGERPRINT_OFFSET = 2166136261;
const FINGERPRINT_PRIME = 16777619;
const SECOND_FINGERPRINT_OFFSET = 0x9e3779b9;

/**
 * Fixed-size content fingerprint. The signature callers use as a memo key must
 * not retain prompt/tool bodies: a long-lived session can contain megabytes of
 * tool output. Include the source length alongside two small hashes so equal
 * length edits do not look unchanged while keeping the resulting key bounded.
 */
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

/**
 * O(trailing queued follow-ups + active message tool calls). Guards
 * the parent-session cost indicator, which snapshots reported or priced
 * subagent usage across the transcript. Terminal results are immutable once landed;
 * typed live previews update their child usage as turns finish. The active
 * tool's monotonic revision gates this fingerprint, and the usage fields below
 * make it change only when accounting changes rather than whenever live prose
 * grows. Mirrors
 * `toolCallsFromMessage` (prefers authoritative ordered `parts`, with the
 * legacy `toolCalls` mirror as fallback) so the fingerprint tracks exactly the
 * calls the walk sees even when renderer transport omits that mirror.
 */
function subagentResultCostFingerprint(rawResult: unknown, depth = 0): string {
  if (depth >= 6 || !isRecord(rawResult)) return '';
  const results = getSubagentResultEntries(rawResult);
  return results.map((result, index) => {
    if (!isRecord(result)) return `${index}:`;
    const usage = isRecord(result.usage) ? result.usage : undefined;
    const model = typeof result.model === 'string' ? result.model : (typeof result.selectedModel === 'string' ? result.selectedModel : '');
    const own = `${index}:${result.exitCode ?? ''}:${model}:${usage?.cost ?? ''}:${usage?.input ?? ''}:${usage?.output ?? ''}:${usage?.cacheRead ?? ''}:${usage?.cacheWrite ?? ''}`;
    if (!Array.isArray(result.messages)) return own;
    const nested: string[] = [];
    for (const message of result.messages) {
      if (!isRecord(message) || message.role !== 'assistant' || !Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (!isRecord(part) || part.type !== 'toolCall' || part.name !== 'subagent') continue;
        nested.push(`${part.id ?? ''}:${subagentResultCostFingerprint(part.result, depth + 1)}`);
      }
    }
    return nested.length > 0 ? `${own}>${nested.join(',')}` : own;
  }).join(';');
}

function lastNonQueuedMessage(transcript: readonly ChatMessage[]): ChatMessage | undefined {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const message = transcript[index];
    if (message?.status !== 'queued') return message;
  }
  return undefined;
}

/**
 * Cheap O(toolCalls) revision of the last non-queued message's subagent tool
 * calls, used to gate the O(result-tree) {@link subagentCostSignature} walk.
 *
 * The host posts a structured-cloned `ViewState` ~7×/sec while streaming, so the
 * `transcript` array (and every nested object) is a fresh reference on every
 * snapshot even when byte-identical. Keying the `subagentCostSignature` memo on
 * the `transcript` ref recomputes the recursive fingerprint walk on every
 * snapshot. This revision is a cheap surrogate built from each tool call's
 * monotonic `seq` (projected from the live `LiveToolRecord.seq`, which advances
 * on every progress AND terminal event). The backend assembles the complete
 * recursively-renderable child preview and emits a progress event whenever it
 * structurally changes — including nested completions, usage/cost updates, and
 * streaming-text appends — so the parent tool's `seq` captures every
 * transition that could change the cost fingerprint.
 *
 * The revision is STABLE while only the streaming prose grows (no `seq` advance
 * → no structural preview change → same fingerprint), and CHANGES exactly when
 * the fingerprint could change. Using it as the `useMemo` dependency for
 * `subagentCostSignature` skips the recursive walk on unchanged snapshots
 * without weakening correctness for nested completion changes (a nested
 * subagent completing advances the parent's `seq`, invalidating the revision).
 */
export function subagentToolCallRevision(transcript: readonly ChatMessage[]): string {
  const last = lastNonQueuedMessage(transcript);
  if (!last) return `${transcript.length}|`;
  const partTcs = last.parts
    ?.filter((p) => p.kind === 'toolCall')
    .map((p) => p.toolCall) ?? [];
  const calls = partTcs.length ? partTcs : (last.toolCalls ?? []);
  const rev = calls
    .map((tc) => `${tc.id}:${tc.status}:${tc.name ?? ''}:${tc.seq ?? 0}:${tc.result !== undefined ? 1 : 0}`)
    .join(',');
  return `${transcript.length}|${rev}`;
}

export function subagentCostSignature(transcript: readonly ChatMessage[]): string {
  const last = lastNonQueuedMessage(transcript);
  if (!last) return `${transcript.length}|`;
  const partTcs = last.parts
    ?.filter((p) => p.kind === 'toolCall')
    .map((p) => p.toolCall) ?? [];
  const calls = partTcs.length ? partTcs : (last.toolCalls ?? []);
  const fp = calls
    .map((tc) => `${tc.id}:${tc.status}:${tc.name ?? ''}:${tc.result !== undefined ? 1 : 0}:${subagentResultCostFingerprint(tc.result)}`)
    .join(',');
  return `${transcript.length}|${fp}`;
}
