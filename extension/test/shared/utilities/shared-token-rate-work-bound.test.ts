import assert from 'node:assert/strict';
import test from 'node:test';

import { encode as bpeEncode, decode as bpeDecode } from 'gpt-tokenizer/encoding/cl100k_base';

import type { ChatMessage, ToolCall } from '../../../src/shared/protocol';
import { estimateTextTokens } from '../../../src/shared/tokenize';
import {
  createAccumulator,
  readTokenRateWorkChars,
  resetTokenRateWorkChars,
  tickTokenRate,
} from '../../../src/shared/token-rate';
import {
  getRenderableSubagentResult,
  getRenderableSubagentResultFromToolCall,
  isSubagentSingleResultRunning,
  type SubagentSingleResult,
} from '../../../src/shared/subagent-result';

/**
 * Deterministic WORK-BOUND tests for the shared token-rate measurement.
 *
 * These assert — via the module's diagnostic tokenizer-work counter, never via
 * timings — that a 200ms measurement tick's BPE work is bounded by the sampling
 * window (a few KB of tail sample) rather than proportional to the transcript
 * size, while the estimated-rate semantics are preserved: growth is still
 * counted, terminal estimates stay stable, authoritative provider usage is
 * never estimated on top, and parallel/nested subagent attribution is intact.
 */

const BASE_NOW = 100_000;

const TOKEN_BASE = bpeEncode('The quick brown fox jumps over the lazy dog. '.repeat(1000));

/** Build text that tokenizes to exactly `tokens` cl100k_base tokens. */
function tokenText(tokens: number): string {
  if (tokens <= 0) return '';
  return bpeDecode(TOKEN_BASE.slice(0, Math.min(tokens, TOKEN_BASE.length)));
}

/** ~45KB of prose (the exact-token base unit). */
const PROSE_UNIT = tokenText(TOKEN_BASE.length);

/** Large prose of ~`units` × 45KB without a mid-token truncation artifact. */
function largeProse(units: number): string {
  return PROSE_UNIT.repeat(units);
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

/** Bound on tokenizer characters per tick for any scenario here. The bounded
 * tail sample tokenizes at most ~8KB per text field; a generous margin still
 * excludes any full-text pass over the multi-hundred-KB fixtures below. */
const WORK_BOUND_CHARS = 100_000;

test('unchanged large streaming text: repeat ticks do not re-tokenize the full text', () => {
  const acc = createAccumulator(BASE_NOW);
  const markdown = largeProse(24); // ~1MB
  assert.ok(markdown.length > 1_000_000);

  resetTokenRateWorkChars();
  const first = tickTokenRate(acc, [streamingMessage({ id: 'big', markdown })], BASE_NOW + 200);
  const firstWork = readTokenRateWorkChars();

  resetTokenRateWorkChars();
  const second = tickTokenRate(acc, [streamingMessage({ id: 'big', markdown })], BASE_NOW + 400);
  const secondWork = readTokenRateWorkChars();

  assert.ok(firstWork < WORK_BOUND_CHARS, `first tick tokenized ${firstWork} chars for ${markdown.length} chars of text — must use the bounded tail sample, not full-text BPE`);
  assert.ok(secondWork < WORK_BOUND_CHARS, `unchanged second tick tokenized ${secondWork} chars — must reuse the cached estimate, not re-tokenize ${markdown.length} chars`);

  // Estimated-rate semantics preserved: the first tick counts the visible
  // output and the unchanged stream keeps the clock running (a measured stall).
  assert.ok(acc.cumTokens > 0, 'visible output is still estimated on first sight');
  assert.equal(first.state, 'generating');
  assert.equal(second.state, 'generating', 'a stall on an established stream is still generating');
});

test('growing large streaming text: per-tick work is bounded while growth is still counted', () => {
  const acc = createAccumulator(BASE_NOW);
  const base = largeProse(24); // ~1MB
  const growthPerTick = PROSE_UNIT; // ~45KB appended per tick

  tickTokenRate(acc, [streamingMessage({ id: 'big', markdown: base })], BASE_NOW + 200);
  let previousCum = acc.cumTokens;
  let previousLive = acc.cumTokens;

  for (let i = 1; i <= 3; i += 1) {
    const markdown = base + growthPerTick.repeat(i);
    resetTokenRateWorkChars();
    const state = tickTokenRate(acc, [streamingMessage({ id: 'big', markdown })], BASE_NOW + 200 + i * 200);
    const work = readTokenRateWorkChars();

    assert.ok(work < WORK_BOUND_CHARS, `tick ${i} tokenized ${work} chars for ${markdown.length} chars of growing text`);
    assert.ok(acc.cumTokens > previousCum, `tick ${i} growth must still be counted into the cumulative estimate`);
    assert.ok((state.liveOutputTokens ?? 0) > previousLive, `tick ${i} live output estimate must grow`);
    assert.equal(state.state, 'generating');
    previousCum = acc.cumTokens;
    previousLive = state.liveOutputTokens!;
  }
});

test('stable terminal output: repeated ticks reuse the cached estimate (no re-BPE)', () => {
  const acc = createAccumulator(BASE_NOW);
  const terminal: ChatMessage = {
    ...streamingMessage({ id: 't1', markdown: largeProse(24) }),
    status: 'completed',
    durationMs: 10_000,
    // No usage: the end-to-end rate and the aggregate terminal estimate both
    // tokenize this message — the exact per-tick cost being bounded here.
  };

  resetTokenRateWorkChars();
  const first = tickTokenRate(acc, [terminal], BASE_NOW + 200);
  const firstWork = readTokenRateWorkChars();
  const estimate = first.terminalOutputTokensEstimate;
  const endToEnd = first.endToEndRate;

  resetTokenRateWorkChars();
  const second = tickTokenRate(acc, [terminal], BASE_NOW + 400);
  const secondWork = readTokenRateWorkChars();

  assert.ok(estimate !== undefined && estimate > 0, 'no-usage terminal exposes its conservative estimate');
  assert.ok(firstWork < WORK_BOUND_CHARS, `first tick tokenized ${firstWork} chars`);
  assert.ok(secondWork < WORK_BOUND_CHARS, `stable-terminal tick tokenized ${secondWork} chars — must reuse the cached terminal estimate`);
  assert.equal(second.terminalOutputTokensEstimate, estimate, 'terminal estimate is stable across ticks');
  assert.equal(second.endToEndRate, endToEnd, 'estimated end-to-end rate is stable across ticks');
});

test('terminal subagent history keeps the projection cache usable (genuine status, not seq presence)', () => {
  // A durable/terminal legacy subagent call carries no monotonic `seq`. Its
  // results can never contain a running child (the terminal tool status
  // settles every child), so it must not disable the seq-signature cache —
  // previously ANY seq-less subagent call bypassed the cache every tick.
  const acc = createAccumulator(BASE_NOW);
  const terminalSubCall: ToolCall = {
    id: 'old-sub', name: 'subagent', input: {}, status: 'completed',
    result: {
      mode: 'single',
      results: [{
        agent: 'a', task: 't', exitCode: 0, streaming: false,
        messages: Array.from({ length: 24 }, () => ({
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: largeProse(1) }],
        })),
      }],
    },
  };

  tickTokenRate(acc, [streamingMessage({ id: 'm1', toolCalls: [terminalSubCall] })], BASE_NOW + 200);
  assert.ok(acc.subagentProjectionCache !== undefined, 'terminal-only subagent history must not force the cache to be unsound');
  assert.equal(acc.subagentTokens.size, 0, 'a terminal subagent is not counted as running');
});

test('running legacy subagent with large unchanged streaming text: bounded per-tick work despite seq advances', () => {
  // The live subagent's `seq` advances every tick (progress events), so the
  // revision cache misses every tick by design; the per-result token estimate
  // must then be a bounded tail sample, not full-text BPE of the stream.
  const acc = createAccumulator(BASE_NOW);
  const streamingSub = (seq: number): ToolCall => ({
    id: 'live', name: 'subagent', input: {}, status: 'running', seq,
    result: {
      mode: 'parallel' as const,
      results: [
        { agent: 'a', task: 't', exitCode: -1, messages: [], streamingText: largeProse(7), streaming: true },
        { agent: 'b', task: 't', exitCode: -1, messages: [], streamingText: largeProse(7), streaming: true },
      ],
    },
  });

  resetTokenRateWorkChars();
  const first = tickTokenRate(acc, [streamingMessage({ id: 'm1', toolCalls: [streamingSub(1)] })], BASE_NOW + 200);
  const firstWork = readTokenRateWorkChars();
  assert.ok(firstWork < WORK_BOUND_CHARS, `first tick tokenized ${firstWork} chars for two ~315KB parallel results`);
  assert.ok(acc.cumTokens > 0, 'running subagent output is counted');
  assert.ok(acc.subagentTokens.has('live#0') && acc.subagentTokens.has('live#1'), 'parallel results keep per-result snapshots');

  for (let seq = 2; seq <= 4; seq += 1) {
    resetTokenRateWorkChars();
    const state = tickTokenRate(acc, [streamingMessage({ id: 'm1', toolCalls: [streamingSub(seq)] })], BASE_NOW + 200 + seq * 200);
    const work = readTokenRateWorkChars();
    assert.ok(work < WORK_BOUND_CHARS, `seq ${seq} tick tokenized ${work} chars — unchanged ~630KB of parallel stream must be tail-sampled, not re-BPE'd`);
    assert.equal(state.state, 'generating', 'the streaming subagent keeps the clock running');
    assert.ok(acc.subagentTokens.has('live#0') && acc.subagentTokens.has('live#1'), 'parallel result snapshots remain distinct');
  }
});

test('multi-part subagent sampling clips a large part at the sample boundary', () => {
  const acc = createAccumulator(BASE_NOW);
  const call: ToolCall = {
    id: 'multipart', name: 'subagent', input: {}, status: 'running', seq: 1,
    result: {
      mode: 'single',
      results: [{
        agent: 'worker', task: 'test', exitCode: -1, streaming: true,
        messages: [{ role: 'assistant', content: [{ type: 'text', text: largeProse(24) }] }],
        streamingText: largeProse(24),
      }],
    },
  };
  resetTokenRateWorkChars();
  tickTokenRate(acc, [streamingMessage({ toolCalls: [call] })], BASE_NOW + 200);
  assert.ok(readTokenRateWorkChars() <= 8_192,
    `multi-part sampling submitted ${readTokenRateWorkChars()} characters to BPE`);
});

test('authoritative usage is never re-estimated: a usage-bearing terminal tokenizes nothing', () => {
  const acc = createAccumulator(BASE_NOW);
  const terminal: ChatMessage = {
    ...streamingMessage({ id: 't1', markdown: largeProse(24) }),
    status: 'completed',
    durationMs: 10_000,
    usage: {
      inputTokens: 10,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 110,
    },
  };

  resetTokenRateWorkChars();
  const state = tickTokenRate(acc, [terminal], BASE_NOW + 200);
  const work = readTokenRateWorkChars();

  assert.equal(state.terminalOutputTokensEstimate, undefined, 'provider usage is authoritative — never estimated on top');
  assert.equal(state.endToEndRate, 10);
  assert.ok(work < WORK_BOUND_CHARS, `usage-bearing terminal must not tokenize its ${terminal.markdown!.length} chars of markdown (tokenized ${work})`);
});

// --- Same-length correction regressions (id+length caches went stale) ---

test('same-length corrected streaming text is re-estimated exactly (no stale id+length cache)', () => {
  // A correction that keeps the total character length (e.g. an in-place
  // redaction rewrite) must never be served from a cache keyed by id +
  // lengths. Short fields are identity-compared exactly, so the full change
  // is always reflected.
  const acc = createAccumulator(BASE_NOW);
  const before = 'x'.repeat(1000); // 125 cl100k tokens
  const after = 'x'.repeat(999) + '!'; // SAME length, 127 tokens
  assert.notEqual(estimateTextTokens(before), estimateTextTokens(after), 'fixture must change the token count');
  const message = (markdown: string): ChatMessage => streamingMessage({ id: 'fix', markdown });

  tickTokenRate(acc, [message(before)], BASE_NOW + 200);
  assert.equal(acc.lastContentTokensById.get('fix'), estimateTextTokens(before));

  tickTokenRate(acc, [message(after)], BASE_NOW + 400);
  assert.equal(
    acc.lastContentTokensById.get('fix'), estimateTextTokens(after),
    'same-length correction must be re-estimated exactly, not served stale',
  );
});

test('same-length corrected terminal text is re-estimated (terminal cache not keyed by length alone)', () => {
  const acc = createAccumulator(BASE_NOW);
  const before = 'x'.repeat(1000);
  const after = 'x'.repeat(999) + '!';
  assert.notEqual(estimateTextTokens(before), estimateTextTokens(after));
  const terminal = (markdown: string): ChatMessage => ({
    ...streamingMessage({ id: 't1', markdown }),
    status: 'completed',
    durationMs: 10_000,
  });

  const first = tickTokenRate(acc, [terminal(before)], BASE_NOW + 200);
  assert.equal(first.terminalOutputTokensEstimate, estimateTextTokens(before));

  const second = tickTokenRate(acc, [terminal(after)], BASE_NOW + 400);
  assert.equal(
    second.terminalOutputTokensEstimate, estimateTextTokens(after),
    'a corrected terminal must expose its corrected estimate, never the stale length-keyed value',
  );
});

test('same-length tail correction of a long stream is reflected by the fresh tail estimate', () => {
  // Long fields are fingerprint-checked (head/strided/tail samples), so a
  // same-length correction in the sampled tail invalidates the cache and the
  // fresh bounded estimate reflects the new tail density.
  const acc = createAccumulator(BASE_NOW);
  const length = 1_000_000;
  const before = 'a'.repeat(length); // ~0.125 tokens/char
  // SAME total length, dense tail wider than the 8KB sample window so the
  // fresh tail-based estimate is fully determined by the corrected region.
  const after = 'a'.repeat(length - 9000) + '你'.repeat(9000);
  const message = (markdown: string): ChatMessage => streamingMessage({ id: 'big', markdown });

  tickTokenRate(acc, [message(before)], BASE_NOW + 200);
  const beforeEstimate = acc.lastContentTokensById.get('big')!;

  resetTokenRateWorkChars();
  tickTokenRate(acc, [message(after)], BASE_NOW + 400);
  const work = readTokenRateWorkChars();
  const afterEstimate = acc.lastContentTokensById.get('big')!;

  assert.ok(afterEstimate > beforeEstimate * 3,
    `dense tail correction must be reflected: ${beforeEstimate} → ${afterEstimate}`);
  assert.ok(work < WORK_BOUND_CHARS, `correction tick tokenized ${work} chars — must stay bounded`);
});

// --- Incremental cumulative estimate: no whole-prefix tail-density repricing ---

test('dense append after a low-density prefix counts only the appended tail (no whole-prefix repricing)', () => {
  // Regression: the previous estimate repriced the ENTIRE text at the tail's
  // density on every change, so a dense append onto a low-density prefix
  // manufactured a huge phantom delta (the whole prefix re-priced at the tail
  // density). The incremental estimate must add exactly the appended tail's
  // own bounded estimate and never re-tokenize or reprice old content.
  const acc = createAccumulator(BASE_NOW);
  const prefix = 'a'.repeat(1_000_000); // low density (~0.125 tokens/char)
  const appended = '你'.repeat(4000); // dense (1 token/char), ≤ sample window → exact

  tickTokenRate(acc, [streamingMessage({ id: 'big', markdown: prefix })], BASE_NOW + 200);
  const afterPrefix = acc.cumTokens;
  assert.ok(afterPrefix > 0);

  resetTokenRateWorkChars();
  const state = tickTokenRate(
    acc,
    [streamingMessage({ id: 'big', markdown: prefix + appended })],
    BASE_NOW + 400,
  );
  const work = readTokenRateWorkChars();

  assert.equal(
    acc.cumTokens - afterPrefix, estimateTextTokens(appended),
    'append delta must equal the appended tail\'s own token estimate — the low-density prefix is never repriced',
  );
  assert.ok(work < WORK_BOUND_CHARS, `append tick tokenized ${work} chars — must be bounded by the tail sample`);
  assert.equal(state.state, 'generating');
});

// --- Same incremental semantics across sibling and nested subagents ---

/** A running parallel subagent call: sibling results share one toolCallId;
 * the first sibling also carries a nested (depth-2) running subagent. */
function parallelNestedCall(
  streamingTexts: [string, string],
  nestedStreamingText: string,
): ToolCall {
  return {
    id: 'par',
    name: 'subagent',
    input: {},
    status: 'running',
    result: {
      mode: 'parallel',
      results: [
        {
          agent: 'a', task: 't', exitCode: -1, streaming: true,
          messages: [{
            role: 'assistant',
            content: [{
              type: 'toolCall', id: 'nest-tc', name: 'subagent', arguments: {},
              result: {
                content: [{ type: 'text', text: 'nested' }],
                details: {
                  mode: 'single',
                  results: [{
                    agent: 'n', task: 't', exitCode: -1,
                    messages: [], streamingText: nestedStreamingText, streaming: true,
                  }],
                },
              },
            }],
          }],
          streamingText: streamingTexts[0],
        },
        { agent: 'b', task: 't', exitCode: -1, streaming: true, messages: [], streamingText: streamingTexts[1] },
      ],
    },
  };
}

test('low-density prefix + dense append: sibling and nested subagent deltas count only appended tails', () => {
  const acc = createAccumulator(BASE_NOW);
  const base = (chars: number): string => 'a'.repeat(chars);

  tickTokenRate(
    acc,
    [streamingMessage({ id: 'm', toolCalls: [parallelNestedCall([base(300_000), base(200_000)], base(150_000))] })],
    BASE_NOW + 200,
  );
  const beforeA = acc.subagentTokens.get('par#0')!;
  const beforeB = acc.subagentTokens.get('par#1')!;
  const beforeN = acc.subagentTokens.get('par#0>nest-tc#0')!;
  assert.ok(beforeA > 0 && beforeB > 0 && beforeN > 0, 'sibling and nested results are all counted');

  resetTokenRateWorkChars();
  const state = tickTokenRate(
    acc,
    [streamingMessage({
      id: 'm',
      toolCalls: [parallelNestedCall(
        [base(300_000) + '你'.repeat(2000), base(200_000) + '你'.repeat(1000)],
        base(150_000) + '你'.repeat(500),
      )],
    })],
    BASE_NOW + 400,
  );
  const work = readTokenRateWorkChars();

  // Each key's cumulative count moves by exactly its own appended tail — the
  // low-density prefixes are never repriced by the density change.
  assert.equal(acc.subagentTokens.get('par#0')! - beforeA, estimateTextTokens('你'.repeat(2000)));
  assert.equal(acc.subagentTokens.get('par#1')! - beforeB, estimateTextTokens('你'.repeat(1000)));
  assert.equal(acc.subagentTokens.get('par#0>nest-tc#0')! - beforeN, estimateTextTokens('你'.repeat(500)));
  assert.ok(work < WORK_BOUND_CHARS, `sibling/nested append tick tokenized ${work} chars`);
  assert.equal(state.state, 'generating');
});

// --- Terminal-skip differential: pre-skip walk and actual tick must agree ---

/** Reference implementation of the PRE-skip `findRunningSubagents`: it always
 * ran `getRenderableSubagentResultFromToolCall` (which normalizes every DIRECT
 * child of a terminal call to a settled state) and only recursed into nested
 * results for direct children that were themselves running. Used to verify
 * differentially that skipping terminal tool calls entirely is behaviorally
 * identical — a stale nested running child under a terminal call was already
 * unreachable before the skip. */
function preSkipFindRunningSubagents(transcript: ChatMessage[]): SubagentSingleResult[] {
  const running: SubagentSingleResult[] = [];
  const walkNested = (result: SubagentSingleResult, depth: number): void => {
    if (depth >= 3) return;
    const messages = Array.isArray(result.messages) ? result.messages : [];
    for (const msg of messages) {
      if (msg.role !== 'assistant') continue;
      const parts = Array.isArray(msg.content) ? msg.content : [];
      for (const part of parts) {
        const record = typeof part === 'object' && part !== null ? part as unknown as Record<string, unknown> : undefined;
        if (!record || record.type !== 'toolCall' || record.name !== 'subagent') continue;
        const nested = getRenderableSubagentResult(record.result);
        if (!nested) continue;
        nested.results.forEach((single) => {
          if (isSubagentSingleResultRunning(single)) {
            running.push(single);
            walkNested(single, depth + 1);
          }
        });
      }
    }
  };
  for (const message of transcript) {
    for (const toolCall of message.toolCalls ?? []) {
      if (toolCall.name !== 'subagent') continue;
      const subagentResult = getRenderableSubagentResultFromToolCall(toolCall as ToolCall);
      if (!subagentResult) continue;
      subagentResult.results.forEach((single, index) => {
        if (isSubagentSingleResultRunning(single)) {
          running.push(single);
          void index;
          walkNested(single, 1);
        }
      });
    }
  }
  return running;
}

test('terminal subagent call with a stale nested running child: pre-skip walk and skip agree', () => {
  // Differential verification for the terminal-skip optimization: a terminal
  // top-level call whose durable child history contains a stale nested RUNNING
  // child. The pre-skip walk must already exclude it (normalize settles every
  // direct child of a terminal call, and recursion only happened for running
  // direct children), so skipping the parse must not change any tick result.
  const terminalCall: ToolCall = {
    id: 'done', name: 'subagent', input: {}, status: 'completed',
    result: {
      mode: 'single',
      results: [{
        agent: 'a', task: 't', exitCode: 0, streaming: false,
        messages: [{
          role: 'assistant',
          content: [{
            type: 'toolCall', id: 'stale', name: 'subagent', arguments: {},
            result: {
              content: [{ type: 'text', text: 'stale' }],
              details: {
                mode: 'single',
                results: [{
                  agent: 'n', task: 't', exitCode: -1,
                  messages: [], streamingText: 'stale output', streaming: true,
                }],
              },
            },
          }],
        }],
      }],
    },
  };
  const transcript = [streamingMessage({ id: 'm', toolCalls: [terminalCall] })];

  // BEFORE (reference pre-skip walk): the stale nested running child is
  // unreachable — no running subagent is found.
  assert.equal(preSkipFindRunningSubagents(transcript).length, 0,
    'pre-skip walk already excludes a nested running child under a terminal call');

  // AFTER (actual tick with the terminal skip): identical — nothing counted.
  const acc = createAccumulator(BASE_NOW);
  const state = tickTokenRate(acc, transcript, BASE_NOW + 200);
  assert.equal(acc.subagentTokens.size, 0, 'terminal call contributes no running subagent snapshots');
  assert.equal(acc.cumTokens, 0, 'no tokens counted from a terminal call\'s stale nested child');
  assert.equal(acc.subagentProjectionCache?.projection.counted.length ?? 0, 0,
    'no running subagents are projected (terminal seq-less history keeps the cache usable)');
  assert.ok((state.liveOutputTokens ?? 0) === 0, 'live output excludes the terminal call entirely');
});