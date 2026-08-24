import assert from 'node:assert/strict';
import test from 'node:test';

import { h } from 'preact';
import renderToString from 'preact-render-to-string';

import { EMPTY_AGGREGATE_STATS } from '../../../src/shared/protocol';
import { AggregateStatsStrip } from '../../../src/webview/panel/aggregate-stats-strip';

function renderRate(runningSessionCount: number, rollingRate = runningSessionCount > 0 ? 25 : 0): string {
  return renderToString(h(AggregateStatsStrip, {
    stats: {
      ...EMPTY_AGGREGATE_STATS,
      ready: true,
      todayTokensPerSecond: 50,
      tokensPerSecond: 42,
      liveTokensPerSecond: rollingRate,
      runningSessionCount,
    },
    deferredTriggers: [],
    onOpenDeferredMenu: () => {},
  }));
}

test('aggregate stats strip labels calendar-day cost as today', () => {
  const html = renderRate(0);
  assert.match(html, /today/);
});

test('aggregate stats strip does not present historical throughput as live while idle', () => {
  const html = renderRate(0);
  assert.match(html, /aggregate-strip-rate[^>]*>—<\/span><span class="aggregate-strip-unit"> tok\/s/);
  assert.doesNotMatch(html, />50<\/span><span class="aggregate-strip-unit"> tok\/s/);
});

test('aggregate stats strip presents the rolling throughput without a window label while running', () => {
  const html = renderRate(1);
  assert.doesNotMatch(html, />30s<\/span>/);
  assert.match(html, />25<\/span><span class="aggregate-strip-unit"> tok\/s/);
});

test('aggregate stats strip retains recent throughput without a window label after the run becomes idle', () => {
  const html = renderRate(0, 12);
  assert.doesNotMatch(html, />30s<\/span>/);
  assert.match(html, />12<\/span><span class="aggregate-strip-unit"> tok\/s/);
});
