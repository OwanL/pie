import assert from 'node:assert/strict';
import test from 'node:test';

import { encode as bpeEncode, decode as bpeDecode } from 'gpt-tokenizer/encoding/cl100k_base';

import type { ChatMessage, ToolCall } from '../../../src/shared/protocol';
import { estimateTextTokens } from '../../../src/shared/tokenize';
import {
  IDLE_STATE,
  createAccumulator,
  createTokenRateAccumulator,
  shouldResetForRun,
  tickTokenRate,
} from '../../../src/shared/token-rate';

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
  assert.equal(acc.draftingTokensById.size, 0);
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

test('first output exposes a provisional rate before the stable 300ms window', () => {
  const acc = createAccumulator(BASE_NOW);
  const m = streamingMessage();
  const first = tickTokenRate(acc, [{ ...m, markdown: tokenText(100) }], BASE_NOW + 200);
  assert.equal(first.state, 'generating');
  assert.ok((first.rate ?? 0) > 0, 'first sampled output should not display zero or dash');
  assert.match(first.tooltip, /Provisional/);

  const second = tickTokenRate(acc, [{ ...m, markdown: tokenText(150) }], BASE_NOW + 400);
  assert.ok((second.rate ?? 0) > 0, 'short second interval should retain a useful estimate');
  assert.match(second.tooltip, /Provisional/);

  const stable = tickTokenRate(acc, [{ ...m, markdown: tokenText(200) }], BASE_NOW + 600);
  assert.ok((stable.rate ?? 0) > 0);
  assert.doesNotMatch(stable.tooltip, /Provisional/);
});

test('a short completed burst uses terminal usage as end-to-end fallback', () => {
  const acc = createAccumulator(BASE_NOW);
  const completed: ChatMessage = {
    ...streamingMessage(),
    status: 'completed',
    markdown: tokenText(40),
    durationMs: 1_000,
    usage: {
      inputTokens: 10,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 110,
    },
  };
  const state = tickTokenRate(acc, [completed], BASE_NOW + 200);
  assert.equal(state.rate, undefined, 'no active-generation timing was sampled');
  assert.equal(state.endToEndRate, 100);
  assert.match(state.label, /100 tok\/s/);
  assert.match(state.tooltip, /end-to-end throughput/i);
});

test('zero-output terminal turns are unavailable, not zero tok/s', () => {
  const acc = createAccumulator(BASE_NOW);
  const terminal: ChatMessage = {
    ...streamingMessage(),
    status: 'error',
    durationMs: 1_000,
    usage: {
      inputTokens: 10,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 10,
    },
  };
  const state = tickTokenRate(acc, [terminal], BASE_NOW + 200);
  assert.equal(state.rate, undefined);
  assert.equal(state.endToEndRate, undefined);
  assert.doesNotMatch(state.label, /0 tok\/s/);
});

// --- terminal output estimate (privacy-safe numeric fallback for aggregates) ---

test('a completed burst without provider usage exposes its conservative terminal output estimate', () => {
  // A burst that completes between sampler ticks never appears in
  // liveOutputTokens, so the aggregate 30s wall-clock throughput needs the
  // numeric terminal estimate to still count it. Only the size is exposed —
  // never the text.
  const acc = createAccumulator(BASE_NOW);
  const completed: ChatMessage = {
    ...streamingMessage(),
    status: 'completed',
    markdown: tokenText(40),
    durationMs: 1_000,
  };
  const state = tickTokenRate(acc, [completed], BASE_NOW + 200);
  assert.equal(state.state, 'paused');
  assert.equal(state.terminalOutputTokensEstimate, estimateTextTokens(tokenText(40)));
  assert.equal(state.endToEndRateEstimated, true, 'no provider usage → the end-to-end rate is estimated');
});

test('a usage-bearing terminal turn never exposes a terminal estimate (no double count)', () => {
  // The provider count is authoritative for that burst; estimating on top of it
  // would double-count it in the aggregate.
  const acc = createAccumulator(BASE_NOW);
  const completed: ChatMessage = {
    ...streamingMessage(),
    status: 'completed',
    markdown: tokenText(40),
    durationMs: 1_000,
    usage: {
      inputTokens: 10,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 110,
    },
  };
  const state = tickTokenRate(acc, [completed], BASE_NOW + 200);
  assert.equal(state.terminalOutputTokensEstimate, undefined);
  assert.equal(state.endToEndRate, 100);
  assert.equal(state.endToEndRateEstimated, false, 'provider-reported usage, not estimated');
});

test('a zero-output terminal exposes no terminal estimate', () => {
  const acc = createAccumulator(BASE_NOW);
  const terminal: ChatMessage = {
    ...streamingMessage(),
    status: 'error',
    durationMs: 1_000,
  };
  const state = tickTokenRate(acc, [terminal], BASE_NOW + 200);
  assert.equal(state.terminalOutputTokensEstimate, undefined);
  assert.equal(state.endToEndRate, undefined);
});

test('an uncovered terminal estimate persists while a later turn streams (mixed-run fallback)', () => {
  // Mixed-run rule: only the newest terminal turn carries an estimate, and it
  // stays exposed (alongside the live turn's own estimate) until authoritative
  // usage or a settlement reconciliation replaces it. The two are disjoint —
  // the terminal turn is not streaming, so the aggregate never double-counts.
  const acc = createAccumulator(BASE_NOW);
  const earlierBurst: ChatMessage = {
    ...streamingMessage(),
    id: 'm0',
    status: 'completed',
    markdown: tokenText(100),
    durationMs: 1_000,
  };
  const streaming = streamingMessage({ id: 'm1', markdown: tokenText(50) });
  const state = tickTokenRate(acc, [earlierBurst, streaming], BASE_NOW + 1_000);
  assert.equal(state.state, 'generating');
  assert.equal(state.terminalOutputTokensEstimate, estimateTextTokens(tokenText(100)));
  assert.ok((state.liveOutputTokens ?? 0) > 0, 'the live turn keeps its own estimate');
});

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

test('completed hidden reasoning keeps active speed primary and exposes reported end-to-end throughput', () => {
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
  assert.equal(state.rate, 20);
  assert.equal(state.endToEndRate, 100);
  assert.match(state.label, /20 tok\/s/);
  assert.match(state.tooltip, /End-to-end throughput: 100 tok\/s/);
  assert.match(state.tooltip, /Last rate: 20 tok\/s/);
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
  // The first output establishes the generation baseline; its preceding TTFT
  // is excluded from the active-generation clock.
  assert.equal(acc.genMs, 2000);
});

test('streaming tool-call arguments count as generated output', () => {
  const acc = createAccumulator(BASE_NOW);
  const firstDraft = tokenText(40);
  const secondDraft = tokenText(100);
  const toolNameTokens = estimateTextTokens('bash');
  const firstTokens = toolNameTokens + estimateTextTokens(firstDraft);
  const secondTokens = toolNameTokens + estimateTextTokens(secondDraft);

  const first = tickTokenRate(acc, [streamingMessage({
    draftingToolCall: { id: 'tool-1', name: 'bash', argumentsText: firstDraft },
  })], BASE_NOW + 1_000);
  const second = tickTokenRate(acc, [streamingMessage({
    draftingToolCall: { id: 'tool-1', name: 'bash', argumentsText: secondDraft },
  })], BASE_NOW + 2_000);

  assert.equal(first.state, 'generating');
  assert.equal(second.state, 'generating');
  assert.equal(acc.cumTokens, secondTokens);
  assert.equal(second.liveOutputTokens, secondTokens);
  assert.equal(acc.genMs, 1_000);
  assert.equal(second.rate, secondTokens - firstTokens);
});

test('multiple provisional ToolCall rows retain independent token baselines', () => {
  const acc = createAccumulator(BASE_NOW);
  const firstA = tokenText(20);
  const secondA = tokenText(40);
  const draftB = tokenText(30);
  tickTokenRate(acc, [streamingMessage({
    toolCalls: [
      { id: 'a', name: 'read', input: firstA, argumentsText: firstA, status: 'drafting' },
      { id: 'b', name: 'bash', input: draftB, argumentsText: draftB, status: 'drafting' },
    ],
  })], BASE_NOW + 1_000);
  tickTokenRate(acc, [streamingMessage({
    toolCalls: [
      { id: 'a', name: 'read', input: secondA, argumentsText: secondA, status: 'ready' },
      { id: 'b', name: 'bash', input: draftB, argumentsText: draftB, status: 'drafting' },
    ],
  })], BASE_NOW + 2_000);
  assert.equal(acc.draftingTokensById.size, 2);
  const expected = estimateTextTokens('read') + estimateTextTokens(secondA)
    + estimateTextTokens('bash') + estimateTextTokens(draftB);
  assert.equal(acc.cumTokens, expected);
});

test('tool execution pauses the clock without double-counting its draft or swallowing continuation text', () => {
  const acc = createAccumulator(BASE_NOW);
  const initialText = tokenText(100);
  const continuedText = tokenText(120);
  const draftText = tokenText(40);
  const initialTokens = estimateTextTokens(initialText);
  const continuedTokens = estimateTextTokens(continuedText);
  const draftTokens = estimateTextTokens('bash') + estimateTextTokens(draftText);

  tickTokenRate(acc, [streamingMessage({
    markdown: initialText,
    draftingToolCall: { id: 'tool-1', name: 'bash', argumentsText: draftText },
  })], BASE_NOW + 1_000);
  const generationBeforeTool = acc.genMs;

  const blocked = tickTokenRate(acc, [streamingMessage({
    markdown: initialText,
    toolCalls: [{ id: 'tool-1', name: 'bash', input: { command: 'echo hi' }, status: 'running' }],
  })], BASE_NOW + 2_000);

  assert.equal(blocked.state, 'paused');
  assert.equal(acc.genMs, generationBeforeTool);
  assert.equal(acc.cumTokens, initialTokens + draftTokens);
  assert.equal(acc.draftingTokensById.size, 0);

  tickTokenRate(acc, [streamingMessage({
    markdown: continuedText,
    toolCalls: [{ id: 'tool-1', name: 'bash', input: { command: 'echo hi' }, status: 'completed' }],
  })], BASE_NOW + 3_000);
  assert.equal(acc.cumTokens, continuedTokens + draftTokens);
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

test('typed subagent previews use the cumulative token counter instead of bounded text tails', () => {
  const acc = createAccumulator(BASE_NOW);
  const m = streamingMessage();
  const previewCall = (tokens: number): ToolCall => ({
    id: 'sub1',
    name: 'subagent',
    input: {},
    status: 'running',
    result: {
      kind: 'subagent',
      mode: 'single',
      omittedChildren: 0,
      children: [{
        id: 'child-1', agent: 'worker', task: 't', phase: 'running',
        streaming: true,
        // A bounded tail can remain unchanged while the full stream grows.
        streamingText: 'same bounded tail',
        cumulativeOutputTokens: tokens,
      }],
    },
  });

  tickTokenRate(acc, [{ ...m, toolCalls: [previewCall(100)] }], BASE_NOW + 1000);
  const state = tickTokenRate(acc, [{ ...m, toolCalls: [previewCall(250)] }], BASE_NOW + 2000);
  assert.equal(acc.cumTokens, 250);
  assert.equal(state.state, 'generating');
  const rate = Number.parseFloat(state.label.replace(/[^\d.]/g, ''));
  assert.ok(rate >= 145 && rate <= 155, `expected ~150 tok/s from cumulative preview counter, got ${rate}`);
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

test('a completed subagent represented by lazy detail is not counted as running', () => {
  const acc = createAccumulator(BASE_NOW);
  const m = streamingMessage();
  const completedLazyCall: ToolCall = {
    id: 'sub-lazy', name: 'subagent', input: { agent: 'worker', task: 'done' },
    status: 'completed',
    detailRef: {
      key: 'durable:tool:/session:entry:sub-lazy:0', kind: 'tool-result', source: 'durable',
      sessionPath: '/session', messageId: m.id, toolCallId: 'sub-lazy',
      sizeBytes: 100_000, summary: '1 subagent child', available: true,
    },
  };
  tickTokenRate(acc, [{ ...m, toolCalls: [completedLazyCall] }], BASE_NOW + 1000);
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
  assert.ok(acc.genMs >= 1000, 'clock advanced through the stall after the first-output baseline');
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

// --- REM-04: monotonic-revision projection cache for subagent token counting ---

/** A v4 subagent preview call carrying a monotonic `seq` (projected from the
 *  live `LiveToolRecord.seq`) and a `cumulativeOutputTokens` counter. */
function previewCallWithSeq(id: string, tokens: number, seq: number): ToolCall {
  return {
    id,
    name: 'subagent',
    input: {},
    status: 'running',
    seq,
    result: {
      kind: 'subagent',
      mode: 'single',
      omittedChildren: 0,
      children: [{
        id: 'child-1', agent: 'worker', task: 't', phase: 'running',
        streaming: true,
        streamingText: 'same bounded tail',
        cumulativeOutputTokens: tokens,
      }],
    },
  };
}

test('REM-04: unchanged subagent revision reuses the cached projection (no re-extraction)', () => {
  // The monotonic `seq` is the cache key. When it is unchanged across ticks the
  // recursive extraction + tokenization is skipped — a content change without a
  // seq advance is NOT reflected, proving the extraction was skipped (if it had
  // run, it would read the new counter). This matches the backend's contract
  // that identical cumulative SDK updates consume no sequence and emit nothing.
  const acc = createAccumulator(BASE_NOW);
  const m = streamingMessage();

  tickTokenRate(acc, [{ ...m, toolCalls: [previewCallWithSeq('sub1', 100, 1)] }], BASE_NOW + 1000);
  assert.equal(acc.cumTokens, 100);
  assert.ok(acc.subagentProjectionCache, 'projection cache populated after first extraction');
  assert.ok(
    acc.subagentProjectionCache!.signature.includes('sub1:running:1:1'),
    `signature encodes id:status:seq:result-presence, got: ${acc.subagentProjectionCache!.signature}`,
  );

  // Same seq=1 but cumulativeOutputTokens changed to 200. The cache hits (seq
  // unchanged) → the cached projection (tokens=100) is reused → cumTokens stays
  // 100 (delta 0), NOT 200. If the extraction had re-run it would read 200.
  tickTokenRate(acc, [{ ...m, toolCalls: [previewCallWithSeq('sub1', 200, 1)] }], BASE_NOW + 2000);
  assert.equal(acc.cumTokens, 100, 'unchanged revision reuses cached projection (200 ignored)');
});

test('REM-04: a seq advance (preview change) re-extracts the projection', () => {
  const acc = createAccumulator(BASE_NOW);
  const m = streamingMessage();

  tickTokenRate(acc, [{ ...m, toolCalls: [previewCallWithSeq('sub1', 100, 1)] }], BASE_NOW + 1000);
  assert.equal(acc.cumTokens, 100);

  // seq advances 1 → 2: cache miss → re-extract → reads the new counter (250).
  tickTokenRate(acc, [{ ...m, toolCalls: [previewCallWithSeq('sub1', 250, 2)] }], BASE_NOW + 2000);
  assert.equal(acc.cumTokens, 250, 'seq advance re-extracts and reads the new counter');
  assert.ok(
    acc.subagentProjectionCache!.signature.includes('sub1:running:2:1'),
    'cache signature updated to the new seq',
  );
});

test('REM-04: subagent calls without a monotonic seq bypass the projection cache', () => {
  // Durable messages loaded from disk and test fixtures carry no `seq`. Their
  // content can change between ticks without advancing the signature, so caching
  // by `seq` would be unsound — the cache is bypassed and content changes are
  // always reflected.
  const acc = createAccumulator(BASE_NOW);
  const m = streamingMessage();
  const call = (tokens: number): ToolCall => ({
    id: 'sub1', name: 'subagent', input: {}, status: 'running',
    result: {
      kind: 'subagent', mode: 'single', omittedChildren: 0,
      children: [{ id: 'c1', agent: 'a', task: 't', phase: 'running',
        streaming: true, cumulativeOutputTokens: tokens }],
    },
  });

  tickTokenRate(acc, [{ ...m, toolCalls: [call(100)] }], BASE_NOW + 1000);
  assert.equal(acc.cumTokens, 100);
  assert.equal(acc.subagentProjectionCache, undefined, 'no seq → cache not populated');

  // Content changes without seq → always re-extracted (no stale cache).
  tickTokenRate(acc, [{ ...m, toolCalls: [call(200)] }], BASE_NOW + 2000);
  assert.equal(acc.cumTokens, 200, 'no cache → content change always reflected');
});

test('REM-04: large-payload characterization — unchanged revision skips repeat recursive tokenization', () => {
  // A legacy (no cumulativeOutputTokens) subagent with many messages: the
  // recursive extraction + BPE tokenization of the full message tree is the
  // dominant per-tick cost the cache eliminates. This proves deterministically
  // that an unchanged revision avoids repeat work: a much larger payload under
  // the same seq is NOT re-tokenized (the cached projection is reused), while a
  // seq advance re-extracts and tokenizes the larger payload.
  const acc = createAccumulator(BASE_NOW);
  const m = streamingMessage();

  const buildCall = (text: string, seq: number): ToolCall => ({
    id: 'sub1', name: 'subagent', input: {}, status: 'running', seq,
    result: {
      mode: 'single',
      results: [{
        agent: 'a', task: 't', exitCode: -1, streaming: true,
        messages: Array.from({ length: 200 }, (_, i) => ({
          role: 'assistant',
          content: [{ type: 'text', text: `${text}-${i}` }],
        })),
      }],
    },
  });

  // First tick: full recursive extraction + tokenization runs.
  const smallText = tokenText(50);
  const state1 = tickTokenRate(acc, [{ ...m, toolCalls: [buildCall(smallText, 1)] }], BASE_NOW + 1000);
  const firstTokens = state1.liveOutputTokens!;
  assert.ok(firstTokens > 0, 'first extraction tokenized the payload');
  assert.ok(acc.subagentProjectionCache, 'cache populated after first extraction');

  // Second tick: SAME seq=1 but a 10× larger payload (more text per message).
  // The cache hits (seq unchanged) → the cached projection is reused → the
  // larger payload is NOT re-tokenized. liveOutputTokens stays at the cached
  // value. If the extraction had re-run, liveOutputTokens would be ~10× larger.
  const largeText = tokenText(500);
  const state2 = tickTokenRate(acc, [{ ...m, toolCalls: [buildCall(largeText, 1)] }], BASE_NOW + 2000);
  assert.equal(
    state2.liveOutputTokens, firstTokens,
    'unchanged revision reuses cached projection — larger payload not re-tokenized',
  );

  // Third tick: seq advances to 2 → cache miss → re-extracts the larger payload.
  const state3 = tickTokenRate(acc, [{ ...m, toolCalls: [buildCall(largeText, 2)] }], BASE_NOW + 3000);
  assert.ok(
    state3.liveOutputTokens! > firstTokens * 2,
    'seq advance re-extracts — larger payload tokenized',
  );
});
