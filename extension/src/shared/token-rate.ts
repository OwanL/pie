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
 * time axis is generation-time, time spent in tool calls, between turns, and
 * before the first token (time-to-first-token, surfaced separately as an
 * average) is excluded from both the numerator's token production and the
 * denominator's elapsed time automatically. Mid-stream output stalls (provider
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
/** Minimum generation-time span before a rate is shown (avoids a noisy first reading). */
const MIN_RATE_SPAN_MS = 300;
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
  /**
   * Numeric output tokens/sec (the generation-time-windowed rate), or
   * `undefined` when not measurable (idle, or measuring before
   * {@link MIN_RATE_SPAN_MS} of generation has elapsed). Consumed host-side by
   * the aggregate-stats strip to sum live throughput across running sessions;
   * the webview display ignores it (it renders {@link label}).
   */
  rate?: number;
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
}

export function createAccumulator(now: number): Accumulator {
  return {
    genMs: 0,
    cumTokens: 0,
    samples: [],
    lastWall: now,
    lastContentTokensById: new Map(),
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

/** Estimated output tokens for a message: text + reasoning, via the cl100k_base tokenizer. */
function estimatedOutputTokens(message: ChatMessage | null): number {
  if (!message) return 0;
  return estimateTextTokens(message.markdown ?? '') + estimateTextTokens(message.thinking ?? '');
}

/**
 * Latest completed turn's effective provider-reported throughput. This is the
 * only reliable post-hoc rate for models whose reasoning is not streamed: the
 * provider's output count includes hidden reasoning, while `durationMs` spans
 * the full assistant response (including the initial wait). During streaming
 * that breakdown is unknowable, so the live rate remains a surfaced-text
 * estimate instead.
 */
function latestReportedTurnRate(transcript: ChatMessage[]): number | null {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const message = transcript[i];
    if (message.role !== 'assistant' || message.status === 'streaming') continue;
    const outputTokens = message.usage?.outputTokens;
    const durationMs = message.durationMs;
    if (
      typeof outputTokens === 'number'
      && outputTokens >= 0
      && typeof durationMs === 'number'
      && Number.isFinite(durationMs)
      && durationMs > 0
    ) {
      return outputTokens / (durationMs / 1000);
    }
  }
  return null;
}

function estimatedSubagentOutputTokens(result: SubagentSingleResult): number {
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

function computeSubagentDelta(
  acc: Accumulator,
  running: RunningSubagent[],
): number {
  let delta = 0;
  const seenIds = new Set<string>();

  for (const { key, result } of running) {
    // Composite key: a parallel call shares one toolCallId across all its
    // results, so the index is required to track each result's own growth;
    // nesting adds the parent key so depth-2+ results never collide.
    seenIds.add(key);
    const current = estimatedSubagentOutputTokens(result);
    const previous = acc.subagentTokens.get(key) ?? 0;
    delta += Math.max(0, current - previous);
    acc.subagentTokens.set(key, current);
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
  reportedTurnRate: number | null,
): TokenRateIndicatorState {
  const rate = computeRate(acc.samples);
  const genSec = Math.round(acc.genMs / 1000);
  const windowSpanMs = acc.samples.length >= 2
    ? acc.samples[acc.samples.length - 1].genMs - acc.samples[0].genMs
    : 0;
  const windowSec = Math.round(Math.min(windowSpanMs, WINDOW_MS) / 1000);

  // The average turn latency is surfaced INLINE on the speed chip (always
  // visible, not just on hover) as ` · 1.5s` appended to the rate label. The
  // overhead / time-to-first-token breakdown is appended to the tooltip for
  // context. No measured turns yet -> turnLatency is null and latencyLines is
  // empty -> the label and tooltip stay concise. The same adapters shape the
  // idle state (see computeIdleDisplayState) so the inline segment and tooltip
  // lines are consistent across every state.
  const latency = latencyDisplay(stats);

  if (generating) {
    if (rate === null) {
      return {
        label: latency.withTurnLatency('—'),
        ariaLabel: latency.withTurnLatencyAria('Generation rate: measuring.'),
        tooltip: latency.withLatencyLines(['Measuring generation rate…']),
        state: 'generating',
        paused: false,
      };
    }
    const num = formatRate(rate);
    return {
      label: latency.withTurnLatency(`${num} tok/s`),
      ariaLabel: latency.withTurnLatencyAria(`Generation rate: ${num} tokens per second.`),
      tooltip: latency.withLatencyLines([
        `Generation rate: ${num} tok/s`,
        `Average over the last ${windowSec}s of generation.`,
        `${acc.cumTokens} output tokens in ${genSec}s of generation time.`,
        'Includes output from running subagents.',
        'Clock pauses during tool calls, between turns, and before the first token.',
      ]),
      state: 'generating',
      paused: false,
      rate,
    };
  }

  const reason = describePauseReason(streaming, toolBlocked);
  // Between turns, prefer the completed provider-reported rate. Unlike the live
  // estimate, its numerator includes hidden reasoning when the provider counts
  // it in output. Never replace the held live rate while the current message is
  // merely blocked on a tool call, or while a subagent is still active.
  if (reportedTurnRate !== null) {
    const num = formatRate(reportedTurnRate);
    return {
      label: latency.withTurnLatency(`⏸ ${num} tok/s`),
      ariaLabel: latency.withTurnLatencyAria(`Generation paused (${reason}). Last rate ${num} tokens per second.`),
      tooltip: latency.withLatencyLines([
        `Generation paused (${reason}).`,
        `Last rate: ${num} tok/s`,
      ]),
      state: 'paused',
      paused: true,
      rate: reportedTurnRate,
    };
  }
  if (rate === null) {
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
  const num = formatRate(rate);
  return {
    label: latency.withTurnLatency(`⏸ ${num} tok/s`),
    ariaLabel: latency.withTurnLatencyAria(`Generation paused (${reason}). Last rate ${num} tokens per second.`),
    tooltip: latency.withLatencyLines([
      `Generation paused (${reason}).`,
      `Last rate: ${num} tok/s`,
      `${acc.cumTokens} output tokens in ${genSec}s of generation time.`,
      'Includes output from running subagents.',
      'Clock resumes when the model produces output again.',
    ]),
    state: 'paused',
    paused: true,
    rate,
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

  let mainDelta = 0;
  if (streamingId !== null) {
    // Per-id delta: a continuation (the same canonical message id re-streaming
    // after a tool call) only counts the output added since this id was last
    // seen, not the whole accumulated message. We deliberately leave the map
    // untouched while no message is streaming (between turns / during a tool),
    // so a continuation resumes from its last-known count instead of re-counting
    // its full content.
    const previous = acc.lastContentTokensById.get(streamingId) ?? 0;
    mainDelta = Math.max(0, currentTokens - previous);
    acc.lastContentTokensById.set(streamingId, currentTokens);
    pruneContentTokenMap(acc, streamingId);
  }

  const runningSubagents = findRunningSubagents(transcript);
  const subagentDelta = computeSubagentDelta(acc, runningSubagents);

  const totalDelta = mainDelta + subagentDelta;
  if (totalDelta > 0) {
    acc.cumTokens += totalDelta;
  }

  const mainActive = streaming !== null && !toolBlocked;
  const subagentActive = runningSubagents.length > 0;
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
  const mainProducedOutput = currentTokens > 0;
  const subagentProducedOutput = runningSubagents.some(
    ({ result }) => result.streaming === true,
  );
  const generating =
    totalDelta > 0
    || (mainActive && mainProducedOutput)
    || (subagentActive && subagentProducedOutput);

  const elapsed = Math.max(0, now - acc.lastWall);
  if (generating) {
    acc.genMs += elapsed;
    acc.samples.push({ genMs: acc.genMs, tokens: acc.cumTokens });
    trimWindow(acc);
  }
  acc.lastWall = now;

  const latencyStats = computeTurnLatencyStats(transcript);
  const reportedTurnRate = !generating && streaming === null && runningSubagents.length === 0
    ? latestReportedTurnRate(transcript)
    : null;
  return buildState(acc, generating, streaming, toolBlocked, latencyStats, reportedTurnRate);
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
export function computeIdleDisplayState(transcript: ChatMessage[]): TokenRateIndicatorState {
  const stats = computeTurnLatencyStats(transcript);
  if (stats.count === 0) return IDLE_STATE;
  const latency = latencyDisplay(stats);
  return {
    label: latency.withTurnLatency('—'),
    ariaLabel: latency.withTurnLatencyAria('Generation rate: idle.'),
    tooltip: latency.withLatencyLines(['No active generation.']),
    state: 'idle',
    paused: false,
  };
}
