import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage } from '../../../src/shared/protocol';
import {
  NO_LATENCY_STATS,
  collectMeasuredTurns,
  computeTurnLatencyStats,
  formatAvgTurnLatency,
  formatTurnLatencyTooltipLines,
} from '../../../src/webview/panel/composer/turn-latency';

function assistantMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
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

test('computeTurnLatencyStats reports no data when no finished turn carries latency', () => {
  assert.deepEqual(computeTurnLatencyStats([]), NO_LATENCY_STATS);
  // A streaming turn is not final yet — its latency is not counted.
  assert.deepEqual(computeTurnLatencyStats([assistantMessage({ status: 'streaming', turnLatencyMs: 500 })]), NO_LATENCY_STATS);
  // Finished but no latency fields (e.g. recorded before tracking existed).
  assert.deepEqual(computeTurnLatencyStats([assistantMessage({ turnLatencyMs: undefined })]), NO_LATENCY_STATS);
  // Non-assistant messages are irrelevant.
  assert.deepEqual(
    computeTurnLatencyStats([{ id: 'u1', role: 'user', createdAt: '', markdown: 'hi', status: 'completed' }]),
    NO_LATENCY_STATS,
  );
});

test('collectMeasuredTurns skips streaming turns and turns without latency', () => {
  const transcript: ChatMessage[] = [
    assistantMessage({ id: 'a', status: 'streaming', turnLatencyMs: 500 }),
    assistantMessage({ id: 'b', turnLatencyMs: undefined }),
    assistantMessage({ id: 'c', turnLatencyMs: 800 }),
  ];
  const measured = collectMeasuredTurns(transcript);
  assert.equal(measured.length, 1);
  assert.equal(measured[0]!.id, 'c');
});

test('computeTurnLatencyStats averages the total and components across measured turns', () => {
  const transcript: ChatMessage[] = [
    assistantMessage({ id: 't1', turnLatencyMs: 1_000, overheadMs: 100, providerLatencyMs: 900 }),
    assistantMessage({ id: 't2', turnLatencyMs: 2_000, overheadMs: 300, providerLatencyMs: 1_700 }),
  ];
  const stats = computeTurnLatencyStats(transcript);
  assert.equal(stats.count, 2);
  assert.equal(stats.avgTurnLatencyMs, 1_500);
  assert.equal(stats.avgOverheadMs, 200);
  assert.equal(stats.avgProviderLatencyMs, 1_300);
});

test('computeTurnLatencyStats averages overhead/provider only over turns that measured them', () => {
  // One turn has the full breakdown, the other only a total — the component
  // averages must exclude the unmeasured turn rather than dilute it toward 0
  // (a turn can have a total without a `turn_start`-anchored split).
  const transcript: ChatMessage[] = [
    assistantMessage({ id: 't1', turnLatencyMs: 1_000, overheadMs: 100, providerLatencyMs: 900 }),
    assistantMessage({ id: 't2', turnLatencyMs: 2_000, overheadMs: undefined, providerLatencyMs: undefined }),
  ];
  const stats = computeTurnLatencyStats(transcript);
  assert.equal(stats.count, 2);
  assert.equal(stats.avgTurnLatencyMs, 1_500);
  assert.equal(stats.avgOverheadMs, 100);
  assert.equal(stats.avgProviderLatencyMs, 900);
});

test('formatTurnLatencyTooltipLines is empty until a turn is measured', () => {
  assert.deepEqual(formatTurnLatencyTooltipLines(NO_LATENCY_STATS), []);
  assert.deepEqual(formatTurnLatencyTooltipLines(computeTurnLatencyStats([])), []);
});

test('formatTurnLatencyTooltipLines renders the average with turn count and breakdown', () => {
  const lines = formatTurnLatencyTooltipLines(computeTurnLatencyStats([
    assistantMessage({ id: 't1', turnLatencyMs: 1_000, overheadMs: 100, providerLatencyMs: 900 }),
    assistantMessage({ id: 't2', turnLatencyMs: 2_000, overheadMs: 300, providerLatencyMs: 1_700 }),
  ]));
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /Avg turn latency: 1\.5s over 2 turns/);
  assert.match(lines[1]!, /overhead: 0\.2s/);
  assert.match(lines[2]!, /time to first token: 1\.3s/);
});

test('formatTurnLatencyTooltipLines renders missing components as a dash', () => {
  const lines = formatTurnLatencyTooltipLines(computeTurnLatencyStats([
    assistantMessage({ id: 't1', turnLatencyMs: 1_000, overheadMs: undefined, providerLatencyMs: undefined }),
  ]));
  assert.match(lines[1]!, /overhead: —/);
  assert.match(lines[2]!, /time to first token: —/);
});

test('formatTurnLatencyTooltipLines uses singular "turn" for a single measurement', () => {
  const [line] = formatTurnLatencyTooltipLines(
    computeTurnLatencyStats([assistantMessage({ turnLatencyMs: 1_200, overheadMs: 100, providerLatencyMs: 1_100 })]),
  );
  assert.match(line!, /over 1 turn$/);
});

test('formatAvgTurnLatency is re-exported for inline display', () => {
  const stats = computeTurnLatencyStats([
    assistantMessage({ id: 't1', turnLatencyMs: 1_000, overheadMs: 100, providerLatencyMs: 900 }),
  ]);
  // The total turn latency (1.0s) is shown inline, not the provider portion (0.9s).
  assert.equal(formatAvgTurnLatency(stats), '1.0s');
  assert.equal(formatAvgTurnLatency(NO_LATENCY_STATS), null);
});
