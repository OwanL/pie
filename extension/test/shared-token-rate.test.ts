import assert from 'node:assert/strict';
import test from 'node:test';

import { encode as bpeEncode, decode as bpeDecode } from 'gpt-tokenizer/encoding/cl100k_base';

import type { ChatMessage, ToolCall } from '../src/shared/protocol';
import { estimateTextTokens } from '../src/shared/tokenize';
import {
  IDLE_STATE,
  createAccumulator,
  createTokenRateAccumulator,
  shouldResetForRun,
  tickTokenRate,
} from '../src/shared/token-rate';

/**
 * Direct coverage of the SHARED token-rate module. `computeRate`,
 * `formatRate`, `estimatedOutputTokens`, `computeSubagentDelta`, and
 * `pruneContentTokenMap` are module-private, so each is exercised through the
 * public `tickTokenRate` / `createAccumulator` surface with deterministic
 * fake timestamps (never `Date.now` for driving the clock).
 *
 * Token magnitudes are calibrated with the real cl100k_base tokenizer the
 * source uses (`estimateTextTokens`), so rate/cumTokens assertions are exact
 * rather than chars/4 approximations.
 */

const BASE_NOW = 100_000; // deterministic non-zero start time for the accumulator

const TOKEN_BASE = bpeEncode('The quick brown fox jumps over the lazy dog. '.repeat(1000));

/** Build text that tokenizes to exactly `tokens` cl100k_base tokens. */
function tokenText(tokens: number): string {
  if (tokens <= 0) return '';
  return bpeDecode(TOKEN_BASE.slice(0, Math.min(tokens, TOKEN_BASE.length)));
}

function streamingMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown: '',
    status: 'streaming',
    toolCalls: [],
    ...overrides,
  };
}

/** A running single-mode subagent call whose only output is `streamingText`. */
function subagentToolCall(id: string, streamingText: string): ToolCall {
  return {
    id,
    name: 'subagent',
    input: {},
    status: 'running',
    result: {
      mode: 'single',
      results: [
        { agent: 'a', task: 't', exitCode: -1, messages: [], streamingText, streaming: true },
      ],
    },
  };
}

// --- createAccumulator / createTokenRateAccumulator / IDLE_STATE ---

test('createAccumulator returns a fresh accumulator with zeroed generation state', () => {
  const acc = createAccumulator(BASE_NOW);
  assert.equal(acc.genMs, 0);
  assert.equal(acc.cumTokens, 0);
  assert.equal(acc.samples.length, 0);
  assert.equal(acc.lastWall, BASE_NOW);
  assert.equal(acc.lastContentTokensById.size, 0);
  assert.equal(acc.subagentTokens.size, 0);
});

test('createTokenRateAccumulator mirrors createAccumulator for an explicit now', () => {
  const acc = createTokenRateAccumulator(BASE_NOW);
  assert.equal(acc.lastWall, BASE_NOW);
  assert.equal(acc.genMs, 0);
  assert.equal(acc.cumTokens, 0);
  assert.equal(acc.samples.length, 0);
});

test('IDLE_STATE is the idle sentinel with no rate and not paused', () => {
  assert.equal(IDLE_STATE.state, 'idle');
  assert.equal(IDLE_STATE.label, '—');
  assert.equal(IDLE_STATE.paused, false);
});

// --- rate = null ("—") at start / TTFT exclusion (computeRate < 2 samples) ---

test('rate is null (label "—") before any output is produced', () => {
  const acc = createAccumulator(BASE_NOW);
  // Empty transcript -> paused, no rate.
  const empty = tickTokenRate(acc, [], BASE_NOW);
  assert.equal(empty.state, 'paused');
  assert.equal(empty.label, '—');
  assert.equal(empty.paused, true);

  // A streaming message that has produced no output yet -> still paused
  // (time-to-first-token excluded), and the generation clock has not advanced.
  const beforeOutput = tickTokenRate(acc, [streamingMessage()], BASE_NOW + 500);
  assert.equal(beforeOutput.state, 'paused');
  assert.equal(beforeOutput.label, '—');
  assert.equal(acc.genMs, 0);
  assert.equal(acc.cumTokens, 0);
  assert.equal(acc.samples.length, 0);
});

// --- rate computation over time deltas (computeRate) ---

test('rate is output tokens divided by the generation-time span between samples', () => {
  const acc = createAccumulator(BASE_NOW);
  const t1 = estimateTextTokens(tokenText(100));
  const t2 = estimateTextTokens(tokenText(200));
  const m = streamingMessage();
  tickTokenRate(acc, [{ ...m, markdown: tokenText(100) }], BASE_NOW + 1000);
  const state = tickTokenRate(acc, [{ ...m, markdown: tokenText(200) }], BASE_NOW + 2000);
  assert.equal(state.state, 'generating');
  assert.equal(state.paused, false);
  const expectedRate = (t2 - t1) / 1.0; // 1s of generation time between the two samples
  const parsed = Number.parseFloat(state.label!.replace(/[^\d.]/g, ''));
  assert.ok(parsed >= expectedRate - 2 && parsed <= expectedRate + 2, `expected ~${expectedRate} tok/s, got ${parsed}`);
  // formatRate >= 10 -> integer, no decimal places.
  assert.match(state.label!, /^\d+ tok\/s$/);
});

test('formatRate renders sub-10 rates with exactly one decimal place', () => {
  const acc = createAccumulator(BASE_NOW);
  const t1 = estimateTextTokens(tokenText(3));
  const t2 = estimateTextTokens(tokenText(8));
  const m = streamingMessage();
  tickTokenRate(acc, [{ ...m, markdown: tokenText(3) }], BASE_NOW + 1000);
  const state = tickTokenRate(acc, [{ ...m, markdown: tokenText(8) }], BASE_NOW + 2000);
  const expectedRate = (t2 - t1) / 1.0;
  assert.ok(expectedRate > 0 && expectedRate < 10, `fixture should produce a 0..10 rate, got ${expectedRate}`);
  const parsed = Number.parseFloat(state.label!.replace(/[^\d.]/g, ''));
  assert.ok(parsed >= expectedRate - 1 && parsed <= expectedRate + 1, `expected ~${expectedRate}, got ${parsed}`);
  // formatRate < 10 -> one decimal place.
  assert.match(state.label!, /^\d\.\d tok\/s$/);
});

test('formatRate renders a zero rate as "0" when samples show no token growth', () => {
  const acc = createAccumulator(BASE_NOW);
  const m = streamingMessage();
  // First tick produces output -> sample pushed, clock advances.
  tickTokenRate(acc, [{ ...m, markdown: tokenText(100) }], BASE_NOW + 1000);
  // Second tick: no new output but the streaming message has already produced
  // output (so it is still "generating") -> clock advances, a sample with
  // unchanged token count is pushed, so computeRate returns 0 and formatRate
  // yields "0".
  const state = tickTokenRate(acc, [{ ...m, markdown: tokenText(100) }], BASE_NOW + 1500);
  assert.equal(state.state, 'generating');
  assert.equal(state.label, '0 tok/s');
});

test('completed hidden reasoning replaces the stale visible estimate with reported effective throughput', () => {
  const acc = createAccumulator(BASE_NOW);
  const streaming = streamingMessage({ markdown: tokenText(20) });

  tickTokenRate(acc, [streaming], BASE_NOW + 1_000);
  tickTokenRate(acc, [{ ...streaming, markdown: tokenText(40) }], BASE_NOW + 2_000);

  const completed: ChatMessage = {
    ...streaming,
    status: 'completed',
    markdown: tokenText(40),
    durationMs: 10_000,
    usage: {
      inputTokens: 100,
      outputTokens: 1_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 1_100,
      reasoningTokens: 900,
    },
  };
  const state = tickTokenRate(acc, [completed], BASE_NOW + 10_000);

  assert.equal(state.state, 'paused');
  assert.equal(state.rate, 100);
  assert.match(state.label, /100 tok\/s/);
  assert.match(state.tooltip, /Last rate: 100 tok\/s/);
});

// --- accumulator merge: cumTokens accumulates per-tick deltas across ticks ---

test('cumTokens accumulates the per-tick deltas and one sample is pushed per generating tick', () => {
  const acc = createAccumulator(BASE_NOW);
  const m = streamingMessage();
  const t1 = estimateTextTokens(tokenText(10));
  const t2 = estimateTextTokens(tokenText(20));
  const t3 = estimateTextTokens(tokenText(30));
  tickTokenRate(acc, [{ ...m, markdown: tokenText(10) }], BASE_NOW + 1000);
  assert.equal(acc.cumTokens, t1);
  assert.equal(acc.samples.length, 1);
  tickTokenRate(acc, [{ ...m, markdown: tokenText(20) }], BASE_NOW + 2000);
  assert.equal(acc.cumTokens, t2); // t1 + (t2 - t1)
  assert.equal(acc.samples.length, 2);
  tickTokenRate(acc, [{ ...m, markdown: tokenText(30) }], BASE_NOW + 3000);
  assert.equal(acc.cumTokens, t3); // t2 + (t3 - t2)
  assert.equal(acc.samples.length, 3);
  assert.equal(acc.genMs, 3000);
});

test('a continuation (same message id re-streaming) counts only its new output, not the whole message', () => {
  // The per-id snapshot means a message that re-streams after a gap resumes from
  // its last-known count instead of re-counting its full accumulated content.
  const acc = createAccumulator(BASE_NOW);
  const m = streamingMessage({ id: 'm1' });
  const t1 = estimateTextTokens(tokenText(100));
  const t2 = estimateTextTokens(tokenText(120));
  tickTokenRate(acc, [{ ...m, markdown: tokenText(100) }], BASE_NOW + 1000);
  // Same id re-streams with 20 more tokens: cumTokens must grow by (t2 - t1),
  // not by t2 (which would re-count the first 100 tokens).
  tickTokenRate(acc, [{ ...m, markdown: tokenText(120) }], BASE_NOW + 2000);
  assert.equal(acc.cumTokens, t2);
});

// --- computeSubagentDelta: sign and magnitude ---

test('subagent delta is non-negative and accumulates into cumTokens while the main session is tool-blocked', () => {
  const acc = createAccumulator(BASE_NOW);
  const m = streamingMessage(); // empty main output
  const text50 = tokenText(50);
  const text100 = tokenText(100);
  const t50 = estimateTextTokens(text50);
  const t100 = estimateTextTokens(text100);

  tickTokenRate(acc, [{ ...m, toolCalls: [subagentToolCall('sub1', text50)] }], BASE_NOW + 1000);
  assert.equal(acc.cumTokens, t50);
  assert.equal(acc.subagentTokens.get('sub1#0'), t50);

  tickTokenRate(acc, [{ ...m, toolCalls: [subagentToolCall('sub1', text100)] }], BASE_NOW + 2000);
  assert.equal(acc.cumTokens, t100); // t50 + (t100 - t50)
  assert.equal(acc.subagentTokens.get('sub1#0'), t100);
});

test('subagent delta is clamped to zero when output shrinks between ticks (never negative)', () => {
  const acc = createAccumulator(BASE_NOW);
  const m = streamingMessage();
  const text100 = tokenText(100);
  const text50 = tokenText(50);
  const t100 = estimateTextTokens(text100);
  tickTokenRate(acc, [{ ...m, toolCalls: [subagentToolCall('sub1', text100)] }], BASE_NOW + 1000);
  assert.equal(acc.cumTokens, t100);
  // Streaming text replaced with a shorter value -> delta max(0, negative) = 0,
  // cumTokens must not decrease.
  tickTokenRate(acc, [{ ...m, toolCalls: [subagentToolCall('sub1', text50)] }], BASE_NOW + 2000);
  assert.equal(acc.cumTokens, t100);
});

test('parallel subagent results are keyed per-result (toolCallId#index), not per toolCallId', () => {
  // One parallel call with two results sharing one toolCallId: each result must
  // track its own snapshot so one result's growth isn't measured against the
  // other's prior count.
  const acc = createAccumulator(BASE_NOW);
  const m = streamingMessage();
  const parallelCall = (aText: string, bText: string): ToolCall => ({
    id: 'sub1',
    name: 'subagent',
    input: {},
    status: 'running',
    result: {
      mode: 'parallel',
      results: [
        { agent: 'a', task: 't', exitCode: -1, messages: [], streamingText: aText },
        { agent: 'b', task: 't', exitCode: -1, messages: [], streamingText: bText },
      ],
    },
  });
  const ta1 = estimateTextTokens(tokenText(40));
  const tb1 = estimateTextTokens(tokenText(10));
  const ta2 = estimateTextTokens(tokenText(80));
  const tb2 = estimateTextTokens(tokenText(20));
  tickTokenRate(acc, [{ ...m, toolCalls: [parallelCall(tokenText(40), tokenText(10))] }], BASE_NOW + 1000);
  assert.equal(acc.subagentTokens.get('sub1#0'), ta1);
  assert.equal(acc.subagentTokens.get('sub1#1'), tb1);
  tickTokenRate(acc, [{ ...m, toolCalls: [parallelCall(tokenText(80), tokenText(20))] }], BASE_NOW + 2000);
  assert.equal(acc.subagentTokens.get('sub1#0'), ta2);
  assert.equal(acc.subagentTokens.get('sub1#1'), tb2);
  // Aggregate delta = (ta2 - ta1) + (tb2 - tb1) added to cumTokens.
  assert.equal(acc.cumTokens, ta2 + tb2);
});

test('a subagent no longer running has its token snapshot removed from the map', () => {
  const acc = createAccumulator(BASE_NOW);
  const m = streamingMessage();
  tickTokenRate(acc, [{ ...m, toolCalls: [subagentToolCall('sub1', tokenText(50))] }], BASE_NOW + 1000);
  assert.equal(acc.subagentTokens.size, 1);
  // Transcript no longer references the subagent -> snapshot dropped so the map
  // stays bounded and a completed result doesn't anchor a stale snapshot.
  tickTokenRate(acc, [{ ...m, markdown: tokenText(10) }], BASE_NOW + 2000);
  assert.equal(acc.subagentTokens.size, 0);
});

// --- pruneContentTokenMap: keeps the most-recent (live) streaming id ---

test('pruneContentTokenMap retains up to the bound and keeps only the live id once exceeded', () => {
  const acc = createAccumulator(BASE_NOW);
  // MAX_CONTENT_TOKEN_ENTRIES = 64: up to 64 distinct streaming ids are retained.
  for (let i = 0; i < 64; i += 1) {
    tickTokenRate(acc, [streamingMessage({ id: `m${i}` })], BASE_NOW + i);
  }
  assert.equal(acc.lastContentTokensById.size, 64);
  assert.equal(acc.lastContentTokensById.has('m0'), true);
  // The 65th distinct id pushes the map over the bound -> pruned to keep only
  // the live (most-recent) streaming id; old finished-turn ids are dropped.
  tickTokenRate(acc, [streamingMessage({ id: 'm-live' })], BASE_NOW + 100);
  assert.equal(acc.lastContentTokensById.size, 1);
  assert.equal(acc.lastContentTokensById.has('m-live'), true);
  assert.equal(acc.lastContentTokensById.has('m0'), false);
});

// --- shouldResetForRun: pure run-id transition logic ---

test('shouldResetForRun: undefined existing run id always resets', () => {
  assert.equal(shouldResetForRun(undefined, null), true);
  assert.equal(shouldResetForRun(undefined, 'run-2'), true);
});

test('shouldResetForRun: null existing run id resets only when a non-null run begins', () => {
  assert.equal(shouldResetForRun(null, null), false);
  assert.equal(shouldResetForRun(null, 'run-1'), true);
});

test('shouldResetForRun: a known run id resets only on a different non-null run id', () => {
  assert.equal(shouldResetForRun('run-1', null), false);
  assert.equal(shouldResetForRun('run-1', 'run-1'), false);
  assert.equal(shouldResetForRun('run-1', 'run-2'), true);
});

// --- T2: nested (depth-2) subagent output is counted via the shared module ---

/** A running depth-1 subagent whose messages carry a nested depth-2 subagent
 *  toolCall with a live streaming partial (the shape T1 stamps). */
function nestedSubagentToolCall(topId: string, nestedStreamingText: string): ToolCall {
  return {
    id: topId,
    name: 'subagent',
    input: {},
    status: 'running',
    result: {
      mode: 'single',
      results: [
        {
          agent: 'scout',
          task: 't',
          exitCode: -1,
          messages: [
            {
              role: 'assistant',
              content: [
                {
                  type: 'toolCall',
                  id: 'nested-tc',
                  name: 'subagent',
                  arguments: {},
                  result: {
                    content: [{ type: 'text', text: 'nested' }],
                    details: {
                      mode: 'single',
                      results: [
                        { agent: 'scout', task: 't', exitCode: -1, messages: [], streamingText: nestedStreamingText, streaming: true },
                      ],
                    },
                  },
                },
              ],
            },
          ],
          streamingText: '',
          streaming: false,
        },
      ],
    },
  };
}

test('computeSubagentDelta (via tickTokenRate) counts nested depth-2 streaming tokens (T2)', () => {
  const acc = createAccumulator(BASE_NOW);
  const m = streamingMessage();
  const t1 = estimateTextTokens(tokenText(100));
  const t2 = estimateTextTokens(tokenText(250));
  tickTokenRate(acc, [{ ...m, toolCalls: [nestedSubagentToolCall('top', tokenText(100))] }], BASE_NOW + 1000);
  const state = tickTokenRate(acc, [{ ...m, toolCalls: [nestedSubagentToolCall('top', tokenText(250))] }], BASE_NOW + 2000);
  assert.equal(state.state, 'generating');
  const rate = Number.parseFloat(state.label!.replace(/[^\d.]/g, ''));
  const expected = (t2 - t1) / 1.0;
  assert.ok(rate >= expected - 5 && rate <= expected + 5, `expected ~${expected} tok/s from nested subagent, got ${rate}`);
  assert.ok(acc.cumTokens > 0, 'nested tokens banked into cumTokens');
  // The nested result has its own composite-keyed snapshot, distinct from the parent's.
  assert.ok(acc.subagentTokens.has('top#0>nested-tc#0'), 'nested snapshot tracked under a composite key');
});

// --- Sticky-clock regression: a subagent's OWN tool call must pause the clock ---

test('a subagent in its own tool call pauses the generation clock (rate holds, state paused)', () => {
  // Regression for the sticky `subagentProducedOutput` predicate: it stayed true
  // forever after the first token, so the clock kept advancing with zero new
  // tokens while a nested scout sat in read/grep/bash calls, collapsing the
  // chip to 0 tok/s. The runner's `streaming` flag (false during a tool call)
  // must pause the clock so the rate holds as `⏸ N tok/s` instead.
  const acc = createAccumulator(BASE_NOW);
  const m = streamingMessage();
  const t1 = estimateTextTokens(tokenText(50));
  const t2 = estimateTextTokens(tokenText(100));
  // Establish a rate across two streaming ticks.
  tickTokenRate(acc, [{ ...m, toolCalls: [subagentToolCall('sub1', tokenText(50))] }], BASE_NOW + 1000);
  tickTokenRate(acc, [{ ...m, toolCalls: [subagentToolCall('sub1', tokenText(100))] }], BASE_NOW + 2000);
  const establishedGenMs = acc.genMs;
  assert.equal(acc.samples.length, 2);
  // Subagent now runs a bash tool: its output is committed to messages, it is
  // NOT streaming (streamingText cleared, streaming flag false, runningTools set).
  const inToolCall = (text: string): ToolCall => ({
    id: 'sub1', name: 'subagent', input: {}, status: 'running',
    result: { mode: 'single', results: [{ agent: 'a', task: 't', exitCode: -1,
      messages: [{ role: 'assistant', content: [{ type: 'text', text }] }],
      runningTools: ['bash'], streamingText: undefined, streaming: false }] },
  });
  let state = tickTokenRate(acc, [{ ...m, toolCalls: [inToolCall(tokenText(100))] }], BASE_NOW + 3000);
  for (let i = 4; i <= 7; i += 1) {
    state = tickTokenRate(acc, [{ ...m, toolCalls: [inToolCall(tokenText(100))] }], BASE_NOW + i * 1000);
  }
  // Clock must NOT have advanced during the tool call.
  assert.equal(acc.genMs, establishedGenMs, 'generation clock paused during subagent tool call');
  assert.equal(state.state, 'paused');
  assert.match(state.label!, /⏸/);
  const held = Number.parseFloat(state.label!.replace(/[^\d.]/g, ''));
  const expectedRate = (t2 - t1) / 1.0;
  assert.ok(held >= expectedRate - 3 && held <= expectedRate + 3, `expected held ~${expectedRate} tok/s, got ${held}`);
});

test('a subagent mid-stream stall (streaming, no token growth) still advances the clock', () => {
  // The `streaming` flag is true through a provider slow-down (the runner only
  // clears it on message_end), so stalls still count against the rate — the
  // same contract as the main session. Without this a stall would freeze the
  // clock and bias the rate high.
  const acc = createAccumulator(BASE_NOW);
  const m = streamingMessage();
  tickTokenRate(acc, [{ ...m, toolCalls: [subagentToolCall('sub1', tokenText(100))] }], BASE_NOW + 1000);
  // Stalled: same output, streaming flag still true -> clock advances, rate 0.
  const state = tickTokenRate(acc, [{ ...m, toolCalls: [subagentToolCall('sub1', tokenText(100))] }], BASE_NOW + 2000);
  assert.equal(state.state, 'generating');
  assert.equal(state.label, '0 tok/s');
  assert.ok(acc.genMs > 1000, 'clock advanced through the stall');
});

test('a reasoning-only subagent stream (streaming flag, no streamingText) advances the clock', () => {
  // thinking_delta sets `streaming` without populating `streamingText`. The
  // clock must advance through the reasoning phase (matching the main session,
  // which counts the streaming message's `thinking` live) so the eventual
  // message_end token bank doesn't spike the rate against ~zero generation time.
  const acc = createAccumulator(BASE_NOW);
  const m = streamingMessage();
  const thinkingOnly = (): ToolCall => ({
    id: 'sub1', name: 'subagent', input: {}, status: 'running',
    result: { mode: 'single', results: [{ agent: 'a', task: 't', exitCode: -1,
      messages: [], streamingText: undefined, streaming: true }] },
  });
  tickTokenRate(acc, [{ ...m, toolCalls: [thinkingOnly()] }], BASE_NOW + 1000);
  tickTokenRate(acc, [{ ...m, toolCalls: [thinkingOnly()] }], BASE_NOW + 2000);
  // No tokens counted yet (thinking lands at message_end), but the clock ran.
  assert.ok(acc.genMs > 0, 'clock advanced during reasoning-only stream');
  // cumTokens is 0 (nothing counted yet) -> totalDelta 0, but generating via the flag.
  assert.equal(acc.cumTokens, 0);
});
