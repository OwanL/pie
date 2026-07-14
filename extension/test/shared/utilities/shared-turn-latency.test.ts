import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage } from '../../../src/shared/protocol';
import {
  NO_LATENCY_STATS,
  collectMeasuredTurns,
  computeTurnLatencyStats,
  formatAvgTurnLatency,
  formatTurnLatencyTooltipLines,
} from '../../../src/shared/turn-latency';

/**
 * Pure transcript math — no I/O, no `Date.now()`. Every input is a literal
 * transcript so the averages and tooltip strings are deterministic.
 */

function assistant(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown: 'Done',
    status: 'completed',
    toolCalls: [],
    ...overrides,
  };
}

test('NO_LATENCY_STATS sentinel has the empty shape', () => {
  assert.deepEqual(NO_LATENCY_STATS, {
    count: 0,
    avgTurnLatencyMs: 0,
    avgOverheadMs: null,
    avgProviderLatencyMs: null,
  });
});

test('computeTurnLatencyStats returns the empty sentinel for every no-data case', () => {
  assert.deepEqual(computeTurnLatencyStats([]), NO_LATENCY_STATS);
  // Streaming turns are not final yet -> excluded.
  assert.deepEqual(
    computeTurnLatencyStats([assistant({ status: 'streaming', turnLatencyMs: 500 })]),
    NO_LATENCY_STATS,
  );
  // Finished but no latency measurement (recorded before tracking existed).
  assert.deepEqual(
    computeTurnLatencyStats([assistant({ turnLatencyMs: undefined })]),
    NO_LATENCY_STATS,
  );
  // Non-assistant messages are irrelevant.
  assert.deepEqual(
    computeTurnLatencyStats([{ id: 'u1', role: 'user', createdAt: '', markdown: 'hi', status: 'completed' }]),
    NO_LATENCY_STATS,
  );
});

test('collectMeasuredTurns keeps only finished assistant turns that carry turnLatencyMs', () => {
  const transcript: ChatMessage[] = [
    assistant({ id: 'a', status: 'streaming', turnLatencyMs: 500 }), // streaming -> skip
    assistant({ id: 'b', turnLatencyMs: undefined }),               // no latency -> skip
    assistant({ id: 'c', turnLatencyMs: 800 }),                      // keep
    { id: 'u', role: 'user', createdAt: '', markdown: 'hi', status: 'completed' }, // not assistant
  ];
  const measured = collectMeasuredTurns(transcript);
  assert.equal(measured.length, 1);
  assert.equal(measured[0]!.id, 'c');
});

test('collectMeasuredTurns does not mutate the input transcript', () => {
  const transcript: ChatMessage[] = [assistant({ id: 'c', turnLatencyMs: 800 })];
  const snapshot = [...transcript];
  collectMeasuredTurns(transcript);
  assert.deepEqual(transcript, snapshot);
});

test('computeTurnLatencyStats averages the total and both components across turns', () => {
  const stats = computeTurnLatencyStats([
    assistant({ id: 't1', turnLatencyMs: 1_000, overheadMs: 100, providerLatencyMs: 900 }),
    assistant({ id: 't2', turnLatencyMs: 2_000, overheadMs: 300, providerLatencyMs: 1_700 }),
  ]);
  assert.equal(stats.count, 2);
  assert.equal(stats.avgTurnLatencyMs, 1_500);
  assert.equal(stats.avgOverheadMs, 200);
  assert.equal(stats.avgProviderLatencyMs, 1_300);
});

test('computeTurnLatencyStats averages components only over turns that measured them', () => {
  // One turn has the full breakdown, the other only a total. The component means
  // must exclude the unmeasured turn rather than dilute it toward 0.
  const stats = computeTurnLatencyStats([
    assistant({ id: 't1', turnLatencyMs: 1_000, overheadMs: 100, providerLatencyMs: 900 }),
    assistant({ id: 't2', turnLatencyMs: 2_000, overheadMs: undefined, providerLatencyMs: undefined }),
  ]);
  assert.equal(stats.count, 2);
  assert.equal(stats.avgTurnLatencyMs, 1_500);
  assert.equal(stats.avgOverheadMs, 100);
  assert.equal(stats.avgProviderLatencyMs, 900);
});

test('computeTurnLatencyStats averages overhead and provider over different turn sets independently', () => {
  // Turn 1 has overhead only; turn 2 has provider only. The two component means
  // are computed over disjoint turn sets, proving they are independent.
  const stats = computeTurnLatencyStats([
    assistant({ id: 't1', turnLatencyMs: 1_000, overheadMs: 200, providerLatencyMs: undefined }),
    assistant({ id: 't2', turnLatencyMs: 3_000, overheadMs: undefined, providerLatencyMs: 1_000 }),
  ]);
  assert.equal(stats.count, 2);
  assert.equal(stats.avgTurnLatencyMs, 2_000);
  assert.equal(stats.avgOverheadMs, 200);     // only t1 measured overhead
  assert.equal(stats.avgProviderLatencyMs, 1_000); // only t2 measured provider
});

test('formatTurnLatencyTooltipLines is empty until a turn is measured', () => {
  assert.deepEqual(formatTurnLatencyTooltipLines(NO_LATENCY_STATS), []);
  assert.deepEqual(formatTurnLatencyTooltipLines(computeTurnLatencyStats([])), []);
});

test('formatTurnLatencyTooltipLines renders the average with turn count and breakdown', () => {
  const lines = formatTurnLatencyTooltipLines(computeTurnLatencyStats([
    assistant({ id: 't1', turnLatencyMs: 1_000, overheadMs: 100, providerLatencyMs: 900 }),
    assistant({ id: 't2', turnLatencyMs: 2_000, overheadMs: 300, providerLatencyMs: 1_700 }),
  ]));
  assert.equal(lines.length, 3);
  // Total leads with its turn count; the time-to-first-token line (provider
  // portion) is the value surfaced inline on the speed chip.
  assert.match(lines[0]!, /Avg turn latency: 1\.5s over 2 turns/);
  assert.match(lines[1]!, /overhead: 0\.2s — inter-turn work before the provider request/);
  assert.match(lines[2]!, /time to first token: 1\.3s — request prep \+ network \+ model first token/);
});

test('formatTurnLatencyTooltipLines renders missing components as a dash', () => {
  const lines = formatTurnLatencyTooltipLines(computeTurnLatencyStats([
    assistant({ id: 't1', turnLatencyMs: 1_000, overheadMs: undefined, providerLatencyMs: undefined }),
  ]));
  // Total is always present (turnLatencyMs is the gating field for a "measured"
  // turn); overhead and time-to-first-token are "—" when their split was not
  // measured. The lines are a breakdown, not an equation, so a missing
  // component does not falsify a summation claim.
  assert.match(lines[0]!, /Avg turn latency: 1\.0s over 1 turn/);
  assert.match(lines[1]!, /overhead: —/);
  assert.match(lines[2]!, /time to first token: —/);
});

test('formatTurnLatencyTooltipLines uses singular "turn" for a single measurement', () => {
  const [line] = formatTurnLatencyTooltipLines(
    computeTurnLatencyStats([assistant({ turnLatencyMs: 1_200, overheadMs: 100, providerLatencyMs: 1_100 })]),
  );
  assert.match(line!, /over 1 turn$/);
});

test('formatSeconds sub-100ms latency renders as "<0.1s"', () => {
  const [line] = formatTurnLatencyTooltipLines(
    computeTurnLatencyStats([assistant({ turnLatencyMs: 50, overheadMs: 40, providerLatencyMs: 10 })]),
  );
  assert.match(line!, /Avg turn latency: <0\.1s over 1 turn/);
});

test('formatSeconds 100-999ms latency rounds to one decimal second', () => {
  // 100ms -> 0.1s, 500ms -> 0.5s (on the total-turn-latency line).
  const [a] = formatTurnLatencyTooltipLines(
    computeTurnLatencyStats([assistant({ turnLatencyMs: 100, overheadMs: 100, providerLatencyMs: 0 })]),
  );
  assert.match(a!, /Avg turn latency: 0\.1s over 1 turn/);
  const [b] = formatTurnLatencyTooltipLines(
    computeTurnLatencyStats([assistant({ turnLatencyMs: 500, overheadMs: 500, providerLatencyMs: 0 })]),
  );
  assert.match(b!, /Avg turn latency: 0\.5s over 1 turn/);
});

test('formatSeconds >=1000ms latency renders as seconds with one decimal', () => {
  // 1500ms -> 1.5s, 2500ms -> 2.5s (on the total-turn-latency line).
  const [a] = formatTurnLatencyTooltipLines(
    computeTurnLatencyStats([assistant({ turnLatencyMs: 1_500, overheadMs: 500, providerLatencyMs: 1_000 })]),
  );
  assert.match(a!, /Avg turn latency: 1\.5s over 1 turn/);
  const [b] = formatTurnLatencyTooltipLines(
    computeTurnLatencyStats([assistant({ turnLatencyMs: 2_500, overheadMs: 500, providerLatencyMs: 2_000 })]),
  );
  assert.match(b!, /Avg turn latency: 2\.5s over 1 turn/);
});

test('formatAvgTurnLatency renders the average turn latency for inline display', () => {
  const stats = computeTurnLatencyStats([
    assistant({ id: 't1', turnLatencyMs: 1_000, overheadMs: 100, providerLatencyMs: 900 }),
    assistant({ id: 't2', turnLatencyMs: 2_000, overheadMs: 300, providerLatencyMs: 1_700 }),
  ]);
  // (1000 + 2000) / 2 = 1500ms -> 1.5s — the total turn latency appended to the
  // rate label (the provider/TTFT portion would be 1.3s; the total is shown).
  assert.equal(formatAvgTurnLatency(stats), '1.5s');
});

test('formatAvgTurnLatency returns null until a turn is measured, and shows the total even without the provider split', () => {
  assert.equal(formatAvgTurnLatency(NO_LATENCY_STATS), null);
  // A measured turn without the provider split still has a total turn latency,
  // so the inline segment now shows it (previously it was omitted).
  assert.equal(
    formatAvgTurnLatency(computeTurnLatencyStats([assistant({ turnLatencyMs: 1_000 })])),
    '1.0s',
  );
});
