import type { ChatMessage, SystemPromptEntry } from '../../../shared/protocol';
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
 * {@link extractSubagentDirectCost}, which sums `cost` from completed subagent
 * tool calls across the transcript. Completed subagent results are immutable
 * once landed; the only NEW completed calls during a turn arrive on the
 * streaming message, so `length + last-non-queued-message tool-call
 * id/status/name/result-presence` captures every transition without walking the
 * whole transcript. Mirrors
 * `toolCallsFromMessage` (prefers `toolCalls` when non-empty, else the `parts`
 * tool-call entries) so the fingerprint tracks exactly the calls the walk sees.
 */
function subagentResultCostFingerprint(rawResult: unknown, depth = 0): string {
  if (depth >= 6 || !isRecord(rawResult)) return '';
  const details = isRecord(rawResult.details) ? rawResult.details : rawResult;
  const results = Array.isArray(details.results) ? details.results : [];
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
