import assert from 'node:assert/strict';
import test from 'node:test';

import { h } from 'preact';
import renderToString from 'preact-render-to-string';

import { EMPTY_AGGREGATE_STATS } from '../../../src/shared/protocol';
import {
  AggregateStatsStrip,
  ProviderLegend,
  aggregateStatsSignature,
  throughputTooltipNode,
  workTooltipNode,
} from '../../../src/webview/panel/aggregate-stats-strip';

function renderRate(
  runningSessionCount: number,
  rollingRate = runningSessionCount > 0 ? 25 : 0,
  activeRate = 0,
): string {
  return renderToString(h(AggregateStatsStrip, {
    stats: {
      ...EMPTY_AGGREGATE_STATS,
      ready: true,
      todayTokensPerSecond: 50,
      tokensPerSecond: 42,
      activeGenerationTokensPerSecond: activeRate,
      liveTokensPerSecond: rollingRate,
      runningSessionCount,
    },
    deferredTriggers: [],
    onOpenDeferredMenu: () => {},
  }));
}

test('aggregate stats strip reads the work segment as N working · M open', () => {
  const html = renderToString(h(AggregateStatsStrip, {
    stats: { ...EMPTY_AGGREGATE_STATS, ready: true, runningSessionCount: 2, openTabCount: 5 },
    deferredTriggers: [],
    onOpenDeferredMenu: () => {},
  }));
  assert.match(html, /aggregate-strip-counts"><span class="aggregate-strip-active"><span aria-hidden="true" class="aggregate-strip-active-dot"><\/span>2 working<\/span> · 5 open<\/span>/);
  assert.match(html, /aria-label="[^"]*2 sessions working, 5 open\."/);
  assert.doesNotMatch(html, /\btabs?\b/);
});

test('aggregate stats strip omits the working clause when nothing is running', () => {
  const html = renderToString(h(AggregateStatsStrip, {
    stats: { ...EMPTY_AGGREGATE_STATS, ready: true, runningSessionCount: 0, openTabCount: 3 },
    deferredTriggers: [],
    onOpenDeferredMenu: () => {},
  }));
  assert.match(html, /aggregate-strip-counts">3 open<\/span>/);
  assert.doesNotMatch(html, /aggregate-strip-active-dot/);
  assert.match(html, /aria-label="[^"]*0 sessions working, 3 open\."/);
});

test('aggregate informational rich-tooltip triggers are keyboard-focusable and labelled', () => {
  const html = renderToString(h(AggregateStatsStrip, {
    stats: {
      ...EMPTY_AGGREGATE_STATS,
      ready: true,
      todayCost: 1.25,
      weekCost: 4.5,
      todayInputTokens: 120,
      todayOutputTokens: 340,
      activeGenerationTokensPerSecond: 12,
      liveTokensPerSecond: 10,
      runningSessionCount: 1,
      openTabCount: 2,
      lastRun: {
        cost: 0.5,
        durationMs: 2_000,
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:00:02.000Z',
        modelId: 'model',
        provider: 'provider',
        inputTokens: 10,
        outputTokens: 20,
        turnSeries: [],
      },
      providerGate: {
        enabled: true,
        providers: [{
          provider: 'provider', activeRequests: 1, queuedRequests: 0,
          maxConcurrentRequests: 2, afterburnSeconds: 0, paused: false,
          pausedUntilMs: 0, strikeCount: 0,
        }],
      },
    },
    deferredTriggers: [],
    onOpenDeferredMenu: () => {},
  }));

  const segmentTags = [...html.matchAll(/<span[^>]*class="[^"]*aggregate-strip-seg[^"]*"[^>]*>/g)].map((match) => match[0]);
  const focusableSegments = segmentTags.filter((tag) => tag.includes('tabindex="0"') && tag.includes('aria-label="'));
  assert.equal(focusableSegments.length, 7, 'today, week, tokens, throughput, last, provider gate, and work are focusable');
  for (const tag of focusableSegments) assert.ok(tag.length > 80, 'each segment has a meaningful label');
  assert.match(html, /Today's estimated token cost/);
  assert.match(html, /Estimated token cost this week/);
  assert.match(html, /Today's tokens:/);
  assert.match(html, /Throughput:/);
  assert.match(html, /Latest completed run across all sessions/);
  assert.match(html, /Provider concurrency:/);
  assert.match(html, /Focus for work trend and productivity details/);
});

test('aggregate stats strip labels calendar-day cost as today', () => {
  const html = renderRate(0);
  assert.match(html, /today/);
});

test('aggregate stats strip does not present historical throughput as live while idle', () => {
  const html = renderRate(0);
  assert.match(html, /aggregate-strip-rate[^>]*>—<\/span><span class="aggregate-strip-unit"> tok\/s/);
  assert.doesNotMatch(html, />50<\/span><span class="aggregate-strip-unit"> tok\/s/);
});

test('aggregate stats strip prefers active-generation speed while generating', () => {
  const html = renderRate(1, 25, 60);
  assert.match(html, />60<\/span><span class="aggregate-strip-unit"> tok\/s/);
  assert.match(html, /Active-generation speed 60 tokens per second/);
});

test('aggregate stats strip presents the rolling throughput without a window label while running', () => {
  const html = renderRate(1);
  assert.doesNotMatch(html, />30s<\/span>/);
  assert.match(html, />25<\/span><span class="aggregate-strip-unit"> tok\/s/);
});

test('aggregate stats strip says measuring instead of showing zero for an unmeasured run', () => {
  const html = renderRate(1, 0, 0);
  assert.match(html, />…<\/span><span class="aggregate-strip-unit"> tok\/s/);
  assert.match(html, /measuring or paused/i);
});

test('aggregate stats strip shows the corrected rolling fallback after a short burst', () => {
  // After a between-ticks burst settles, active-generation speed is 0 (nothing
  // is observed streaming) while the corrected rolling 30s rate carries the
  // burst. The strip must show that rolling fallback, not a measuring dash,
  // and must still switch back to active speed the moment generation resumes.
  const afterBurst = renderRate(1, 40, 0);
  assert.match(afterBurst, />40<\/span><span class="aggregate-strip-unit"> tok\/s/);
  assert.doesNotMatch(afterBurst, />…<\/span>/);
  assert.doesNotMatch(afterBurst, />—<\/span><span class="aggregate-strip-unit"/);

  // While output is observed again, active-generation speed stays primary.
  const generating = renderRate(1, 40, 60);
  assert.match(generating, />60<\/span><span class="aggregate-strip-unit"> tok\/s/);
  assert.doesNotMatch(generating, />40<\/span><span class="aggregate-strip-unit"> tok\/s/);
});

test('aggregate stats strip retains recent throughput without a window label after the run becomes idle', () => {
  const html = renderRate(0, 12);
  assert.doesNotMatch(html, />30s<\/span>/);
  assert.match(html, />12<\/span><span class="aggregate-strip-unit"> tok\/s/);
});

test('provider legend entries are focusable and expose provider-qualified nested model tooltips', () => {
  const html = renderToString(h(ProviderLegend, {
    items: [{
      key: 'copilot',
      value: '$1.00',
      models: [{ provider: 'copilot', model: 'shared-model', value: '$1.00' }],
    }],
  }));
  assert.match(html, /<button[^>]*rich-tooltip-legend-trigger/);
  assert.match(html, /role="tooltip"/);
  assert.match(html, /aria-describedby="pie-provider-legend-detail-/);
  assert.match(html, /shared-model/);
  assert.match(html, /\(copilot\)/);
});

test('throughput provider model details retain every sampled model and label their rate scope', () => {
  const html = renderToString(throughputTooltipNode({
    ...EMPTY_AGGREGATE_STATS,
    ready: true,
    activeGenerationTokensPerSecond: 12,
    todayTokensPerSecondByProvider: [{
      provider: 'provider',
      tokensPerSecond: 15,
      outputTokens: 900,
      generationDurationMs: 60_000,
      sampleCount: 2,
    }],
    todayThroughputSeries: [
      {
        ms: 1,
        byProvider: [{ key: 'provider', value: 10 }],
        byModel: [{ key: 'model-a', provider: 'provider', model: 'model-a', value: 10 }],
      },
      {
        ms: 2,
        byProvider: [{ key: 'provider', value: 20 }],
        byModel: [{ key: 'model-b', provider: 'provider', model: 'model-b', value: 20 }],
      },
    ],
  }, 'active'));
  assert.match(html, /model-a/);
  assert.match(html, /model-b/);
  assert.match(html, /Model values: latest sampled rate/);
});

test('aggregate memo signature includes interior redistribution and new token/week series', () => {
  const model = (provider: string, value: number) => ({
    key: 'shared-model', provider, model: 'shared-model', value,
  });
  const base = {
    ...EMPTY_AGGREGATE_STATS,
    ready: true,
    todayCost: 10,
    todayCostSeries: [
      { ms: 1, byProvider: [{ key: 'a', value: 4 }, { key: 'b', value: 1 }], byModel: [model('a', 4), model('b', 1)] },
      { ms: 2, byProvider: [{ key: 'a', value: 5 }, { key: 'b', value: 5 }], byModel: [model('a', 5), model('b', 5)] },
    ],
  };
  const redistributed = {
    ...base,
    todayCostSeries: [
      { ms: 1, byProvider: [{ key: 'a', value: 2 }, { key: 'b', value: 3 }], byModel: [model('a', 2), model('b', 3)] },
      base.todayCostSeries[1]!,
    ],
  };
  assert.notEqual(aggregateStatsSignature(base), aggregateStatsSignature(redistributed));
  assert.notEqual(
    aggregateStatsSignature(base),
    aggregateStatsSignature({ ...base, todayInputTokenSeries: base.todayCostSeries }),
  );
  assert.notEqual(
    aggregateStatsSignature(base),
    aggregateStatsSignature({ ...base, weekCostSeries: base.todayCostSeries }),
  );
  assert.notEqual(
    aggregateStatsSignature(base),
    aggregateStatsSignature({ ...base, activeGenerationTokensPerSecond: 99 }),
  );
  const lastRun = {
    cost: 1, durationMs: 2, startedAt: 's', endedAt: 'e', modelId: 'm', provider: 'p',
    inputTokens: 1, outputTokens: 2,
    turnSeries: [{ ms: 1, outputTokens: 5 }, { ms: 2, outputTokens: 7 }],
  };
  assert.notEqual(
    aggregateStatsSignature({ ...base, lastRun }),
    aggregateStatsSignature({ ...base, lastRun: { ...lastRun, turnSeries: [{ ms: 1, outputTokens: 5 }, { ms: 2, outputTokens: 9 }] } }),
    'last-run sparkline interior turn values must participate in the memo signature',
  );
});

test('aggregate memo signature includes the work trend and productivity summaries', () => {
  const productivity = (sendCount: number) => ({
    sendCount,
    promptCharSamples: 1,
    promptChars: 100,
    averagePromptChars: 100,
    promptTokenSamples: 1,
    promptTokens: 25,
    inputTokens: 10,
    filesystemPathRefCount: 0,
    imageInputCount: 0,
    imageInputBytes: 0,
    askUserAnsweredCount: 0,
    askUserCancelledCount: 0,
    askUserTrackedRuns: 1,
  });
  const trendPoint = (sessionsUsed: number, peak: number, sendCount: number) => ({
    date: '2026-07-04',
    sessionsUsed,
    peakWorkingSessions: peak,
    productivity: productivity(sendCount),
  });
  const base = {
    ...EMPTY_AGGREGATE_STATS,
    ready: true,
    todayProductivity: productivity(2),
    weekProductivity: productivity(5),
    dailyWorkTrend: [trendPoint(2, 1, 2)],
  };

  assert.equal(
    aggregateStatsSignature(base),
    aggregateStatsSignature({ ...base, dailyWorkTrend: [trendPoint(2, 1, 2)] }),
    'equal structured clones keep one memo identity',
  );
  assert.notEqual(
    aggregateStatsSignature(base),
    aggregateStatsSignature({ ...base, dailyWorkTrend: [trendPoint(3, 1, 2)] }),
    'session-used counts participate',
  );
  assert.notEqual(
    aggregateStatsSignature(base),
    aggregateStatsSignature({ ...base, dailyWorkTrend: [trendPoint(2, 2, 2)] }),
    'peak-working counts participate',
  );
  assert.notEqual(
    aggregateStatsSignature(base),
    aggregateStatsSignature({ ...base, dailyWorkTrend: [trendPoint(2, 1, 3)] }),
    'per-day productivity participates',
  );
  assert.notEqual(
    aggregateStatsSignature(base),
    aggregateStatsSignature({ ...base, todayProductivity: productivity(4) }),
    'today productivity participates',
  );
  assert.notEqual(
    aggregateStatsSignature(base),
    aggregateStatsSignature({ ...base, weekProductivity: productivity(6) }),
    'week productivity participates',
  );
});

test('Work tooltip header shows working/open counts and labels the trend honestly', () => {
  const productivity = (sendCount: number) => ({
    sendCount,
    promptCharSamples: 1,
    promptChars: 120,
    averagePromptChars: 120,
    promptTokenSamples: 1,
    promptTokens: 30,
    inputTokens: 5_000,
    filesystemPathRefCount: 3,
    imageInputCount: 2,
    imageInputBytes: 2048,
    askUserAnsweredCount: 1,
    askUserCancelledCount: 2,
    askUserTrackedRuns: 1,
  });
  const stats = {
    ...EMPTY_AGGREGATE_STATS,
    ready: true,
    runningSessionCount: 2,
    openTabCount: 5,
    todayRunCount: 2,
    weekRunCount: 3,
    todayProductivity: productivity(2),
    weekProductivity: { ...productivity(3), promptCharSamples: 2 },
    dailyWorkTrend: [
      { date: '2026-07-03', sessionsUsed: 1, peakWorkingSessions: 1, productivity: productivity(1) },
      { date: '2026-07-04', sessionsUsed: 3, peakWorkingSessions: 2, productivity: productivity(2) },
    ],
  };
  const html = renderToString(workTooltipNode(stats));

  // Current-state header: working and open counts.
  assert.match(html, /rich-tooltip-head"><span>2 working<\/span><span class="rich-tooltip-head-value">5 open<\/span>/);
  // Dual-series trend labels + honest scope statement.
  assert.match(html, /<div role="group" aria-label="14-day work trend: daily distinct sessions used and peak concurrently working sessions\. Open-tab history is not tracked\." class="rich-tooltip-chart-group">/);
  assert.match(html, /sessions used/);
  assert.match(html, /peak working/);
  // Productivity lines carry coverage fractions when tracked samples lag runs.
  assert.match(html, /Today: 2 sends · 120 chars prompt text · avg 120 · chars tracked 1\/2 · ≈30 prompt tok · ↓5k in · 3 file refs · 2 images \(2 KB\) · 5 attachments total · 1 question answered · 2 questions cancelled · ask tracked 1\/2/);
  assert.match(html, /7-day: 3 sends · [\s\S]*chars tracked 2\/3/);
  assert.match(html, /ask tracked 1\/3/);
});

test('Work tooltip keeps filesystem references and images distinct from image bytes', () => {
  const stats = {
    ...EMPTY_AGGREGATE_STATS,
    ready: true,
    runningSessionCount: 0,
    openTabCount: 1,
    todayRunCount: 1,
    weekRunCount: 1,
    todayProductivity: {
      sendCount: 1,
      promptCharSamples: 0,
      promptChars: 0,
      averagePromptChars: null,
      promptTokenSamples: 0,
      promptTokens: 0,
      inputTokens: 0,
      filesystemPathRefCount: 2,
      imageInputCount: 0,
      imageInputBytes: 0,
      askUserAnsweredCount: 0,
      askUserCancelledCount: 0,
      askUserTrackedRuns: 0,
    },
    weekProductivity: {
      sendCount: 1,
      promptCharSamples: 0,
      promptChars: 0,
      averagePromptChars: null,
      promptTokenSamples: 0,
      promptTokens: 0,
      inputTokens: 0,
      filesystemPathRefCount: 0,
      imageInputCount: 0,
      imageInputBytes: 0,
      askUserAnsweredCount: 0,
      askUserCancelledCount: 0,
      askUserTrackedRuns: 0,
    },
    dailyWorkTrend: [],
  };
  const html = renderToString(workTooltipNode(stats));
  assert.match(html, /2 file refs/);
  assert.doesNotMatch(html, /attachments/, 'a single attachment kind never claims a combined total');
  assert.doesNotMatch(html, /image/);
});

test('Work tooltip shows cancelled ask_user questions separately from answered', () => {
  const stats = {
    ...EMPTY_AGGREGATE_STATS,
    ready: true,
    todayRunCount: 1,
    weekRunCount: 1,
    todayProductivity: {
      ...EMPTY_AGGREGATE_STATS.todayProductivity,
      askUserAnsweredCount: 2,
      askUserCancelledCount: 1,
      askUserTrackedRuns: 1,
    },
    weekProductivity: {
      ...EMPTY_AGGREGATE_STATS.weekProductivity,
      askUserAnsweredCount: 0,
      askUserCancelledCount: 1,
      askUserTrackedRuns: 1,
    },
    dailyWorkTrend: [],
  };
  const html = renderToString(workTooltipNode(stats));
  assert.match(html, /2 questions answered/);
  assert.match(html, /1 question cancelled/);
});

test('Work tooltip productivity line stays silent about unknown averages', () => {
  const stats = {
    ...EMPTY_AGGREGATE_STATS,
    ready: true,
    runningSessionCount: 0,
    openTabCount: 1,
    todayRunCount: 1,
    weekRunCount: 1,
    todayProductivity: {
      sendCount: 1,
      promptCharSamples: 0,
      promptChars: 0,
      averagePromptChars: null,
      promptTokenSamples: 0,
      promptTokens: 0,
      inputTokens: 0,
      imageInputCount: 0,
      imageInputBytes: 0,
      filesystemPathRefCount: 0,
      askUserAnsweredCount: 0,
      askUserCancelledCount: 0,
      askUserTrackedRuns: 0,
    },
    weekProductivity: {
      sendCount: 1,
      promptCharSamples: 0,
      promptChars: 0,
      averagePromptChars: null,
      promptTokenSamples: 0,
      promptTokens: 0,
      inputTokens: 0,
      imageInputCount: 0,
      imageInputBytes: 0,
      filesystemPathRefCount: 0,
      askUserAnsweredCount: 0,
      askUserCancelledCount: 0,
      askUserTrackedRuns: 0,
    },
    dailyWorkTrend: [],
  };
  const html = renderToString(workTooltipNode(stats));
  assert.match(html, /Today: 1 send/);
  assert.doesNotMatch(html, /avg /, 'an untracked average is never rendered as zero');
  assert.doesNotMatch(html, /chars tracked/);
  assert.doesNotMatch(html, /ask tracked/);
  assert.match(html, /peak working/, 'the trend legend still renders with an empty window');
});
