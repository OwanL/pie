import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage, ToolCall } from '../../../src/shared/protocol';
import {
  createTokenRateAccumulator,
  tickTokenRate,
  WINDOW_MS,
} from '../../../src/webview/panel/composer/use-token-rate';
import { computeIdleDisplayState, IDLE_STATE } from '../../../src/shared/token-rate';
import { encode as bpeEncode, decode as bpeDecode } from 'gpt-tokenizer/encoding/cl100k_base';

const BASE_NOW = 1_700_000_0000;

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

// A varied base string tokenized once; tokenText slices + decodes it to produce
// exactly N tokens. Realistic text encodes ~30M chars/s, whereas a run of a
// single repeated character is a BPE-merge worst case (super-linear), so this
// keeps the rate tests fast while staying deterministic.
const TOKEN_BASE = bpeEncode('The quick brown fox jumps over the lazy dog. '.repeat(1000));

/** Build text that tokenizes to exactly `tokens` cl100k_base tokens. */
function tokenText(tokens: number): string {
  if (tokens <= 0) return '';
  return bpeDecode(TOKEN_BASE.slice(0, Math.min(tokens, TOKEN_BASE.length)));
}

function setContent(message: ChatMessage, chars: number): ChatMessage {
  // Calibrate output as chars/4 tokens, counted with the real cl100k_base
  // tokenizer so token magnitudes match the historical chars/4 calibration.
  return { ...message, markdown: tokenText(Math.round(chars / 4)) };
}

function subagentToolCall(
  id: string,
  overrides: {
    status?: ToolCall['status'];
    exitCode?: number;
    streamingText?: string;
    messages?: unknown[];
    runningTools?: string[];
  } = {},
): ToolCall {
  return {
    id,
    name: 'subagent',
    input: {},
    status: overrides.status ?? 'running',
    result: {
      mode: 'single',
      results: [
        {
          agent: 'test-agent',
          task: 'test task',
          exitCode: overrides.exitCode ?? -1,
          messages: overrides.messages ?? [],
          streamingText: overrides.streamingText ?? '',
          ...(overrides.runningTools ? { runningTools: overrides.runningTools } : {}),
        },
      ],
    },
  };
}

/**
 * A parallel subagent call: ONE tool call with mode:'parallel' and one result
 * per task, all sharing the same toolCallId. This is the structure the subagent
 * extension actually emits (see extensions/subagent/src/modes.ts).
 */
function parallelSubagentToolCall(
  id: string,
  streamingCharsByResult: number[],
  overrides: { status?: ToolCall['status']; exitCodes?: number[] } = {},
): ToolCall {
  return {
    id,
    name: 'subagent',
    input: {},
    status: overrides.status ?? 'running',
    result: {
      mode: 'parallel',
      results: streamingCharsByResult.map((chars, index) => ({
        agent: `agent-${index}`,
        task: `task-${index}`,
        exitCode: overrides.exitCodes?.[index] ?? -1,
        messages: [],
        streamingText: tokenText(Math.round(chars / 4)),
      })),
    },
  };
}

/** Drive the accumulator through a series of (transcript, nowMs) ticks. */
function runTicks(
  ticks: Array<{ transcript: ChatMessage[]; now: number }>,
) {
  const acc = createTokenRateAccumulator(BASE_NOW);
  let state = tickTokenRate(acc, ticks[0]!.transcript, ticks[0]!.now);
  for (let i = 1; i < ticks.length; i += 1) {
    state = tickTokenRate(acc, ticks[i]!.transcript, ticks[i]!.now);
  }
  return { acc, state };
}

test('tokenText produces exactly N cl100k_base tokens (calibration guard)', () => {
  for (const n of [0, 1, 2, 10, 100, 200, 1080]) {
    assert.equal(bpeEncode(tokenText(n)).length, n, `tokenText(${n})`);
  }
});

test('idle: no streaming message shows a paused "measuring" placeholder with no rate', () => {
  const { state } = runTicks([{ transcript: [], now: BASE_NOW }]);
  assert.equal(state.state, 'paused');
  assert.equal(state.label, '—');
  assert.equal(state.paused, true);
  assert.match(state.tooltip, /Waiting for the model/);
});

test('generating: rate is output tokens divided by generation time, excluding pre-first-token latency', () => {
  const m = streamingMessage();
  // Empty -> paused (TTFT excluded); then 100 tokens/s for 2s -> ~100 tok/s.
  const { state } = runTicks([
    { transcript: [setContent(m, 0)], now: BASE_NOW },          // empty -> paused
    { transcript: [setContent(m, 400)], now: BASE_NOW + 1000 }, // 100 tokens -> sample 1
    { transcript: [setContent(m, 800)], now: BASE_NOW + 2000 }, // 200 tokens -> sample 2, rate=100 tok/s
  ]);
  assert.equal(state.state, 'generating');
  assert.equal(state.paused, false);
  assert.match(state.label!, /tok\/s/);
  const rate = Number.parseFloat(state.label!.replace(/[^\d.]/g, ''));
  assert.ok(rate >= 90 && rate <= 110, `expected ~100 tok/s, got ${rate}`);
});

test('tool call running pauses the clock: rate holds its last value and is marked paused', () => {
  const m = streamingMessage();
  // 2s of generation at 200 tokens/s -> ~200 tok/s.
  const { acc, state: afterGen } = runTicks([
    { transcript: [setContent(m, 0)], now: BASE_NOW },           // empty -> paused
    { transcript: [setContent(m, 800)], now: BASE_NOW + 1000 },  // 200 tokens -> sample 1
    { transcript: [setContent(m, 1600)], now: BASE_NOW + 2000 }, // 400 tokens -> sample 2, rate=200 tok/s
  ]);
  assert.equal(afterGen.state, 'generating');
  const genRate = Number.parseFloat(afterGen.label!.replace(/[^\d.]/g, ''));

  // A tool call starts running on the streaming message; generation is blocked.
  const blocked = setContent(
    { ...m, toolCalls: [{ id: 't1', name: 'bash', input: {}, status: 'running' }] },
    1600,
  );
  // Simulate a long tool call (5s wall-clock) — the clock must NOT advance.
  const blockedState = tickTokenRate(acc, [blocked], BASE_NOW + 7000);
  assert.equal(blockedState.state, 'paused');
  assert.equal(blockedState.paused, true);
  assert.match(blockedState.label!, /⏸/);
  assert.match(blockedState.tooltip, /tool running/);
  // Generation clock frozen during the tool call.
  assert.equal(acc.genMs, 2000);

  // Rate held at the pre-pause value (~200 tok/s), not diluted by the 5s tool call.
  const heldRate = Number.parseFloat(blockedState.label!.replace(/[^\d.]/g, ''));
  assert.equal(heldRate, genRate);
});

test('between turns pauses the clock until the next streaming message produces output', () => {
  const m = streamingMessage();
  const { acc, state: afterGen } = runTicks([
    { transcript: [setContent(m, 0)], now: BASE_NOW },
    { transcript: [setContent(m, 400)], now: BASE_NOW + 1000 },
  ]);
  assert.equal(afterGen.state, 'generating');

  // Previous message completed; no streaming message yet (between turns).
  const betweenState = tickTokenRate(acc, [], BASE_NOW + 2000);
  assert.equal(betweenState.state, 'paused');
  assert.match(betweenState.tooltip, /between turns/);
  assert.equal(acc.genMs, 1000); // clock frozen during the gap

  // Next turn begins streaming; until it produces output it stays paused...
  const m2 = streamingMessage({ id: 'm2' });
  const beforeOutput = tickTokenRate(acc, [setContent(m2, 0)], BASE_NOW + 3000);
  assert.equal(beforeOutput.state, 'paused');

  // ...and once output flows, generation resumes with cumTokens continuous.
  const resumed = tickTokenRate(acc, [setContent(m2, 400)], BASE_NOW + 4000);
  assert.equal(resumed.state, 'generating');
  // 100 tokens from turn 1 + 100 tokens from turn 2 = 200 cumulative.
  assert.equal(acc.cumTokens, 200);
});

test('a mid-stream output stall counts against the rate (clock keeps running, rate drops)', () => {
  // Provider slow-downs pause token production mid-stream. The clock must NOT
  // pause on these stalls (it used to, after a 1s grace): excluding them hid
  // the stall from the rolling window and biased the rate high — it reflected
  // only the bursts of active production, not the true throughput. Once the
  // first token has arrived, the clock keeps running through stalls so the rate
  // drops to reflect the slow-down.
  const m = streamingMessage();
  const acc = createTokenRateAccumulator(BASE_NOW);
  tickTokenRate(acc, [setContent(m, 0)], BASE_NOW);            // paused (TTFT excluded)
  tickTokenRate(acc, [setContent(m, 800)], BASE_NOW + 1000);   // 200 tokens -> ~200 tok/s
  const before = tickTokenRate(acc, [setContent(m, 1600)], BASE_NOW + 2000); // ~200 tok/s
  assert.equal(before.state, 'generating');
  const rateBefore = Number.parseFloat(before.label!.replace(/[^\d.]/g, ''));

  // Provider stalls mid-stream: no new output for 5s while the message is still streaming.
  const stalled = tickTokenRate(acc, [setContent(m, 1600)], BASE_NOW + 7000);
  // The clock kept advancing through the stall (not paused) -> generation time grew.
  assert.equal(stalled.state, 'generating');
  assert.ok(acc.genMs > 2000, `clock should advance through the stall, got ${acc.genMs}ms`);
  // The rate dropped: the same tokens spread over more generation time.
  const rateAfter = Number.parseFloat(stalled.label!.replace(/[^\d.]/g, ''));
  assert.ok(rateAfter < rateBefore, `rate should drop during the stall, before=${rateBefore} after=${rateAfter}`);
});

test('rolling window averages only the last WINDOW_MS of generation time', () => {
  const m = streamingMessage();
  const acc = createTokenRateAccumulator(BASE_NOW);
  // Generate 40 tokens/s for 70s of generation (beyond the 60s window), so the
  // oldest samples age out of the window. 40 tok/s = 1 token per 25ms -> 8
  // tokens (32 chars) every 200ms tick.
  tickTokenRate(acc, [setContent(m, 0)], BASE_NOW);
  let chars = 0;
  for (let ms = 200; ms <= 70_000; ms += 200) {
    chars += 4 * 200 / 25; // 200ms * (1 token / 25ms) = 8 tokens per tick
    tickTokenRate(acc, [setContent(m, Math.round(chars))], BASE_NOW + ms);
  }
  const rate = acc.samples.length >= 2
    ? (acc.samples[acc.samples.length - 1]!.tokens - acc.samples[0]!.tokens)
      / ((acc.samples[acc.samples.length - 1]!.genMs - acc.samples[0]!.genMs) / 1000)
    : 0;
  assert.ok(rate >= 35 && rate <= 45, `expected ~40 tok/s over the window, got ${rate}`);
  // Window span never exceeds WINDOW_MS in generation-time.
  const span = acc.samples[acc.samples.length - 1]!.genMs - acc.samples[0]!.genMs;
  assert.ok(span <= WINDOW_MS + 200, `window span ${span} exceeded ${WINDOW_MS}ms`);
});

test('per-turn time-to-first-token is excluded: an empty new turn pauses the clock even without a tool-call gap', () => {
  const m1 = streamingMessage({ id: 'm1' });
  const acc = createTokenRateAccumulator(BASE_NOW);
  tickTokenRate(acc, [setContent(m1, 0)], BASE_NOW);            // empty -> paused
  tickTokenRate(acc, [setContent(m1, 400)], BASE_NOW + 1000);  // 100 tokens -> generating, genMs=1000
  assert.equal(acc.genMs, 1000);

  // A second turn begins streaming (no tool call between turns). The clock
  // must NOT advance during m2's time-to-first-token — the new empty message
  // has produced no output yet, so it is not yet "generating".
  const m2 = streamingMessage({ id: 'm2' });
  const waiting = tickTokenRate(acc, [setContent(m2, 0)], BASE_NOW + 1100);
  assert.equal(waiting.state, 'paused');
  assert.equal(acc.genMs, 1000); // frozen during m2's TTFT

  // Once m2 produces output, generation resumes.
  const resumed = tickTokenRate(acc, [setContent(m2, 400)], BASE_NOW + 2100);
  assert.equal(resumed.state, 'generating');
});

test('subagent streaming output is counted while the main session is paused on a tool call', () => {
  const m = streamingMessage();
  const acc = createTokenRateAccumulator(BASE_NOW);

  // Main generates briefly, then a subagent tool call starts running.
  tickTokenRate(acc, [setContent(m, 0)], BASE_NOW);
  tickTokenRate(acc, [setContent(m, 400)], BASE_NOW + 1000);
  const blocked = setContent(
    { ...m, toolCalls: [subagentToolCall('sub1', { streamingText: '' })] },
    400,
  );
  tickTokenRate(acc, [blocked], BASE_NOW + 2000);

  // Subagent streams 50 tokens/s for 2s while main is blocked.
  const subagentText = (chars: number) => subagentToolCall('sub1', { streamingText: tokenText(Math.round(chars / 4)) });
  const transcript1: ChatMessage[] = [setContent(
    { ...m, toolCalls: [subagentText(200)] },
    400,
  )];
  tickTokenRate(acc, transcript1, BASE_NOW + 3000);

  const transcript2: ChatMessage[] = [setContent(
    { ...m, toolCalls: [subagentText(400)] },
    400,
  )];
  const state = tickTokenRate(acc, transcript2, BASE_NOW + 4000);

  assert.equal(state.state, 'generating');
  // 50 new subagent tokens over 1s of generation time.
  const rate = Number.parseFloat(state.label!.replace(/[^\d.]/g, ''));
  assert.ok(rate >= 40 && rate <= 60, `expected ~50 tok/s from subagent, got ${rate}`);
});

test('a later subagent call\'s time-to-first-token is excluded even after an earlier subagent produced', () => {
  // Regression: the "has produced output" signal was an aggregate wall-clock
  // stamp that never reset, so once any subagent in a run produced output the
  // clock kept running through a LATER subagent\'s own first-token wait —
  // diluting the rate. Deriving per-result from the current token snapshot means
  // each subagent\'s TTFT is excluded until that subagent itself produces.
  const m = streamingMessage();
  const acc = createTokenRateAccumulator(BASE_NOW);
  // Main generates, then subagent A runs and produces output.
  tickTokenRate(acc, [setContent(m, 0)], BASE_NOW);
  tickTokenRate(acc, [setContent(m, 400)], BASE_NOW + 1000);                 // main 100 tokens -> generating
  const aRunning = (text: string) => setContent(
    { ...m, toolCalls: [subagentToolCall('a', { streamingText: text })] }, 400,
  );
  tickTokenRate(acc, [aRunning(tokenText(50))], BASE_NOW + 2000);           // A 50 tokens -> generating
  tickTokenRate(acc, [aRunning(tokenText(100))], BASE_NOW + 3000);           // A 100 tokens -> generating
  // A finishes (no tool calls); the main message is still streaming.
  tickTokenRate(acc, [setContent(m, 400)], BASE_NOW + 4000);               // main stalls -> generating, clock runs
  const genMsBeforeB = acc.genMs;
  // Subagent B starts (running) but has produced NO output yet — its TTFT.
  const bRunning = (text: string) => setContent(
    { ...m, toolCalls: [subagentToolCall('b', { streamingText: text })] }, 400,
  );
  const bWaiting = tickTokenRate(acc, [bRunning('')], BASE_NOW + 5000);     // B empty -> paused (TTFT)
  assert.equal(bWaiting.state, 'paused');
  assert.equal(acc.genMs, genMsBeforeB);                                   // clock frozen during B's TTFT
  // Once B produces output, generation resumes.
  const bProducing = tickTokenRate(acc, [bRunning(tokenText(50))], BASE_NOW + 6000);
  assert.equal(bProducing.state, 'generating');
});

test('parallel subagents aggregate their output into a single session rate', () => {
  const m = streamingMessage();
  const acc = createTokenRateAccumulator(BASE_NOW);

  // Two parallel subagents each streaming 50 tokens/s.
  const subAgents = (charsEach: number) => {
    return {
      ...m,
      status: 'streaming' as const,
      toolCalls: [
        subagentToolCall('sub1', { streamingText: tokenText(Math.round(charsEach / 4)) }),
        subagentToolCall('sub2', { streamingText: tokenText(Math.round(charsEach / 4)) }),
      ],
    };
  };

  tickTokenRate(acc, [subAgents(0)], BASE_NOW);
  tickTokenRate(acc, [subAgents(200)], BASE_NOW + 1000); // 50 each -> 100 total
  const state = tickTokenRate(acc, [subAgents(400)], BASE_NOW + 2000); // another 100 total

  assert.equal(state.state, 'generating');
  // 200 aggregate tokens over 1s -> ~100 tok/s, even though no main output exists.
  const rate = Number.parseFloat(state.label!.replace(/[^\d.]/g, ''));
  assert.ok(rate >= 85 && rate <= 115, `expected ~100 tok/s aggregate, got ${rate}`);
});

test('a fresh accumulator resets the rolling window for a new run', () => {
  const m = streamingMessage();
  const acc = createTokenRateAccumulator(BASE_NOW);
  tickTokenRate(acc, [setContent(m, 0)], BASE_NOW);
  tickTokenRate(acc, [setContent(m, 400)], BASE_NOW + 1000); // ~100 tok/s

  const fresh = createTokenRateAccumulator(BASE_NOW + 60_000);
  const state = tickTokenRate(fresh, [setContent(streamingMessage(), 0)], BASE_NOW + 60_000);
  assert.equal(fresh.genMs, 0);
  assert.equal(fresh.cumTokens, 0);
  assert.equal(fresh.samples.length, 0);
  assert.equal(fresh.subagentTokens.size, 0);
  assert.equal(state.state, 'paused'); // nothing produced yet
});

test('continuation (alias) flow does not re-count the whole message each tool call', () => {
  // Regression: pi reuses one canonical assistant message id across the tool
  // calls of a turn (the alias/continuation path). Each tool call flips the
  // message status to a non-streaming state, so findStreamingMessage returns
  // null while the tool runs; when the model continues, the SAME id re-streams
  // with additional text. A single lastContentTokens value would reset to 0
  // during the tool gap and re-count the ENTIRE accumulated message on every
  // continuation, exploding cumTokens (observed: ~10M tokens over a 337s run).
  const m = streamingMessage({ id: 'm1' });
  const acc = createTokenRateAccumulator(BASE_NOW);
  let peakRate = 0;
  const peak = (st: ReturnType<typeof tickTokenRate>) => {
    const r = st.label === '—' ? 0 : Number.parseFloat(st.label.replace(/[^\d.]/g, ''));
    if (r > peakRate) peakRate = r;
  };

  // Initial stream: 100 tokens (400 chars) at ~100 tok/s.
  peak(tickTokenRate(acc, [setContent(m, 0)], BASE_NOW));
  peak(tickTokenRate(acc, [setContent({ ...m, status: 'streaming' }, 400)], BASE_NOW + 1000));

  // 12 continuation cycles: a tool runs (message briefly not streaming), then
  // the same id re-streams with +40 chars (+10 tokens) of new output.
  let chars = 400;
  let now = BASE_NOW + 1000;
  for (let c = 0; c < 12; c += 1) {
    chars += 40;
    now += 1000; // 1s tool call (clock must pause)
    peak(tickTokenRate(acc, [setContent({ ...m, status: 'completed' }, chars)], now));
    now += 200; // continuation streams +10 tokens over 200ms
    peak(tickTokenRate(acc, [setContent({ ...m, status: 'streaming' }, chars)], now));
  }

  // Real output = 100 (initial) + 12 * 10 (continuations) = 220 tokens.
  // Pre-fix this was ~100 + 110 + 120 + ... + 220 ≈ 1990 (9x inflation); over a
  // long session it reached hundreds of x. Post-fix it must match reality.
  assert.ok(
    acc.cumTokens >= 200 && acc.cumTokens <= 260,
    `continuation re-counted: expected ~220 cumulative tokens, got ${acc.cumTokens}`,
  );
  assert.ok(peakRate < 400, `peak rate spiked to ${peakRate} tok/s during continuations`);
});

test('parallel subagents in one tool call (mode:parallel) key per-result, not per toolCallId', () => {
  // Regression: a parallel subagent call is ONE tool call with mode:'parallel'
  // and multiple results sharing one toolCallId. The per-subagent token snapshot
  // was keyed by toolCallId alone, so every parallel result clobbered the same
  // map entry each tick and the delta was computed as the difference between
  // DIFFERENT subagents' cumulative counts. With a dominant subagent (one
  // produces verbose reasoning while the others produce little) this inflated
  // cumTokens far above the true aggregate — observed ~2000 tok/s for subagents
  // totalling ~240 tok/s.
  const m = streamingMessage();
  const acc = createTokenRateAccumulator(BASE_NOW);

  // One parallel call with four results. Per-second growth (chars/4 = tokens):
  // result 0: 180 tok/s (720 chars/s), results 1-3: 20 tok/s (80 chars/s) each.
  // Aggregate = 240 tok/s, but result 0 dominates — the realistic inflation case.
  const call = (chars: [number, number, number, number]): ChatMessage => ({
    ...m,
    status: 'streaming' as const,
    toolCalls: [parallelSubagentToolCall('sub1', chars)],
  });

  tickTokenRate(acc, [call([0, 0, 0, 0])], BASE_NOW);
  tickTokenRate(acc, [call([720, 80, 80, 80])], BASE_NOW + 1000);
  tickTokenRate(acc, [call([1440, 160, 160, 160])], BASE_NOW + 2000);
  tickTokenRate(acc, [call([2160, 240, 240, 240])], BASE_NOW + 3000);
  tickTokenRate(acc, [call([2880, 320, 320, 320])], BASE_NOW + 4000);
  tickTokenRate(acc, [call([3600, 400, 400, 400])], BASE_NOW + 5000);
  const state = tickTokenRate(acc, [call([4320, 480, 480, 480])], BASE_NOW + 6000);

  assert.equal(state.state, 'generating');
  const rate = Number.parseFloat(state.label!.replace(/[^\d.]/g, ''));
  // True aggregate is 240 tok/s. Pre-fix this returned ~660 tok/s because the
  // single shared snapshot key measured result 0's growth against result 3's
  // prior count every tick.
  assert.ok(
    rate >= 220 && rate <= 260,
    `expected ~240 tok/s aggregate for one parallel subagent call, got ${rate}`,
  );
});

test('text produced while a tool call is running is counted as generation, not banked', () => {
  // Regression: tokens that arrive on a streaming message holding a 'running'
  // tool call used to advance cumTokens without advancing genMs (banking), then
  // spike the rate when generation resumed. Output IS generation — the clock
  // must advance whenever tokens are produced.
  const m = streamingMessage({ id: 'm1' });
  const acc = createTokenRateAccumulator(BASE_NOW);
  let peakRate = 0;
  const peak = (st: ReturnType<typeof tickTokenRate>) => {
    const r = st.label === '—' ? 0 : Number.parseFloat(st.label.replace(/[^\d.]/g, ''));
    if (r > peakRate) peakRate = r;
  };
  // 100 tok/s for 1s, then the model keeps streaming text while a bash tool is
  // 'running' on the same message for ~11s, then the tool completes.
  peak(tickTokenRate(acc, [setContent(m, 0)], BASE_NOW));
  peak(tickTokenRate(acc, [setContent({ ...m, status: 'streaming' }, 400)], BASE_NOW + 1000));
  for (let i = 2; i <= 12; i += 1) {
    peak(tickTokenRate(acc, [setContent({ ...m, toolCalls: [{ id: 't1', name: 'bash', input: {}, status: 'running' }] }, 400 + (i - 1) * 80)], BASE_NOW + i * 1000));
  }
  peak(tickTokenRate(acc, [setContent({ ...m, toolCalls: [{ id: 't1', name: 'bash', input: {}, status: 'completed' }] }, 400 + 12 * 80)], BASE_NOW + 13_000));
  // ~100 tok/s throughout — no banking spike. genMs must have advanced across the
  // tool-running span (tokens were produced), so the rate stays bounded.
  assert.ok(peakRate < 400, `peak rate spiked to ${peakRate} tok/s during tool-running text`);
  assert.ok(acc.genMs >= 10_000, `generation clock should have advanced during text production, got ${acc.genMs}ms`);
});

test('merged tooltip surfaces the average turn latency alongside the live rate', () => {
  // The turn-latency breakdown is no longer a separate chip — the average
  // turn latency is shown INLINE on the speed chip (always visible), with the
  // overhead / time-to-first-token breakdown in the tooltip. Verify the inline
  // turn-latency segment and the tooltip lines both appear in the chip.
  const m = streamingMessage();
  const finishedTurns: ChatMessage[] = [
    { ...m, id: 'f1', status: 'completed', markdown: 'done', turnLatencyMs: 1_000, overheadMs: 100, providerLatencyMs: 900 },
    { ...m, id: 'f2', status: 'completed', markdown: 'done', turnLatencyMs: 2_000, overheadMs: 300, providerLatencyMs: 1_700 },
  ];
  const acc = createTokenRateAccumulator(BASE_NOW);
  tickTokenRate(acc, [...finishedTurns, setContent(m, 0)], BASE_NOW);
  tickTokenRate(acc, [...finishedTurns, setContent(m, 400)], BASE_NOW + 1000);
  const state = tickTokenRate(acc, [...finishedTurns, setContent(m, 800)], BASE_NOW + 2000);

  assert.equal(state.state, 'generating');
  // Inline: avg turn latency = (1000 + 2000) / 2 = 1500ms -> 1.5s.
  assert.match(state.label!, /100 tok\/s · 1\.5s/);
  assert.match(state.tooltip, /Generation rate: 100 tok\/s/);
  assert.match(state.tooltip, /Avg turn latency: 1\.5s over 2 turns/);
  assert.match(state.tooltip, /overhead: 0\.2s/);
  assert.match(state.tooltip, /time to first token: 1\.3s/);
});

test('speed tooltip stays concise when no turn has been measured yet', () => {
  const m = streamingMessage();
  const acc = createTokenRateAccumulator(BASE_NOW);
  tickTokenRate(acc, [setContent(m, 0)], BASE_NOW);
  const state = tickTokenRate(acc, [setContent(m, 400)], BASE_NOW + 1000);
  assert.equal(state.state, 'generating');
  // No measured turns -> no inline turn-latency segment and no latency tooltip lines.
  assert.doesNotMatch(state.label!, /·/);
  assert.doesNotMatch(state.tooltip, /Avg turn latency/);
});

test('inline shows the turn latency even when a measured turn lacks the provider split (tooltip shows —)', () => {
  // A turn was measured (turnLatencyMs present) but without the provider split
  // (providerLatencyMs undefined). The inline segment now shows the total turn
  // latency (not just the provider portion), so it is present even without the
  // split; the tooltip still carries the — placeholder for the missing TTFT.
  const m = streamingMessage();
  const finishedTurns: ChatMessage[] = [
    { ...m, id: 'f1', status: 'completed', markdown: 'done', turnLatencyMs: 1_000, overheadMs: 100, providerLatencyMs: undefined },
  ];
  const acc = createTokenRateAccumulator(BASE_NOW);
  tickTokenRate(acc, [...finishedTurns, setContent(m, 0)], BASE_NOW);
  const state = tickTokenRate(acc, [...finishedTurns, setContent(m, 800)], BASE_NOW + 1000);
  assert.equal(state.state, 'generating');
  // Inline: avg turn latency = 1000ms -> 1.0s (shown despite the missing split).
  assert.match(state.label!, /· 1\.0s/);
  // Tooltip breakdown still renders, with — for the missing time to first token.
  assert.match(state.tooltip, /Avg turn latency: 1\.0s over 1 turn/);
  assert.match(state.tooltip, /overhead: 0\.1s/);
  assert.match(state.tooltip, /time to first token: —/);
});

test('merged average latency also appears in the paused (tool running) tooltip', () => {
  // The latency lines are appended to every tooltip variant, not just the live
  // generating one — verify the paused-with-rate path (a tool call running)
  // keeps the average alongside the held "Last rate".
  const m = streamingMessage();
  const finishedTurns: ChatMessage[] = [
    { ...m, id: 'f1', status: 'completed', markdown: 'done', turnLatencyMs: 1_000, overheadMs: 100, providerLatencyMs: 900 },
    { ...m, id: 'f2', status: 'completed', markdown: 'done', turnLatencyMs: 2_000, overheadMs: 300, providerLatencyMs: 1_700 },
  ];
  const acc = createTokenRateAccumulator(BASE_NOW);
  tickTokenRate(acc, [...finishedTurns, setContent(m, 0)], BASE_NOW);
  tickTokenRate(acc, [...finishedTurns, setContent(m, 400)], BASE_NOW + 1000);
  tickTokenRate(acc, [...finishedTurns, setContent(m, 800)], BASE_NOW + 2000); // ~100 tok/s
  // A tool call starts running on the streaming message — clock pauses.
  const blocked = setContent(
    { ...m, toolCalls: [{ id: 't1', name: 'bash', input: {}, status: 'running' }] },
    800,
  );
  const state = tickTokenRate(acc, [...finishedTurns, blocked], BASE_NOW + 7000);
  assert.equal(state.state, 'paused');
  assert.match(state.label!, /⏸ 100 tok\/s · 1\.5s/);
  assert.match(state.tooltip, /Generation paused \(tool running\)/);
  assert.match(state.tooltip, /Last rate: 100 tok\/s/);
  assert.match(state.tooltip, /Avg turn latency: 1\.5s over 2 turns/);
});

test('computeIdleDisplayState: no measured turns returns the bare idle placeholder', () => {
  // A transcript with no finished, latency-measured turns has nothing to
  // average, so the idle state is the plain IDLE placeholder (no inline segment,
  // no latency tooltip lines) — not a latency chip with a stale dash.
  const m = streamingMessage();
  assert.equal(computeIdleDisplayState([]), IDLE_STATE);
  assert.equal(computeIdleDisplayState([setContent(m, 0)]), IDLE_STATE);
});

test('computeIdleDisplayState: measured turns surface the average latency with no active generation', () => {
  // A loaded transcript that is not generating should still show the average
  // turn latency on the speed chip. The inline turn-latency segment and the
  // tooltip breakdown match the live generating/paused chip exactly (same
  // adapters); only the rate prefix differs (here just '—', since there is no
  // rate) and the state is 'idle' (not 'paused' — nothing is held or resuming).
  const m = streamingMessage();
  const finishedTurns: ChatMessage[] = [
    { ...m, id: 'f1', status: 'completed', markdown: 'done', turnLatencyMs: 1_000, overheadMs: 100, providerLatencyMs: 900 },
    { ...m, id: 'f2', status: 'completed', markdown: 'done', turnLatencyMs: 2_000, overheadMs: 300, providerLatencyMs: 1_700 },
  ];
  const state = computeIdleDisplayState(finishedTurns);
  assert.equal(state.state, 'idle');
  assert.equal(state.paused, false);
  // Inline: avg turn latency = (1000 + 2000) / 2 = 1500ms -> 1.5s.
  assert.equal(state.label, '— · 1.5s');
  assert.match(state.ariaLabel, /Generation rate: idle\. Average turn latency 1\.5s\./);
  assert.match(state.tooltip, /No active generation\./);
  assert.match(state.tooltip, /Avg turn latency: 1\.5s over 2 turns/);
  assert.match(state.tooltip, /time to first token: 1\.3s/);
});

test('computeIdleDisplayState: shows the turn latency inline even without the provider split (tooltip shows —)', () => {
  // Mirrors the live chip: a measured total without the provider split still
  // shows the inline `· Xs` segment (the total turn latency), while the tooltip
  // carries the '—' placeholder for the missing time-to-first-token split.
  const m = streamingMessage();
  const finishedTurns: ChatMessage[] = [
    { ...m, id: 'f1', status: 'completed', markdown: 'done', turnLatencyMs: 1_000, overheadMs: 100, providerLatencyMs: undefined },
  ];
  const state = computeIdleDisplayState(finishedTurns);
  assert.equal(state.state, 'idle');
  // Inline: avg turn latency = 1000ms -> 1.0s (shown despite the missing split).
  assert.equal(state.label, '— · 1.0s');
  assert.match(state.tooltip, /Avg turn latency: 1\.0s over 1 turn/);
  assert.match(state.tooltip, /overhead: 0\.1s/);
  assert.match(state.tooltip, /time to first token: —/);
});

// --- T2: nested (depth-2) subagent output is counted in the token rate ---

/**
 * A running depth-1 subagent call whose own output is idle, but whose messages
 * carry a nested depth-2 subagent toolCall with a live streaming partial — the
 * shape the subagent runner stamps via `tool_execution_update` (T1). The
 * nested partial arrives as `{ content, details: { results } }` (the AgentToolResult
 * the runner's onUpdate emits), which `getRenderableSubagentResult` extracts via
 * `details.results`.
 */
function nestedSubagentToolCall(
  topId: string,
  nestedStreamingTokens: number,
  overrides: { topStatus?: ToolCall['status']; nestedExitCode?: number } = {},
): ToolCall {
  const nestedPartial = {
    content: [{ type: 'text', text: 'nested streaming' }],
    details: {
      mode: 'single' as const,
      results: [
        {
          agent: 'scout',
          task: 't',
          exitCode: overrides.nestedExitCode ?? -1,
          messages: [],
          streamingText: tokenText(nestedStreamingTokens),
        },
      ],
    },
  };
  return {
    id: topId,
    name: 'subagent',
    input: {},
    status: overrides.topStatus ?? 'running',
    result: {
      mode: 'single',
      results: [
        {
          agent: 'scout',
          task: 't',
          exitCode: -1,
          // depth-1's own output is idle; the nested toolCall carries the live partial.
          messages: [
            {
              role: 'assistant',
              content: [
                { type: 'toolCall', id: 'nested-tc', name: 'subagent', arguments: {}, result: nestedPartial },
              ],
            },
          ],
          streamingText: '',
        },
      ],
    },
  };
}

test('nested (depth-2) subagent streaming output is counted in the token rate (T2)', () => {
  // Mirrors the existing "subagent streaming output is counted while the main
  // session is paused on a tool call" test, but one level down: the main
  // session is paused on the depth-1 tool call, and depth-2 streams underneath.
  const m = streamingMessage();
  const acc = createTokenRateAccumulator(BASE_NOW);
  tickTokenRate(acc, [{ ...m, toolCalls: [nestedSubagentToolCall('top', 200)] }], BASE_NOW + 1000);
  const state = tickTokenRate(acc, [{ ...m, toolCalls: [nestedSubagentToolCall('top', 400)] }], BASE_NOW + 2000);
  // ~200 nested tokens over 1s of generation time.
  assert.equal(state.state, 'generating');
  const rate = Number.parseFloat(state.label!.replace(/[^\d.]/g, ''));
  assert.ok(rate >= 180 && rate <= 220, `expected ~200 tok/s from nested subagent, got ${rate}`);
  // The nested tokens were banked into cumTokens (structurally uncountable before T2).
  assert.ok(acc.cumTokens > 0, `expected cumTokens > 0, got ${acc.cumTokens}`);
});

test('nested subagent tokens use a composite key so parallel/collisions never clash (T2)', () => {
  // Two sibling depth-1 subagent calls, each with its own nested depth-2
  // stream. All share toolCall id "nested-tc" for the nested part — without a
  // composite `${parentKey}>...` key the depth-2 snapshots would clobber each
  // other and the delta would be computed between different subagents' counts.
  // Disparate magnitudes (100 vs 300) make a clash produce a visibly wrong rate.
  const m = streamingMessage();
  const acc = createTokenRateAccumulator(BASE_NOW);
  const twoNests = (a: number, b: number): ToolCall[] => [
    nestedSubagentToolCall('top-a', a),
    nestedSubagentToolCall('top-b', b),
  ];
  tickTokenRate(acc, [{ ...m, toolCalls: twoNests(100, 300) }], BASE_NOW + 1000);
  const state = tickTokenRate(acc, [{ ...m, toolCalls: twoNests(300, 500) }], BASE_NOW + 2000);
  // Each nested subagent grew by 200 tokens -> ~400 tok/s combined.
  assert.equal(state.state, 'generating');
  const rate = Number.parseFloat(state.label!.replace(/[^\d.]/g, ''));
  assert.ok(rate >= 360 && rate <= 440, `expected ~400 tok/s from two nested subagents, got ${rate}`);
});

test('completed (non-running) nested subagents are not counted (T2)', () => {
  // A depth-2 result that has finished (exitCode 0) must not anchor a snapshot
  // or contribute to the rate — only running subagents drive the clock. The
  // depth-1 parent is still running (so it occupies its own snapshot slot), but
  // it produces no output, so cumTokens stays 0 and the rate stays paused.
  const m = streamingMessage();
  const acc = createTokenRateAccumulator(BASE_NOW);
  const finished = nestedSubagentToolCall('top', 200, { nestedExitCode: 0 });
  const state = tickTokenRate(acc, [{ ...m, toolCalls: [finished] }], BASE_NOW + 1000);
  assert.equal(state.state, 'paused');
  assert.equal(acc.cumTokens, 0);
  // Only the running depth-1 parent is tracked; the completed nested result is not.
  assert.equal(acc.subagentTokens.size, 1);
  assert.equal(acc.subagentTokens.has('top#0>nested-tc#0'), false);
});
