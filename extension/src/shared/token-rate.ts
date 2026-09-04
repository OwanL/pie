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

/** Estimated visible output tokens for a message: text + reasoning. */
function estimatedOutputTokens(message: ChatMessage | null): number {
  if (!message) return 0;
  return estimateTextTokens(message.markdown ?? '') + estimateTextTokens(message.thinking ?? '');
}

function provisionalToolCallTokens(message: ChatMessage | null): Array<{ id: string; tokens: number }> {
  if (!message) return [];
  const provisional = (message.toolCalls ?? [])
    .filter((toolCall) => toolCall.status === 'drafting' || toolCall.status === 'ready')
    .map((toolCall) => ({
      id: toolCall.id,
      tokens: estimateTextTokens(toolCall.name)
        + estimateTextTokens(toolCall.argumentsText ?? (typeof toolCall.input === 'string' ? toolCall.input : '')),
    }));
  const legacy = message.draftingToolCall;
  if (legacy && !provisional.some((entry) => entry.id === legacy.id)) {
    provisional.push({
      id: legacy.id,
      tokens: estimateTextTokens(legacy.name) + estimateTextTokens(legacy.argumentsText),
    });
  }
  return provisional;
}

function estimatedDraftingToolCallTokens(message: ChatMessage | null): number {
  return provisionalToolCallTokens(message).reduce((total, draft) => total + draft.tokens, 0);
}

/** Estimated model output currently visible on a streaming assistant message.
 * Includes reply text, reasoning, and the transient tool-call name/arguments so
 * live rate, token-total, chart, and cost projections use the same numerator. */
export function estimateLiveAssistantOutputTokens(message: ChatMessage | null): number {
  return estimatedOutputTokens(message) + estimatedDraftingToolCallTokens(message);
}

/** Track model-generated tool-call names + raw JSON independently from reply
 * content. Multiple provider calls may draft in parallel; promotion removes
 * only the matching id and leaves sibling baselines intact. */
function measureDraftingToolCall(
  acc: Accumulator,
  message: ChatMessage | null,
): { tokens: number; delta: number; hadPriorOutput: boolean } {
  const drafts = provisionalToolCallTokens(message);
  const currentIds = new Set(drafts.map((draft) => draft.id));
  let tokens = 0;
  let delta = 0;
  let hadPriorOutput = false;
  for (const draft of drafts) {
    const previous = acc.draftingTokensById.get(draft.id) ?? 0;
    if (draft.tokens > 0 && previous > 0) hadPriorOutput = true;
    tokens += draft.tokens;
    delta += Math.max(0, draft.tokens - previous);
    acc.draftingTokensById.set(draft.id, draft.tokens);
  }
  for (const id of acc.draftingTokensById.keys()) {
    if (!currentIds.has(id)) acc.draftingTokensById.delete(id);
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
function latestEndToEndRate(transcript: ChatMessage[]): EndToEndRate | null {
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
      outputTokens = estimatedOutputTokens(message);
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
function latestTerminalOutputEstimate(transcript: ChatMessage[]): number | null {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const message = transcript[i];
    if (message.role !== 'assistant'
      || (message.status !== 'completed' && message.status !== 'error' && message.status !== 'interrupted')) continue;
    if (message.usage !== undefined) return null;
    const estimated = estimatedOutputTokens(message);
    return estimated > 0 ? estimated : null;
  }
  return null;
}

/** Whether the newest terminal assistant turn explicitly produced no output.
 * A zero-rate terminal is unavailable; it must not turn a previous held rate
 * into a fabricated `0 tok/s` sample. */
function latestTerminalHasNoOutput(transcript: ChatMessage[]): boolean {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const message = transcript[i];
    if (message.role !== 'assistant'
      || (message.status !== 'completed' && message.status !== 'error' && message.status !== 'interrupted')) continue;
    if (message.usage !== undefined) {
      return !(typeof message.usage.outputTokens === 'number'
        && Number.isFinite(message.usage.outputTokens)
        && message.usage.outputTokens > 0);
    }
    return estimatedOutputTokens(message) <= 0;
  }
  return false;
}

function estimatedSubagentOutputTokens(result: SubagentSingleResult): number {
  if (
    typeof result.cumulativeOutputTokens === 'number'
    && Number.isFinite(result.cumulativeOutputTokens)
    && result.cumulativeOutputTokens >= 0
  ) {
    return result.cumulativeOutputTokens;
  }

  let tokens = 0;
  if (Array.isArray(result.messages)) {
    for (const msg of result.messages) {
      if (msg.role !== 'assistant') continue;
      if (typeof msg.content === 'string') {
        tokens += estimateTextTokens(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (isRecord(part)) {
            if (part.type === 'text' && typeof part.text === 'string') {
              tokens += estimateTextTokens(part.text);
            } else if (part.type === 'thinking' && typeof part.thinking === 'string') {
              tokens += estimateTextTokens(part.thinking);
            }
          }
        }
      }
    }
  }
  if (typeof result.streamingText === 'string') {
    tokens += estimateTextTokens(result.streamingText);
  }
  return tokens;
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
 * Returns `null` (bypass cache) when any subagent call lacks a monotonic `seq`:
 * durable messages loaded from disk and test fixtures carry no `seq`, and their
 * content can change between ticks without advancing the signature, so caching
 * by `seq` would be unsound for them. Live (running) tool calls always carry a
 * positive `seq` projected from the live pipeline state.
 */
function subagentRevisionSignature(transcript: readonly ChatMessage[]): string | null {
  const parts: string[] = [`${transcript.length}`];
  for (const message of transcript) {
    for (const tc of message.toolCalls ?? []) {
      if (tc.name !== 'subagent') continue;
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
    tokens: estimatedSubagentOutputTokens(result),
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
  // snapshot if the same key were ever reused.
  for (const id of acc.subagentTokens.keys()) {
    if (!seenIds.has(id)) {
      acc.subagentTokens.delete(id);
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
  const currentTokens = estimatedOutputTokens(streaming);
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
  const endToEnd = latestEndToEndRate(transcript);
  const zeroOutputTerminal = !generating && streaming === null && latestTerminalHasNoOutput(transcript);
  let state = buildState(acc, generating, streaming, toolBlocked, latencyStats, provisionalRate, endToEnd, zeroOutputTerminal);
  // The newest terminal turn's no-usage estimate is exposed whenever present —
  // including while a later turn generates — so the aggregate can keep counting
  // that burst until authoritative usage (or a settlement reconciliation)
  // replaces it. It is numeric only; the text is never exposed.
  const terminalEstimate = latestTerminalOutputEstimate(transcript);
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
