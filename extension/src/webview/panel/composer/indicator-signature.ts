import type { ChatMessage, SystemPromptEntry } from '../../../shared/protocol';
import { getSubagentResultEntries } from '../../../shared/subagent-result';
import { isRecord } from '../../../shared/type-guards';

/**
 * Cheap fingerprints that gate the O(transcript) indicator walks in
 * {@link useComposerIndicators}, so they bail when only the streaming message
 * grew instead of re-walking the whole transcript every snapshot.
 *
 * Background: the host posts a structured-cloned `ViewState` ~7×/sec while
 * streaming (`postMessage`'s clone gives every nested object a fresh reference
 * even when byte-identical), so keying a memo on the `transcript` array ref
 * recomputes the walk on every snapshot. These signatures are O(1)/O(small)
 * surrogates that are STABLE while the guarded result is stable and CHANGE
 * whenever the result could change, so the memos skip the walk in the common
 * "only the streaming message grew" case.
 *
 * Correctness contract — why a length + last-non-queued-message fingerprint suffices:
 * The guarded walks read only
 *   - `message.usage` / `message.modelId` — set once at `MessageFinished` on
 *     the active assistant message and immutable afterwards;
 *   - `message.toolCalls` / `message.parts` tool calls — results land
 *     atomically on that active message and are immutable once completed;
 *   - `message.markdown` / `message.thinking` — only the active streaming
 *     message grows.
 * None of these mutate a non-streaming message after it completes, and the
 * only content transition during a turn happens on the active message. Queued
 * follow-ups may project after it, so the signatures skip those trailing rows.
 * Appends/removes still change `transcript.length`.
 *
 * This deliberately does NOT stabilize the whole transcript (the decision
 * documented in `view-state-stabilize.ts`): the signatures are O(1)/O(small),
 * and the walks themselves only run (over the real transcript) when a
 * signature actually changes.
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
 * O(total prompt text) — prompts are few and small. Guards the context-window
 * breakdown's system-prompt contributor, whose value is
 * `estimateTextTokens(prompt.text)` (a real cl100k_base BPE count, which is
 * CONTENT-dependent, not length-dependent). A `text.length` proxy would be
 * unsound: two same-length prompts can tokenize to different token counts, so
 * a same-length system-prompt edit would change the breakdown but not the
 * signature → a stale tooltip. Including each prompt's availability + full text
 * is unambiguously faithful (any content change is detected) and cheaper than
 * re-running BPE in the signature. It is intentionally over-faithful — a
 * same-token-count text edit needlessly recomputes the breakdown — because
 * system-prompt edits are rare (config edits, not mid-stream) and the cost of
 * including the text is far below the O(transcript) BPE walk this signature
 * gates.
 */
export function systemPromptsSignature(systemPrompts: readonly SystemPromptEntry[]): string {
  let acc = `${systemPrompts.length}`;
  for (const p of systemPrompts) {
    acc += `|${p.availability}:${p.text}`;
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
 * `toolCallsFromMessage` (prefers `toolCalls` when non-empty, else the `parts`
 * tool-call entries) so the fingerprint tracks exactly the calls the walk sees.
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
  const tcs = last.toolCalls ?? [];
  const partTcs = last.parts
    ?.filter((p) => p.kind === 'toolCall')
    .map((p) => p.toolCall) ?? [];
  const calls = tcs.length ? tcs : partTcs;
  const rev = calls
    .map((tc) => `${tc.id}:${tc.status}:${tc.name ?? ''}:${tc.seq ?? 0}:${tc.result !== undefined ? 1 : 0}`)
    .join(',');
  return `${transcript.length}|${rev}`;
}

export function subagentCostSignature(transcript: readonly ChatMessage[]): string {
  const last = lastNonQueuedMessage(transcript);
  if (!last) return `${transcript.length}|`;
  const tcs = last.toolCalls ?? [];
  const partTcs = last.parts
    ?.filter((p) => p.kind === 'toolCall')
    .map((p) => p.toolCall) ?? [];
  const calls = tcs.length ? tcs : partTcs;
  const fp = calls
    .map((tc) => `${tc.id}:${tc.status}:${tc.name ?? ''}:${tc.result !== undefined ? 1 : 0}:${subagentResultCostFingerprint(tc.result)}`)
    .join(',');
  return `${transcript.length}|${fp}`;
}
