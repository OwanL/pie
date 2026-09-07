import type { ChatMessage, ToolCall } from './protocol';
import { isRecord } from './type-guards';
import { estimateTextTokens } from './tokenize';
import {
  getRenderableSubagentResultFromToolCall,
  getRenderableSubagentResult,
  isSubagentSingleResultRunning,
  type SubagentSingleResult,
} from './subagent-result';
import {
  computeTurnLatencyStats,
  latencyDisplay,
  type TurnLatencyStats,
} from './turn-latency';

/**
 * Live "average tokens per second" measurement.
 *
 * Originally webview-local; now shared so the **host** measures every running
 * session (including ones that are not the active/selected tab) using the
 * transcripts it already holds (`transcript.bySession`). The webview simply
 * displays the pre-computed rate for its active session. This fixes the old
 * behaviour where switching off a session froze its accumulator and switching
 * back restarted the average from the selection point.
 *
 * The generation clock advances while the model (or any running subagent) is
 * actively producing output. A rolling window of (generation-time,
 * cumulative-output-tokens) samples over the last {@link WINDOW_MS} of
 * *generation* time (not wall-clock) yields the displayed rate. Because the
 * time axis is generation-time, time spent executing tools, between turns,
 * and before the first token (time-to-first-token, surfaced separately as an
 * average) is excluded from both the numerator's token production and the
 * denominator's elapsed time automatically. Tool-call argument drafting is
 * model output, so it is included just like reply text and reasoning.
 * Mid-stream output stalls (provider
 * slow-downs) are NOT excluded: once the first token has arrived the clock
 * keeps running through stalls so the rate reflects the true experienced
 * throughput, not just the bursts of active token production.
 *
 * Subagent output is included in the aggregate: the indicator reflects the
 * sum of live output tokens across the main session and every running
 * subagent, so four parallel subagents each averaging 60 tok/s read as
 * ~240 tok/s.
 *
 * Pure with respect to the accumulator (mutates `acc` in place) and takes
 * `now` as a parameter, so it is straightforward to unit-test and safe to run
 * in the extension host.
 */

/**
 * Diagnostic counter of characters handed to the BPE tokenizer by this module
 * (monotonically increasing until reset). Purely observational — it exists so
 * work-bound tests and profiling can assert that a tick's tokenization work is
 * bounded by the sampling window rather than proportional to the transcript
 * size. It never affects any measurement result.
 */
let tokenizerWorkChars = 0;

/** Characters handed to the BPE tokenizer since the last reset. */
export function readTokenRateWorkChars(): number {
  return tokenizerWorkChars;
}

/** Reset the diagnostic tokenizer-work counter (for per-tick measurement). */
export function resetTokenRateWorkChars(): void {
  tokenizerWorkChars = 0;
}

/** Single BPE seam for this module: routes through the diagnostic work counter. */
function countBpeTokens(text: string): number {
  tokenizerWorkChars += text.length;
  return estimateTextTokens(text);
}

/** Char bound beyond which a text field is tail-sampled instead of fully
 * tokenized. Matches the backend's live subagent counter
 * (`estimatePossiblyLongTextTokens` in `tool-progress-normalizer.ts`) so the
 * host rate measurement uses the same bounded-estimate strategy as the
 * transport-side cumulative counters it mirrors. */
const TOKEN_SAMPLE_CHARS = 8_192;

/** Bounded-work token estimate: exact BPE for short text; for long text, the
 * tail window's token density scaled by total characters. Deliberately NOT an
 * exact incremental BPE claim — it is the same approximate magnitude estimate
 * the backend uses for live subagent counters. Estimated quantities derived
 * from it (rate, live/terminal estimates) remain estimates; provider-reported
 * usage stays authoritative wherever it exists.
 *
 * One-shot only: this reprices the WHOLE text at the tail's density, so it
 * must never be used per-tick for an append-mostly field — a density change in
 * the tail would manufacture a delta on the entire prefix. Long-lived fields
 * go through {@link updateFieldEstimate}, which prices only the appended tail
 * incrementally. */
function estimateBoundedTokens(text: string): number {
  if (typeof text !== 'string' || text.length <= TOKEN_SAMPLE_CHARS) {
    return countBpeTokens(text);
  }
  const tail = text.slice(-TOKEN_SAMPLE_CHARS);
  const tailTokens = countBpeTokens(tail);
  return Math.round(tailTokens * (text.length / tail.length));
}

/** Bounded identity + cumulative token estimate for one long-lived text field
 * (a streaming message's markdown/thinking, a terminal turn's fields, a tool
 * draft's arguments, or a subagent result's logical output text).
 *
 * The estimate is INCREMENTAL for append-mostly growth: each update tokenizes
 * only the appended tail (itself bounded via {@link estimateBoundedTokens}),
 * never reprices the already-counted prefix, and reuses the cumulative value
 * with ZERO tokenizer work while the field is unchanged. Replacement and
 * shrink are handled explicitly with a fresh bounded re-estimate. This is what
 * keeps a typical large-stream tick under ~1ms: per-tick BPE work is
 * proportional to the appended chunk, not to the text. */
interface FieldState {
  /** Exact cached content for short fields (≤ TOKEN_SAMPLE_CHARS total):
   * compared element-wise, so ANY content change — including a same-length
   * correction — forces a full exact re-estimate. `null` marks a long field. */
  shortParts: string[] | null;
  /** Long fields: character length of the estimated prefix. */
  length: number;
  /** Bounded fingerprint of the estimated prefix — see
   * {@link fingerprintOfParts}. Empty for short fields. */
  fingerprint: string;
  /** Cumulative bounded token estimate for the estimated region. */
  tokens: number;
}

const FINGERPRINT_EDGE_CHARS = 32;
const FINGERPRINT_MAX_SAMPLES = 224;

/** Deterministic sample positions over a prefix of `limit` characters. The
 * positions depend only on `limit`, so fingerprints of the same prefix are
 * comparable across ticks. Covers the head, a strided interior, and the tail
 * of the prefix — bounded O(1) work regardless of text size. */
function fingerprintSamplePositions(limit: number): number[] {
  const edge = Math.min(FINGERPRINT_EDGE_CHARS, limit);
  const positions: number[] = [];
  for (let i = 0; i < edge; i += 1) positions.push(i);
  const interiorStart = edge;
  const interiorEnd = Math.max(interiorStart, limit - edge);
  const span = interiorEnd - interiorStart;
  if (span > 0) {
    const stride = Math.max(1, Math.floor(span / FINGERPRINT_MAX_SAMPLES));
    for (let pos = interiorStart; pos < interiorEnd; pos += stride) positions.push(pos);
  }
  for (let i = Math.max(interiorEnd, limit - edge); i < limit; i += 1) positions.push(i);
  return positions;
}

/** Bounded fingerprint of the first `limit` characters of the logical
 * concatenation of `parts`. Used ONLY to validate that an already-estimated
 * prefix is unchanged (append detection) — the estimate itself is tail-based,
 * so a probabilistic bounded fingerprint is consistent with the estimate
 * semantics. */
function fingerprintOfParts(parts: string[], limit: number): string {
  if (limit <= 0) return `${limit}|`;
  const positions = fingerprintSamplePositions(limit);
  const chars: string[] = [];
  let partIndex = 0;
  let partStart = 0;
  let partLength = parts[0]?.length ?? 0;
  for (const pos of positions) {
    while (partIndex < parts.length && pos >= partStart + partLength) {
      partStart += partLength;
      partIndex += 1;
      partLength = parts[partIndex]?.length ?? 0;
    }
    chars.push(pos < partStart ? '\u0000' : (parts[partIndex]?.charAt(pos - partStart) ?? '\u0000'));
  }
  return `${limit.toString(36)}|${chars.join('')}`;
}

/** The portion of the logical concatenation of `parts` at or after `from`. */
function suffixOfParts(parts: string[], from: number): string {
  let out = '';
  let partStart = 0;
  for (const part of parts) {
    const partEnd = partStart + part.length;
    if (partEnd > from) out += part.slice(Math.max(0, from - partStart));
    partStart = partEnd;
  }
  return out;
}

function partsCharLength(parts: string[]): number {
  let total = 0;
  for (const part of parts) total += part.length;
  return total;
}

function sameParts(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Fresh bounded token estimate of a logical multi-part text: exact BPE when
 * short; otherwise the tail parts' density rescaled over the total (the same
 * estimate semantics as {@link estimateBoundedTokens} for a single string). */
function estimatePartsBoundedTokens(parts: string[]): number {
  if (parts.length === 1) return estimateBoundedTokens(parts[0]);
  const total = partsCharLength(parts);
  if (total <= TOKEN_SAMPLE_CHARS) {
    let tokens = 0;
    for (const part of parts) tokens += countBpeTokens(part);
    return tokens;
  }
  let remaining = TOKEN_SAMPLE_CHARS;
  let tailTokens = 0;
  for (let i = parts.length - 1; i >= 0 && remaining > 0; i -= 1) {
    const sample = parts[i].slice(-remaining);
    tailTokens += countBpeTokens(sample);
    remaining -= sample.length;
  }
  return Math.round(tailTokens * (total / (TOKEN_SAMPLE_CHARS - remaining)));
}

/** Advance one text field's incremental estimate to `parts` (the field's
 * current content as ordered string parts of one logical text).
 *
 * - Short field: exact full BPE, reused with zero work while content is
 *   identical — every change (including same-length corrections) is fully
 *   reflected.
 * - Long field, unchanged: bounded fingerprint match → reuse (zero BPE work;
 *   a stalled multi-megabyte stream costs nothing per tick).
 * - Long field, pure append: fingerprint of the estimated prefix matches →
 *   only the appended tail is tokenized (bounded) and added to the cumulative
 *   estimate. The prefix is NEVER repriced, so tail-density changes cannot
 *   manufacture deltas on old content.
 * - Replacement / shrink / first sighting: fresh bounded re-estimate of the
 *   whole field (tail-density semantics). */
function updateFieldEstimate(state: FieldState | undefined, parts: string[]): FieldState {
  const total = partsCharLength(parts);
  if (total <= TOKEN_SAMPLE_CHARS) {
    if (state?.shortParts && sameParts(state.shortParts, parts)) return state;
    return { shortParts: parts, length: total, fingerprint: '', tokens: estimatePartsBoundedTokens(parts) };
  }
  if (state && state.shortParts === null) {
    if (total === state.length && fingerprintOfParts(parts, total) === state.fingerprint) {
      return state;
    }
    if (total > state.length && fingerprintOfParts(parts, state.length) === state.fingerprint) {
      return {
        shortParts: null,
        length: total,
        fingerprint: fingerprintOfParts(parts, total),
        tokens: state.tokens + estimateBoundedTokens(suffixOfParts(parts, state.length)),
      };
    }
  }
  return { shortParts: null, length: total, fingerprint: fingerprintOfParts(parts, total), tokens: estimatePartsBoundedTokens(parts) };
}

/** Single-text convenience wrapper over {@link updateFieldEstimate}. */
function updateTextFieldEstimate(state: FieldState | undefined, text: string): FieldState {
  return updateFieldEstimate(state, [text]);
}

/** Measurement tick interval (ms). Imported by the host `TokenRateService`. */
export const TICK_MS = 200;
/** Rolling window length, measured in generation-time (excludes pauses). */
export const WINDOW_MS = 60_000;
/** Minimum generation-time span before a stable rate is shown. */
const MIN_RATE_SPAN_MS = 300;
/** Wall-clock retention for a final/held indicator after a burst ends. */
export const RATE_HOLD_MS = 30_000;
/** Cap on retained samples to bound memory (~72s at 200ms ticks). */
const MAX_SAMPLES = 360;

export interface TokenRateIndicatorState {
  /** Compact label e.g. "42 tok/s · 1.5s" (rate · avg turn latency); "—" when idle or measuring. */
  label: string;
  ariaLabel: string;
  tooltip: string;
  /** 'idle' (no session selected) | 'generating' | 'paused'. */
  state: 'idle' | 'generating' | 'paused';
  /** True while the generation clock is frozen (tool running / between turns / before the first token). */
  paused: boolean;
  /** Numeric active-generation tokens/sec, or `undefined` when no generation
   * timing is available. This is the primary per-session/composer rate. A
   * provisional value may be exposed during the first sampling interval; it is
   * replaced by the generation-time window once it spans 300ms. */
  rate?: number;
  /** Provider-reported output tokens divided by the full assistant duration for
   * the latest completed/error turn. This is separate from {@link rate}: it
   * includes the initial wait and is the end-to-end/experienced throughput.
   * It is also available as a fallback for a burst that completed before the
   * live sampler observed two ticks. */
  endToEndRate?: number;
  /** True when {@link endToEndRate} uses visible-token estimation because the
   * provider did not report output usage. */
  endToEndRateEstimated?: boolean;
  /**
   * Estimated output tokens in the currently-unreported main turn and running
   * subagents. This is transient: provider-reported usage replaces it when the
   * turn/tool completes. Aggregate analytics use it to keep live token totals
   * and charts moving while output streams.
   */
  liveOutputTokens?: number;
  /**
   * Conservative visible-output token estimate for the newest terminal
   * assistant turn, exposed only when the provider did not report usage for it
   * (privacy-safe numeric size — never the text). A burst that completes
   * between sampler ticks never appears in {@link liveOutputTokens}, so the
   * aggregate 30s wall-clock throughput uses this estimate to still count it.
   * `undefined` when the newest terminal turn reported usage (its provider
   * count is authoritative and must never be estimated on top — that would
   * double-count it) or when it produced no visible output.
   */
  terminalOutputTokensEstimate?: number;
}

export const IDLE_STATE: TokenRateIndicatorState = {
  label: '—',
  ariaLabel: 'Generation rate: idle.',
  tooltip: 'No active generation.',
  state: 'idle',
  paused: false,
};

interface Sample {
  /** Generation-clock value (ms) at the sample. */
  genMs: number;
  /** Cumulative estimated output tokens produced since the run began. */
  tokens: number;
}

export interface Accumulator {
  /** Generation clock — advances only while generating. */
  genMs: number;
  /** Cumulative estimated output tokens (continuous across turns within a run). */
  cumTokens: number;
  samples: Sample[];
  /** Wall-time of the last tick, for computing per-tick elapsed. */
  lastWall: number;
  /** Last measured/provisional active-generation rate. `0` is retained because
   * a mid-stream stall is a measured zero; absence means no timing exists yet. */
  heldRate?: number;
  /** Wall-clock when heldRate was last refreshed, for bounded post-burst decay. */
  heldRateAt?: number;
  /**
   * Last estimated output tokens per streaming assistant message id. Per-id (not a
   * single value) so a continuation — the same canonical message id re-streaming
   * after a tool call — only counts its NEW output, not the whole accumulated
   * message again. Mirrors the `subagentTokens` map (which is keyed per-result,
   * `${toolCallId}#${resultIndex}`, so parallel results don't collide). A single
   * value would reset to 0 while the message is briefly not streaming and
   * re-count the entire message on every continuation, exploding `cumTokens`
   * across a tool-heavy turn.
   */
  lastContentTokensById: Map<string, number>;
  /** Last estimated name + JSON tokens per live tool-call draft id. Kept
   * separate from message content so clearing a draft cannot swallow reply
   * text produced by a continuation of the same assistant message. */
  draftingTokensById: Map<string, number>;
  /** Last estimated output tokens per running subagent result.
   *
   * Keyed by `${toolCallId}#${resultIndex}` rather than toolCallId alone: a
   * *parallel* subagent call is one tool call whose `results` array holds one
   * entry per task, all sharing the same toolCallId. Keying by toolCallId alone
   * made every parallel result clobber the same entry each tick, so the delta
   * was computed as the difference between different subagents' cumulative
   * counts — inflating the rate whenever the results had disparate output. The
   * result index is stable because the subagent extension seeds a fixed-size
   * results array and updates entries in place by task index. */
  subagentTokens: Map<string, number>;
  /** Incremental per-field estimates ({@link FieldState}) for the streaming
   * message's markdown/thinking, per message id. Appends tokenize only the
   * appended tail; unchanged fields cost zero tokenizer work; same-length
   * corrections are caught by exact short-field identity or the bounded prefix
   * fingerprint — never stale like the previous id+length shape cache. Kept in
   * lockstep with {@link lastContentTokensById} (pruned together). */
  contentFieldsById: Map<string, { markdown?: FieldState; thinking?: FieldState }>;
  /** Per-draft incremental estimate for a streaming tool call's arguments text
   * (keyed by draft id, in lockstep with {@link draftingTokensById}). Draft
   * arguments are append-mostly; without this they would be fully repriced
   * every tick. */
  draftingFieldStates: Map<string, { args?: FieldState }>;
  /** Incremental per-result estimates for running subagents' logical output
   * text, keyed by the same composite keys as {@link subagentTokens}. A legacy
   * (no producer counter) child stream is priced by appended tail only, so the
   * per-key cumulative counts move by exactly the appended content instead of
   * jumping with tail-density rescaling of the whole child transcript. */
  subagentEstimateStates: Map<string, FieldState>;
  /** Single-slot cached per-field estimates for the newest terminal assistant
   * turn, keyed by message id. Terminal content is stable, so the per-tick
   * scans in `latestEndToEndRate` / `latestTerminalHasNoOutput` /
   * `latestTerminalOutputEstimate` reuse it instead of re-tokenizing a large
   * finished turn on every tick. Content identity is exact for short fields
   * and fingerprint-checked for long ones — a corrected terminal is
   * re-estimated, not served stale. */
  terminalEstimateCache?: { id: string; markdown?: FieldState; thinking?: FieldState };
  /** Cached subagent projection keyed by a monotonic revision signature. When
   * the signature is unchanged across ticks, the recursive extraction + BPE
   * tokenization is skipped entirely. `undefined` when the current transcript
   * has subagent calls without a monotonic `seq` (durable/test calls), in which
   * case the cache is unsound and bypassed. */
  subagentProjectionCache?: { signature: string; projection: SubagentProjection };
}

export function createAccumulator(now: number): Accumulator {
  return {
    genMs: 0,
    cumTokens: 0,
    samples: [],
    lastWall: now,
    lastContentTokensById: new Map(),
    draftingTokensById: new Map(),
    subagentTokens: new Map(),
    contentFieldsById: new Map(),
    draftingFieldStates: new Map(),
    subagentEstimateStates: new Map(),
  };
}

/** Bound on retained per-id content-token snapshots (defensive; a run rarely has more than a few dozen distinct streaming message ids). */
const MAX_CONTENT_TOKEN_ENTRIES = 64;

function pruneContentTokenMap(acc: Accumulator, keepId: string): void {
  if (acc.lastContentTokensById.size <= MAX_CONTENT_TOKEN_ENTRIES) {
    return;
  }
  // Keep only the live streaming id; finished turns' ids never re-stream.
  for (const id of acc.lastContentTokensById.keys()) {
    if (id !== keepId) {
      acc.lastContentTokensById.delete(id);
      acc.contentFieldsById.delete(id);
    }
  }
}

function findStreamingMessage(transcript: ChatMessage[]): ChatMessage | null {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const message = transcript[i];
    if (message.role === 'assistant' && message.status === 'streaming') {
      return message;
    }
  }
  return null;
}

function hasRunningToolCall(message: ChatMessage | null): boolean {
  if (!message?.toolCalls?.length) return false;
  return message.toolCalls.some((tc) => tc.status === 'running');
}

/** Estimated visible output tokens for a message: text + reasoning. Bounded
 * work per field (tail-sampled for long text — see {@link estimateBoundedTokens}). */
function estimatedOutputTokens(message: ChatMessage | null): number {
  if (!message) return 0;
  return estimateBoundedTokens(message.markdown ?? '') + estimateBoundedTokens(message.thinking ?? '');
}

/** Incrementally estimate the streaming message's markdown + thinking fields,
 * reusing unchanged fields with zero tokenizer work. Appends tokenize only the
 * appended tail (bounded); a same-length correction is caught by exact
 * short-field identity or the bounded prefix fingerprint and re-estimated.
 * The returned value is what `tickTokenRate` stores into
 * `lastContentTokensById`, keeping the delta baseline identical. */
function updateStreamingContentEstimate(acc: Accumulator, message: ChatMessage | null): number {
  if (!message) return 0;
  const fields = acc.contentFieldsById.get(message.id) ?? {};
  const markdown = updateTextFieldEstimate(fields.markdown, message.markdown ?? '');
  const thinking = updateTextFieldEstimate(fields.thinking, message.thinking ?? '');
  acc.contentFieldsById.set(message.id, { markdown, thinking });
  return markdown.tokens + thinking.tokens;
}

/** Token estimate for a terminal assistant message, cached per id via
 * incremental {@link FieldState}s ({@link Accumulator.terminalEstimateCache}).
 * Terminal content is stable, so repeated per-tick scans of a large finished
 * turn are free after the first estimate; any content change — including a
 * same-length correction — is caught by field identity/fingerprint and
 * re-estimated. Without an accumulator (idle display paths) this is a one-shot
 * bounded estimate. */
function cachedTerminalOutputTokens(acc: Accumulator | undefined, message: ChatMessage | null): number {
  if (!message) return 0;
  if (!acc) return estimatedOutputTokens(message);
  let cache = acc.terminalEstimateCache;
  if (!cache || cache.id !== message.id) {
    cache = { id: message.id };
    acc.terminalEstimateCache = cache;
  }
  const markdown = updateTextFieldEstimate(cache.markdown, message.markdown ?? '');
  const thinking = updateTextFieldEstimate(cache.thinking, message.thinking ?? '');
  acc.terminalEstimateCache = { id: message.id, markdown, thinking };
  return markdown.tokens + thinking.tokens;
}

/** Draft tool calls currently visible on the message: id, name, and raw
 * arguments text. Pure shape extraction — no estimation, no state. */
function provisionalToolCallDrafts(message: ChatMessage | null): Array<{ id: string; name: string; argsText: string }> {
  if (!message) return [];
  const drafts = (message.toolCalls ?? [])
    .filter((toolCall) => toolCall.status === 'drafting' || toolCall.status === 'ready')
    .map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.name,
      argsText: toolCall.argumentsText ?? (typeof toolCall.input === 'string' ? toolCall.input : ''),
    }));
  const legacy = message.draftingToolCall;
  if (legacy && !drafts.some((draft) => draft.id === legacy.id)) {
    drafts.push({ id: legacy.id, name: legacy.name, argsText: legacy.argumentsText });
  }
  return drafts;
}

/** One-shot bounded estimate of the visible draft tool-call tokens (used by
 * callers without an accumulator — see `estimateLiveAssistantOutputTokens`).
 * Internal per-tick measurement goes through `measureDraftingToolCall`, which
 * prices args incrementally. */
function estimatedDraftingToolCallTokens(message: ChatMessage | null): number {
  return provisionalToolCallDrafts(message).reduce(
    (total, draft) => total + estimateBoundedTokens(draft.name) + estimateBoundedTokens(draft.argsText),
    0,
  );
}

/** Estimated model output currently visible on a streaming assistant message.
 * Includes reply text, reasoning, and the transient tool-call name/arguments so
 * live rate, token-total, chart, and cost projections use the same numerator. */
export function estimateLiveAssistantOutputTokens(message: ChatMessage | null): number {
  return estimatedOutputTokens(message) + estimatedDraftingToolCallTokens(message);
}

/** Track model-generated tool-call names + raw JSON independently from reply
 * content. Multiple provider calls may draft in parallel; promotion removes
 * only the matching id and leaves sibling baselines intact. Args text is
 * estimated incrementally per draft id ({@link FieldState}): appended args
 * tokenize only the appended tail, unchanged args cost nothing, and a
 * replacement/shrink re-estimates fresh (the delta clamp below keeps the
 * cumulative count monotonic either way). */
function measureDraftingToolCall(
  acc: Accumulator,
  message: ChatMessage | null,
): { tokens: number; delta: number; hadPriorOutput: boolean } {
  const drafts = provisionalToolCallDrafts(message);
  const currentIds = new Set(drafts.map((draft) => draft.id));
  let tokens = 0;
  let delta = 0;
  let hadPriorOutput = false;
  for (const draft of drafts) {
    const argsState = updateTextFieldEstimate(acc.draftingFieldStates.get(draft.id)?.args, draft.argsText);
    acc.draftingFieldStates.set(draft.id, { args: argsState });
    const draftTokens = estimateBoundedTokens(draft.name) + argsState.tokens;
    const previous = acc.draftingTokensById.get(draft.id) ?? 0;
    if (draftTokens > 0 && previous > 0) hadPriorOutput = true;
    tokens += draftTokens;
    delta += Math.max(0, draftTokens - previous);
    acc.draftingTokensById.set(draft.id, draftTokens);
  }
  for (const id of acc.draftingTokensById.keys()) {
    if (!currentIds.has(id)) {
      acc.draftingTokensById.delete(id);
      acc.draftingFieldStates.delete(id);
    }
  }
  return { tokens, delta, hadPriorOutput };
}

interface EndToEndRate {
  rate: number;
  estimated: boolean;
}

/**
 * Find the latest usable end-to-end throughput. Provider-reported output is
 * preferred because it includes hidden reasoning; when usage is absent, the
 * visible text is a conservative estimate. A zero-output terminal is not a
 * zero-rate sample — it is unavailable and must not erase a held rate.
 */
function latestEndToEndRate(transcript: ChatMessage[], acc?: Accumulator): EndToEndRate | null {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const message = transcript[i];
    if (message.role !== 'assistant'
      || (message.status !== 'completed' && message.status !== 'error' && message.status !== 'interrupted')) continue;
    const durationMs = message.durationMs;
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) continue;

    let outputTokens: number;
    let estimated = false;
    if (message.usage !== undefined) {
      const reported = message.usage.outputTokens;
      if (typeof reported !== 'number' || !Number.isFinite(reported) || reported <= 0) continue;
      outputTokens = reported;
    } else {
      outputTokens = cachedTerminalOutputTokens(acc, message);
      estimated = true;
      if (outputTokens <= 0) continue;
    }
    return { rate: outputTokens / (durationMs / 1000), estimated };
  }
  return null;
}

/**
 * Estimated visible output of the newest terminal assistant turn, exposed only
 * when the provider did not report usage for it. A usage-bearing terminal is
 * authoritative: estimating on top of its reported output could double-count it
 * in the aggregate. This is a deliberately bounded fallback — only the NEWEST
 * terminal turn is estimated, so a mixed run (some turns reported, some not)
 * reconciles conservatively at settlement: authoritative reported totals win
 * and older unreported turns are never invented.
 */
function latestTerminalOutputEstimate(transcript: ChatMessage[], acc?: Accumulator): number | null {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const message = transcript[i];
    if (message.role !== 'assistant'
      || (message.status !== 'completed' && message.status !== 'error' && message.status !== 'interrupted')) continue;
    if (message.usage !== undefined) return null;
    const estimated = cachedTerminalOutputTokens(acc, message);
    return estimated > 0 ? estimated : null;
  }
  return null;
}

/** Whether the newest terminal assistant turn explicitly produced no output.
 * A zero-rate terminal is unavailable; it must not turn a previous held rate
 * into a fabricated `0 tok/s` sample. */
function latestTerminalHasNoOutput(transcript: ChatMessage[], acc?: Accumulator): boolean {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const message = transcript[i];
    if (message.role !== 'assistant'
      || (message.status !== 'completed' && message.status !== 'error' && message.status !== 'interrupted')) continue;
    if (message.usage !== undefined) {
      return !(typeof message.usage.outputTokens === 'number'
        && Number.isFinite(message.usage.outputTokens)
        && message.usage.outputTokens > 0);
    }
    return cachedTerminalOutputTokens(acc, message) <= 0;
  }
  return false;
}

/** Ordered text/thinking parts of a legacy subagent result followed by its
 * in-flight `streamingText`: one append-mostly logical output text. The
 * streamingText → messages commit (message_end) replaces the in-flight tail
 * with identical committed content at the same offsets, so the logical text
 * only ever appends across the handoff and the incremental estimate neither
 * double-counts nor resets. */
function subagentOutputParts(result: SubagentSingleResult): string[] {
  const parts: string[] = [];
  if (Array.isArray(result.messages)) {
    for (const msg of result.messages) {
      if (msg.role !== 'assistant') continue;
      if (typeof msg.content === 'string') {
        parts.push(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (!isRecord(part)) continue;
          if (part.type === 'text' && typeof part.text === 'string') {
            parts.push(part.text);
          } else if (part.type === 'thinking' && typeof part.thinking === 'string') {
            parts.push(part.thinking);
          }
        }
      }
    }
  }
  if (typeof result.streamingText === 'string') {
    parts.push(result.streamingText);
  }
  return parts;
}

function estimatedSubagentOutputTokens(acc: Accumulator, key: string, result: SubagentSingleResult): number {
  if (
    typeof result.cumulativeOutputTokens === 'number'
    && Number.isFinite(result.cumulativeOutputTokens)
    && result.cumulativeOutputTokens >= 0
  ) {
    return result.cumulativeOutputTokens;
  }

  // No producer counter: estimate from the visible child transcript with
  // incremental bounded work per result (same strategy as the backend's own
  // live counter), so a seq-advancing multi-megabyte legacy stream costs only
  // its appended tail per tick — never a full-text re-BPE or a whole-prefix
  // tail-density reprice.
  const state = updateFieldEstimate(acc.subagentEstimateStates.get(key), subagentOutputParts(result));
  acc.subagentEstimateStates.set(key, state);
  return state.tokens;
}

interface RunningSubagent {
  /** Composite key unique across the nested tree: `${toolCallId}#${resultIndex}`
   * at the top level, `${parentKey}>${toolCallId}#${resultIndex}` for nested
   * (depth ≥ 2) results. A parallel/collision-safe key is required because a
   * *parallel* subagent call shares one toolCallId across all its results, and
   * a nested call's toolCallId may repeat across sibling branches. */
  key: string;
  result: SubagentSingleResult;
}

/** Projected token-rate view of the running subagents in a transcript.
 *
 * Pre-computes the per-result token estimates (and the descendant-inclusive
 * filter) once per monotonic-revision change so that unchanged previews skip the
 * recursive extraction + BPE tokenization on subsequent ticks. The host
 * `TokenRateService` ticks every running session every 200 ms; without this
 * cache, a multi-megabyte live subagent preview would be re-walked and
 * re-tokenized on every tick even while the subagent is stalled in a tool call
 * or waiting for the provider — states that produce no token-rate activity. */
interface SubagentProjection {
  /** Counted running subagents (descendant-inclusive filter applied) with
   * pre-computed token estimates, so unchanged revisions skip re-tokenization. */
  counted: Array<{ key: string; tokens: number; streaming: boolean }>;
  /** Number of running subagents before the descendant-inclusive filter. */
  runningCount: number;
  /** Whether any running subagent is actively streaming (its `streaming` flag). */
  anyStreaming: boolean;
  /** Sum of estimated tokens across counted subagents (for `liveOutputTokens`). */
  totalTokens: number;
}

/** Nominal max recursion depth into nested subagent results. Mirrors the
 * runner's DEFAULT_MAX_DEPTH so token-counting and the nesting guards stay
 * aligned: depth-2 output is counted one level below depth-1. */
const MAX_DEPTH = 3;
/** Hard safeguard against pathological walks (cycles / runaway nesting). Even
 * if MAX_DEPTH is raised, recursion never exceeds this. */
const HARD_MAX_DEPTH = 6;
const RECURSION_DEPTH_CAP = Math.min(MAX_DEPTH, HARD_MAX_DEPTH);

function findRunningSubagents(transcript: ChatMessage[]): RunningSubagent[] {
  const running: RunningSubagent[] = [];
  for (const message of transcript) {
    for (const toolCall of message.toolCalls ?? []) {
      if (toolCall.name !== 'subagent') continue;
      // Genuine terminal status settles every child result (see
      // `normalizeRenderableSubagentResult`), so a terminal call's result —
      // often the full multi-megabyte child history on a durable message —
      // can never contain a running subagent. Skip the parse entirely
      // instead of re-walking it on every tick.
      if (toolCall.status === 'completed' || toolCall.status === 'failed') continue;
      const subagentResult = getRenderableSubagentResultFromToolCall(toolCall as ToolCall);
      if (!subagentResult) continue;
      subagentResult.results.forEach((single, index) => {
        if (isSubagentSingleResultRunning(single)) {
          const key = `${toolCall.id}#${index}`;
          running.push({ key, result: single });
          running.push(...findNestedRunningSubagents(single, key, 1));
        }
      });
    }
  }
  return running;
}

/** Collect running subagents nested inside a result's messages (depth ≥ 2).
 *
 * A nested subagent's output travels as a `tool_execution_update` partial
 * stamped on the assistant message's `toolCall` content part (see the subagent
 * runner). Without recursing here, depth-2 output is structurally uncountable —
 * `findRunningSubagents` only scans the top-level transcript toolCalls — so the
 * speed chip reads 0 tps while depth-2 scouts actively stream. */
function findNestedRunningSubagents(
  result: SubagentSingleResult,
  parentKey: string,
  depth: number,
): RunningSubagent[] {
  if (depth >= RECURSION_DEPTH_CAP) return [];
  const running: RunningSubagent[] = [];
  const messages = Array.isArray(result.messages) ? result.messages : [];
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    const parts = Array.isArray(msg.content) ? msg.content : [];
    for (const part of parts) {
      if (!isRecord(part) || part.type !== 'toolCall' || part.name !== 'subagent') continue;
      const nestedResult = getRenderableSubagentResult(part.result);
      if (!nestedResult) continue;
      const tcId = typeof part.id === 'string' ? part.id : '';
      nestedResult.results.forEach((single, index) => {
        if (isSubagentSingleResultRunning(single)) {
          const key = `${parentKey}>${tcId}#${index}`;
          running.push({ key, result: single });
          running.push(...findNestedRunningSubagents(single, key, depth + 1));
        }
      });
    }
  }
  return running;
}

function subagentsForTokenCounting(running: RunningSubagent[]): RunningSubagent[] {
  const descendantInclusiveKeys: string[] = [];
  return running.filter(({ key, result }) => {
    if (descendantInclusiveKeys.some((ancestor) => key.startsWith(`${ancestor}>`))) {
      return false;
    }
    if (typeof result.cumulativeOutputTokens === 'number') {
      // v4 preview counters already include nested descendants. Do not add the
      // same nested results again when their legacy message tree is also
      // present during a transition between representations.
      descendantInclusiveKeys.push(key);
    }
    return true;
  });
}

/**
 * Cheap O(toolCalls) revision signature of every subagent tool call in the
 * transcript, built from the monotonic per-tool `seq` (projected from the live
 * `LiveToolRecord.seq`, which advances on every progress AND terminal event).
 * The backend assembles the complete recursively-renderable child preview and
 * emits a progress event whenever it structurally changes — including nested
 * completions, usage/cost updates, and streaming-text appends — so the parent
 * tool's `seq` captures every transition that could change the extracted
 * running subagents or their token estimates.
 *
 * Returns `null` (bypass cache) when any NON-TERMINAL subagent call lacks a
 * monotonic `seq`: live (running) tool calls always carry a positive `seq`
 * projected from the live pipeline state, but durable messages loaded from
 * disk and test fixtures may not — their content can change between ticks
 * without advancing the signature, so caching by `seq` would be unsound for
 * them. Terminal calls (`completed`/`failed`) are skipped entirely: their
 * genuine status settles every child, they contribute no running subagents,
 * and their seq-less durable history must not force the cache to be bypassed.
 */
function subagentRevisionSignature(transcript: readonly ChatMessage[]): string | null {
  const parts: string[] = [`${transcript.length}`];
  for (const message of transcript) {
    for (const tc of message.toolCalls ?? []) {
      if (tc.name !== 'subagent') continue;
      if (tc.status === 'completed' || tc.status === 'failed') continue;
      if (typeof tc.seq !== 'number' || tc.seq <= 0) return null;
      parts.push(`${tc.id}:${tc.status}:${tc.seq}:${tc.result !== undefined ? 1 : 0}`);
    }
  }
  return parts.join('|');
}

/**
 * Extract the running subagents and their token estimates, caching the result
 * by {@link subagentRevisionSignature}. On a cache hit (unchanged revision) the
 * recursive `findRunningSubagents` walk and `estimatedSubagentOutputTokens`
 * BPE tokenization are skipped entirely — the pre-computed projection is reused.
 * On a cache miss the full recursive extraction + tokenization runs and the
 * result is cached for subsequent ticks with the same revision.
 */
function projectRunningSubagents(transcript: ChatMessage[], acc: Accumulator): SubagentProjection {
  const signature = subagentRevisionSignature(transcript);
  if (signature !== null && acc.subagentProjectionCache?.signature === signature) {
    return acc.subagentProjectionCache.projection;
  }
  const running = findRunningSubagents(transcript);
  const counted = subagentsForTokenCounting(running);
  const entries = counted.map(({ key, result }) => ({
    key,
    tokens: estimatedSubagentOutputTokens(acc, key, result),
    streaming: result.streaming === true,
  }));
  const projection: SubagentProjection = {
    counted: entries,
    runningCount: running.length,
    anyStreaming: running.some(({ result }) => result.streaming === true),
    totalTokens: entries.reduce((sum, entry) => sum + entry.tokens, 0),
  };
  acc.subagentProjectionCache = signature !== null ? { signature, projection } : undefined;
  return projection;
}

function computeSubagentDelta(
  acc: Accumulator,
  counted: Array<{ key: string; tokens: number }>,
): number {
  let delta = 0;
  const seenIds = new Set<string>();

  for (const { key, tokens } of counted) {
    // Composite key: a parallel call shares one toolCallId across all its
    // results, so the index is required to track each result's own growth;
    // nesting adds the parent key so depth-2+ results never collide.
    seenIds.add(key);
    const previous = acc.subagentTokens.get(key) ?? 0;
    delta += Math.max(0, tokens - previous);
    acc.subagentTokens.set(key, tokens);
  }

  // Drop snapshots for subagent results that are no longer running so the map
  // stays bounded over long sessions and a completed result doesn't anchor the
  // snapshot if the same key were ever reused. The incremental estimate states
  // are pruned in lockstep.
  for (const id of acc.subagentTokens.keys()) {
    if (!seenIds.has(id)) {
      acc.subagentTokens.delete(id);
      acc.subagentEstimateStates.delete(id);
    }
  }

  return delta;
}

function formatRate(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return '0';
  if (rate >= 10) return String(Math.round(rate));
  return rate.toFixed(1);
}

function computeRate(samples: Sample[]): number | null {
  if (samples.length < 2) return null;
  const oldest = samples[0];
  const newest = samples[samples.length - 1];
  const spanMs = newest.genMs - oldest.genMs;
  if (spanMs < MIN_RATE_SPAN_MS) return null;
  const spanTokens = newest.tokens - oldest.tokens;
  return spanTokens / (spanMs / 1000);
}

function trimWindow(acc: Accumulator): void {
  const cutoff = acc.genMs - WINDOW_MS;
  while (acc.samples.length > 1 && acc.samples[0].genMs < cutoff) {
    acc.samples.shift();
  }
  if (acc.samples.length > MAX_SAMPLES) {
    acc.samples.splice(0, acc.samples.length - MAX_SAMPLES);
  }
}

function describePauseReason(message: ChatMessage | null, toolBlocked: boolean): string {
  if (toolBlocked) return 'tool running';
  if (!message) return 'between turns';
  return 'waiting for output';
}

function buildState(
  acc: Accumulator,
  generating: boolean,
  streaming: ChatMessage | null,
  toolBlocked: boolean,
  stats: TurnLatencyStats,
  provisionalRate: number | null,
  endToEnd: EndToEndRate | null,
  zeroOutputTerminal: boolean,
): TokenRateIndicatorState {
  const stableRate = computeRate(acc.samples);
  // A measured rate is preferred. During the first short sampling interval use
  // the output observed in that interval, and while a paused state has not yet
  // accumulated two samples retain the last useful value. `heldRate` may be 0
  // for a genuine mid-stream stall, but never exists for a zero-output turn.
  const candidateRate = acc.cumTokens > 0
    ? (stableRate ?? provisionalRate ?? acc.heldRate)
    : undefined;
  const rate = !generating && zeroOutputTerminal && candidateRate === 0
    ? undefined
    : candidateRate;
  const genSec = Math.round(acc.genMs / 1000);
  const windowSpanMs = acc.samples.length >= 2
    ? acc.samples[acc.samples.length - 1].genMs - acc.samples[0].genMs
    : 0;
  const windowSec = Math.round(Math.min(windowSpanMs, WINDOW_MS) / 1000);
  const e2eFields = endToEnd === null
    ? {}
    : { endToEndRate: endToEnd.rate, endToEndRateEstimated: endToEnd.estimated };
  const e2eLine = endToEnd === null
    ? null
    : `End-to-end throughput: ${formatRate(endToEnd.rate)} tok/s (${endToEnd.estimated ? 'estimated visible output' : 'provider-reported output'} ÷ full assistant duration).`;
  const e2eAria = endToEnd === null
    ? ''
    : ` End-to-end throughput ${formatRate(endToEnd.rate)} tokens per second, based on ${endToEnd.estimated ? 'estimated visible output' : 'provider-reported output'} divided by full assistant duration.`;

  // The average turn latency is surfaced INLINE on the speed chip (always
  // visible, not just on hover) as ` · 1.5s` appended to the rate label. The
  // overhead / time-to-first-token breakdown is appended to the tooltip for
  // context. The two throughput metrics remain separate: active generation
  // speed is primary, while end-to-end throughput includes the initial wait.
  const latency = latencyDisplay(stats);

  if (generating) {
    if (rate === undefined) {
      return {
        label: latency.withTurnLatency('—'),
        ariaLabel: latency.withTurnLatencyAria(`Generation rate: measuring.${e2eAria}`),
        tooltip: latency.withLatencyLines([
          'Measuring active-generation speed…',
          'A provisional rate appears as soon as output and a sampling interval are available.',
          ...(e2eLine ? [e2eLine] : []),
        ]),
        state: 'generating',
        paused: false,
        ...e2eFields,
      };
    }
    const num = formatRate(rate);
    const provisional = stableRate === null && provisionalRate !== null;
    return {
      label: latency.withTurnLatency(`${num} tok/s`),
      ariaLabel: latency.withTurnLatencyAria(`Generation rate: ${num} tokens per second (active generation).${e2eAria}`),
      tooltip: latency.withLatencyLines([
        `Generation rate: ${num} tok/s (active-generation speed)`,
        ...(provisional ? ['Provisional estimate; the stable window appears after 300ms of generation.'] : []),
        `Average over the last ${windowSec}s of generation.`,
        `${acc.cumTokens} output tokens in ${genSec}s of generation time.`,
        'Includes reply text, reasoning, tool-call arguments, and running subagent output.',
        'Clock pauses during tool execution, between turns, and before the first token.',
        ...(e2eLine ? [e2eLine] : []),
      ]),
      state: 'generating',
      paused: false,
      rate,
      ...e2eFields,
    };
  }

  const reason = describePauseReason(streaming, toolBlocked);
  if (rate !== undefined) {
    const num = formatRate(rate);
    return {
      label: latency.withTurnLatency(`⏸ ${num} tok/s`),
      ariaLabel: latency.withTurnLatencyAria(`Generation paused (${reason}). Last active-generation rate ${num} tokens per second.${e2eAria}`),
      tooltip: latency.withLatencyLines([
        `Generation paused (${reason}).`,
        `Last rate: ${num} tok/s (active-generation speed)`,
        `${acc.cumTokens} output tokens in ${genSec}s of generation time.`,
        'Includes output from running subagents.',
        'Clock resumes when the model produces output again.',
        ...(e2eLine ? [e2eLine] : []),
      ]),
      state: 'paused',
      paused: true,
      rate,
      ...e2eFields,
    };
  }

  // A burst can finish before the live window reaches 300ms. Its provider
  // usage (or a visible-token estimate when usage is absent) is still useful,
  // but is explicitly labelled end-to-end rather than presented as generation
  // speed. Zero-output terminals never reach this branch with a rate.
  if (endToEnd !== null) {
    const num = formatRate(endToEnd.rate);
    return {
      label: latency.withTurnLatency(`⏸ ${num} tok/s`),
      ariaLabel: latency.withTurnLatencyAria(`Generation paused (${reason}). Active-generation rate unavailable. End-to-end throughput ${num} tokens per second.${e2eAria}`),
      tooltip: latency.withLatencyLines([
        `Generation paused (${reason}).`,
        'Active-generation speed unavailable: the burst ended before enough generation-time samples were collected.',
        e2eLine!,
      ]),
      state: 'paused',
      paused: true,
      ...e2eFields,
    };
  }

  return {
    label: latency.withTurnLatency('—'),
    ariaLabel: latency.withTurnLatencyAria(`Generation paused (${reason}).`),
    tooltip: latency.withLatencyLines([
      `Generation paused (${reason}).`,
      'Waiting for the model to produce output.',
    ]),
    state: 'paused',
    paused: true,
  };
}

/**
 * Advance the accumulator one tick and return the indicator state to display.
 * Pure with respect to the accumulator (mutates `acc` in place) — takes `now`
 * as a parameter so it is straightforward to unit-test and safe to run in the
 * extension host.
 */
export function tickTokenRate(
  acc: Accumulator,
  transcript: ChatMessage[],
  now: number = Date.now(),
): TokenRateIndicatorState {
  const streaming = findStreamingMessage(transcript);
  const toolBlocked = hasRunningToolCall(streaming);
  const currentTokens = updateStreamingContentEstimate(acc, streaming);
  const streamingId = streaming?.id ?? null;
  const previousMainTokens = streamingId === null
    ? 0
    : acc.lastContentTokensById.get(streamingId) ?? 0;
  const drafting = measureDraftingToolCall(acc, streaming);
  let mainDelta = 0;
  if (streamingId !== null) {
    // Per-id delta: a continuation (the same canonical message id re-streaming
    // after a tool call) only counts the output added since this id was last
    // seen, not the whole accumulated message. We deliberately leave the map
    // untouched while no message is streaming (between turns / during a tool),
    // so a continuation resumes from its last-known count instead of re-counting
    // its full content.
    mainDelta = Math.max(0, currentTokens - previousMainTokens);
    acc.lastContentTokensById.set(streamingId, currentTokens);
    pruneContentTokenMap(acc, streamingId);
  }
  const mainHadPriorOutput = currentTokens > 0 && previousMainTokens > 0;
  // Text growth that arrives while a tool is marked running is still provider
  // output and must advance the clock. Merely retained text while a subagent
  // produces does not establish generation, however.
  const mainEstablishedThisTick = mainHadPriorOutput
    && (!toolBlocked || mainDelta > 0);

  const subagentProjection = projectRunningSubagents(transcript, acc);
  const subagentHadPriorOutput = subagentProjection.counted.some(
    ({ key, tokens, streaming: isStreaming }) => isStreaming
      && tokens > 0
      && (acc.subagentTokens.get(key) ?? 0) > 0,
  );
  const subagentDelta = computeSubagentDelta(acc, subagentProjection.counted);
  const liveOutputTokens = currentTokens + drafting.tokens + subagentProjection.totalTokens;

  const totalDelta = mainDelta + drafting.delta + subagentDelta;
  if (totalDelta > 0) {
    acc.cumTokens += totalDelta;
  }

  const mainActive = streaming !== null && !toolBlocked;
  const subagentActive = subagentProjection.runningCount > 0;
  // Once the first token has arrived, a streaming message is generating for the
  // whole span until it completes or a tool call begins — INCLUDING mid-stream
  // output stalls (provider slow-downs). Pausing the clock on those stalls hid
  // them from the rolling window and biased the rate high: it reflected only the
  // bursts of active token production, not the true experienced throughput. The
  // clock still pauses BEFORE the first token (time-to-first-token, surfaced
  // separately as an average) and during tool calls / between turns. Any output
  // this tick IS generation — the clock must advance and a sample must be pushed
  // so tokens are always accompanied by generation time (without the
  // `totalDelta` term, tokens arriving while a tool call runs would be banked
  // into `cumTokens` without `genMs` advancing and spike the rate on resume).
  //
  // `mainProducedOutput` / `subagentProducedOutput` are derived from CURRENT
  // activity (not a sticky aggregate stamp) so the predicate tracks each
  // message/result independently: a LATER subagent's own first-token wait stays
  // excluded even after an earlier subagent in the same run has produced, and a
  // subagent sitting in a read/grep/bash call does NOT keep the clock running.
  // The subagent signal is the runner's `streaming` flag (set on the first
  // text/thinking delta, cleared on `message_end`), which is true through
  // mid-stream stalls AND reasoning-only streams but false during the
  // subagent's tool calls, between turns, and pre-first-token — mirroring the
  // main session. The previous sticky "has ever produced" predicate kept the
  // clock advancing for the whole tool call, collapsing the rate to 0 tok/s
  // while a nested scout was plainly active (its own tool calls excluded it).
  const mainProducedOutput = currentTokens > 0 || drafting.tokens > 0;
  const subagentProducedOutput = subagentProjection.anyStreaming;
  const generating =
    totalDelta > 0
    || (mainActive && mainProducedOutput)
    || (subagentActive && subagentProducedOutput);

  const elapsed = Math.max(0, now - acc.lastWall);
  // The first observed output has no precise event timestamp. Do not charge the
  // whole preceding wait to generation time: establish the sample at the
  // current generation-clock value, then use the sampling interval as a
  // provisional lower-bound rate until a 300ms generation span exists.
  const firstOutputOnly = totalDelta > 0
    && !mainEstablishedThisTick
    && !drafting.hadPriorOutput
    && !subagentHadPriorOutput;
  const generationElapsed = firstOutputOnly ? 0 : elapsed;
  if (generating) {
    acc.genMs += generationElapsed;
    acc.samples.push({ genMs: acc.genMs, tokens: acc.cumTokens });
    trimWindow(acc);
  }
  acc.lastWall = now;

  const stableRate = computeRate(acc.samples);
  const provisionalRate = stableRate === null && totalDelta > 0 && elapsed > 0
    ? totalDelta / (elapsed / 1000)
    : null;
  if (generating && stableRate !== null) {
    acc.heldRate = stableRate;
    acc.heldRateAt = now;
  } else if (generating && provisionalRate !== null) {
    acc.heldRate = provisionalRate;
    acc.heldRateAt = now;
  }
  if (!generating && acc.heldRateAt !== undefined && now - acc.heldRateAt > RATE_HOLD_MS) {
    // Keep token baselines for continuation accounting, but discard the old
    // timing window so a later turn cannot resurrect a stale held speed.
    acc.heldRate = undefined;
    acc.heldRateAt = undefined;
    acc.samples = [];
  }

  const latencyStats = computeTurnLatencyStats(transcript);
  const endToEnd = latestEndToEndRate(transcript, acc);
  const zeroOutputTerminal = !generating && streaming === null && latestTerminalHasNoOutput(transcript, acc);
  let state = buildState(acc, generating, streaming, toolBlocked, latencyStats, provisionalRate, endToEnd, zeroOutputTerminal);
  // The newest terminal turn's no-usage estimate is exposed whenever present —
  // including while a later turn generates — so the aggregate can keep counting
  // that burst until authoritative usage (or a settlement reconciliation)
  // replaces it. It is numeric only; the text is never exposed.
  const terminalEstimate = latestTerminalOutputEstimate(transcript, acc);
  if (terminalEstimate !== null) {
    state = { ...state, terminalOutputTokensEstimate: terminalEstimate };
  }
  return liveOutputTokens > 0 ? { ...state, liveOutputTokens } : state;
}

/** Create a fresh accumulator (for tests / explicit reset). */
export function createTokenRateAccumulator(now: number = Date.now()): Accumulator {
  return createAccumulator(now);
}

export function shouldResetForRun(existingRunId: string | null | undefined, runId: string | null): boolean {
  if (existingRunId === undefined) return true;
  if (existingRunId === null) return runId !== null;
  return runId !== null && runId !== existingRunId;
}

/**
 * The speed-chip state for a session that is not currently generating — no run
 * is active, so there is no live rate to show, but the transcript's measured
 * turns still carry an average turn latency worth surfacing. Without this, a
 * loaded transcript (opened from disk, or restored after a window reload) would
 * show the bare `IDLE_STATE` placeholder (`—`) even when it has historical
 * latency, so the average would be invisible until the next run began.
 *
 * Returns `IDLE_STATE` when no turn has been measured yet (nothing to average).
 * Otherwise the inline turn-latency segment and the tooltip breakdown are
 * applied through the same `latencyDisplay` adapters as the live
 * generating/paused states, so the latency reads identically across states —
 * only the rate prefix differs (here just `—`, since there is no rate). The
 * state is `idle` (not `paused`): nothing is held or about to resume.
 */
export function computeIdleDisplayState(
  transcript: ChatMessage[],
  includeEndToEnd = true,
): TokenRateIndicatorState {
  const stats = computeTurnLatencyStats(transcript);
  const endToEnd = includeEndToEnd ? latestEndToEndRate(transcript) : null;
  if (stats.count === 0 && endToEnd === null) {
    const terminalEstimate = latestTerminalOutputEstimate(transcript);
    if (terminalEstimate === null) return IDLE_STATE;
    return { ...IDLE_STATE, terminalOutputTokensEstimate: terminalEstimate };
  }
  const latency = latencyDisplay(stats);
  const terminalEstimate = latestTerminalOutputEstimate(transcript);
  if (endToEnd === null) {
    const base: TokenRateIndicatorState = {
      label: latency.withTurnLatency('—'),
      ariaLabel: latency.withTurnLatencyAria('Generation rate: idle.'),
      tooltip: latency.withLatencyLines(['No active generation.']),
      state: 'idle',
      paused: false,
    };
    return terminalEstimate === null ? base : { ...base, terminalOutputTokensEstimate: terminalEstimate };
  }
  const num = formatRate(endToEnd.rate);
  const source = endToEnd.estimated ? 'estimated visible output' : 'provider-reported output';
  return {
    label: latency.withTurnLatency(`⏸ ${num} tok/s`),
    ariaLabel: latency.withTurnLatencyAria(`Generation rate: idle. Active-generation rate unavailable. End-to-end throughput ${num} tokens per second, based on ${source} divided by full assistant duration.`),
    tooltip: latency.withLatencyLines([
      'No active generation.',
      'Active-generation speed unavailable; showing the latest completed end-to-end throughput.',
      `End-to-end throughput: ${num} tok/s (${source} ÷ full assistant duration).`,
    ]),
    state: 'idle',
    paused: false,
    endToEndRate: endToEnd.rate,
    endToEndRateEstimated: endToEnd.estimated,
    ...(terminalEstimate === null ? {} : { terminalOutputTokensEstimate: terminalEstimate }),
  };
}
