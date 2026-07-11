import assert from 'node:assert/strict';
import test from 'node:test';

import { h } from 'preact';
import renderToString from 'preact-render-to-string';

import { EMPTY_AGGREGATE_STATS } from '../src/shared/protocol';
import { AggregateStatsStrip } from '../src/webview/panel/aggregate-stats-strip';

function renderRate(runningSessionCount: number): string {
  return renderToString(h(AggregateStatsStrip, {
    stats: {
      ...EMPTY_AGGREGATE_STATS,
      ready: true,
      todayTokensPerSecond: 50,
      tokensPerSecond: 42,
      liveTokensPerSecond: runningSessionCount > 0 ? 25 : 0,
      runningSessionCount,
    },
    deferredTriggers: [],
    onOpenDeferredMenu: () => undefined,
  }));
}

test('aggregate stats strip does not present historical throughput as live while idle', () => {
  const html = renderRate(0);
  assert.match(html, /aggregate-strip-rate[^>]*>—<\/span><span class="aggregate-strip-unit"> tok\/s/);
  assert.doesNotMatch(html, />50<\/span><span class="aggregate-strip-unit"> tok\/s/);
});

test('aggregate stats strip presents throughput while a session is running', () => {
  const html = renderRate(1);
  assert.match(html, /aggregate-strip-live-tag">live<\/span>/);
  assert.match(html, />25<\/span><span class="aggregate-strip-unit"> tok\/s/);
});
