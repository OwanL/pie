import assert from 'node:assert/strict';
import test from 'node:test';

import { h, render, type VNode } from 'preact';
import rawRenderToString from 'preact-render-to-string';
import { act } from 'preact/test-utils';
import { installDom } from '../helpers/dom';
installDom();

function renderToString<P>(node: VNode<P>): string {
  if ((node.type as unknown) !== AggregateStatsStrip) return rawRenderToString(node);
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { width: this.classList.contains('aggregate-strip-metrics') ? 10000 : 80 } as DOMRect;
  };
  const root = document.createElement('div');
  document.body.appendChild(root);
  try {
    act(() => render(node, root));
    return root.innerHTML;
  } finally {
    act(() => render(null, root));
    root.remove();
    HTMLElement.prototype.getBoundingClientRect = original;
  }
}

import { EMPTY_AGGREGATE_STATS } from '../../../lib/protocol/index.js';
import type { DeferredTriggerView } from '../../../lib/protocol/index.js';
import { DeferredTriggersMenu } from '../../analytics/aggregate-stats-strip/deferred-triggers-menu';
import {
  AggregateStatsStrip,
  ProviderLegend,
  aggregateStatsSignature,
  todayCostTooltipNode,
  tokensTooltipNode,
  weekCostTooltipNode,
  userInputTooltipNode,
  workTooltipNode,
} from '../../analytics/aggregate-stats-strip';

test('deferred trigger menu exposes safe crash recovery separately from ambiguous delivery', () => {
  const common = {
    sessionPath: '/workspace/session.jsonl',
    triggers: [{ kind: 'timer' as const, ms: 1000 }],
    note: 'resume work',
    registeredAt: '2026-09-03T10:00:00.000Z',
  };
  const html = renderToString(h(DeferredTriggersMenu, {
    triggers: [
      {
        ...common,
        id: 'recovered',
        deliveryState: 'retryable' as const,
        recoveryState: 'dead-owner-recovered' as const,
        deliveryDetail: 'claim owner exited before dispatch; delivery recovered and is retryable',
      },
      {
        ...common,
        id: 'ambiguous',
        deliveryState: 'claimed' as const,
        recoveryState: 'acknowledgement-ambiguous' as const,
        deliveryDetail: 'delivery may have started; awaiting acknowledgement and automatic retry is blocked',
      },
    ],
    sessionByPath: new Map(),
    x: 0,
    y: 0,
    onCancel: () => undefined,
    onClose: () => undefined,
  }));

  assert.match(html, /owner exited before dispatch; delivery recovered and is retryable/);
  assert.match(html, /delivery may have started; awaiting acknowledgement and automatic retry is blocked/);
});

test('wakeup timers wait for the creator response only until their timer starts', () => {
  const common = {
    id: 'wakeup',
    sessionPath: '/workspace/creator.jsonl',
    triggers: [{ kind: 'timer' as const, ms: 60_000 }],
    note: 'resume work',
    registeredAt: '2026-09-03T10:00:00.000Z',
    deliveryState: 'pending' as const,
    wakeupMode: true,
  };
  const scenarios: [string, DeferredTriggerView, boolean][] = [
    ['unstarted', common, true],
    ['started', { ...common, timerStartedAt: '2026-09-03T10:01:00.000Z' }, false],
    ['legacy', { ...common, wakeupMode: false }, false],
    ['non-timer', { ...common, triggers: [{ kind: 'user_input' as const }] }, false],
    ['claimed', { ...common, deliveryState: 'claimed' as const }, false],
  ];
  for (const [label, trigger, waiting] of scenarios) {
    const html = renderToString(h(DeferredTriggersMenu, {
      triggers: [trigger], sessionByPath: new Map(), x: 0, y: 0,
      onCancel: () => undefined, onClose: () => undefined,
    }));
    assert.equal(html.includes('Waiting for response to finish'), waiting, label);
    assert.match(html, /aria-label="Pending wakeup timers"/);
    assert.doesNotMatch(html, /1 pending wakeup timer/);
  }
});

test('deferred trigger menu renders command predicates and bounds diagnostics', () => {
  const html = renderToString(h(DeferredTriggersMenu, {
    triggers: [{
      id: 'command',
      sessionPath: '/workspace/session.jsonl',
      triggers: [{
        kind: 'command' as const,
        command: 'printf true && printf a-very-long-command-that-is-still-readable',
        cwd: '/workspace',
        intervalMs: 30_000,
        timeoutMs: 5_000,
      }],
      note: 'wait for the check',
      registeredAt: '2026-09-03T10:00:00.000Z',
      deliveryState: 'pending' as const,
      recoveryState: undefined,
      deliveryDetail: 'diagnostic '.repeat(100),
    }],
    sessionByPath: new Map(),
    x: 0,
    y: 0,
    onCancel: () => undefined,
    onClose: () => undefined,
  }));

  assert.match(html, /when command returns true/);
  assert.match(html, /printf true/);
  assert.match(html, /diagnostic/);
  assert.ok(html.length < 5_000, 'command diagnostics should not dump unbounded output');
});

test('aggregate stats strip retains all three counts including zeros in order', () => {
  for (const count of [0, 3]) {
    const html = renderToString(h(AggregateStatsStrip, {
      stats: { ...EMPTY_AGGREGATE_STATS, ready: true, runningSessionCount: count, openTabCount: count },
      snoozedSessionCount: count,
      deferredTriggers: [], onOpenDeferredMenu: () => {},
    }));
    const counts = html.slice(html.indexOf('data-stat="open"'));
    assert.ok(counts.indexOf(count + ' open') < counts.indexOf(count + ' working'));
    assert.ok(counts.indexOf(count + ' working') < counts.indexOf(count + ' snoozed'));
    assert.doesNotMatch(html, /aggregate-strip-active-dot/);
  }
});

test('aggregate stats strip omits the character indicator while retaining session counts and productivity details', () => {
  const html = renderToString(h(AggregateStatsStrip, {
    stats: {
      ...EMPTY_AGGREGATE_STATS,
      ready: true,
      todayRunCount: 2,
      todayProductivity: {
        ...EMPTY_AGGREGATE_STATS.todayProductivity,
        adjustedUserInputChars: 1_450,
        knownUserInputCharSampleCount: 3,
        expectedUserInputCharSampleCount: 3,
        cappedUserInputCharSampleCount: 1,
        userInputCharCap: 800,
      },
      openTabCount: 4,
    },
    deferredTriggers: [],
    onOpenDeferredMenu: () => {},
  }));
  assert.doesNotMatch(html, /aggregate-strip-user-input| chars<\/span>/);
  assert.match(html, /data-stat="open".*4 open.*data-stat="working".*0 working.*data-stat="snoozed".*0 snoozed/);
  const productivityTooltip = renderToString(userInputTooltipNode({
    ...EMPTY_AGGREGATE_STATS,
    ready: true,
    todayProductivity: {
      ...EMPTY_AGGREGATE_STATS.todayProductivity,
      adjustedUserInputChars: 1_450,
      knownUserInputCharSampleCount: 3,
      expectedUserInputCharSampleCount: 3,
      cappedUserInputCharSampleCount: 1,
      userInputCharCap: 800,
    },
  }));
  assert.match(productivityTooltip, /1\.4k chars/);
});

test('aggregate strip uses one measured priority row and inert measurement copies', () => {
  const html = renderToString(h(AggregateStatsStrip, {
    stats: { ...EMPTY_AGGREGATE_STATS, ready: true }, deferredTriggers: [], onOpenDeferredMenu: () => {},
  }));
  const keys = [...html.matchAll(/data-stat="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(keys, ['today', 'week', 'input', 'output', 'open', 'working', 'snoozed']);
  assert.doesNotMatch(html, /status-cluster|fade-left|fade-right/);
  const measurements = html.slice(html.indexOf('class="aggregate-strip-measurements"'));
  assert.doesNotMatch(measurements, /tabindex|<button|pie-tooltip| id=/);
});

test('provider concurrency hides idle and unlimited capacity, including queued or paused providers', () => {
  const html = renderToString(h(AggregateStatsStrip, {
    stats: {
      ...EMPTY_AGGREGATE_STATS,
      ready: true,
      providerGate: {
        enabled: true,
        providers: [0, 2, Infinity].flatMap((limit) => [0, 1].map((active) => ({
          provider: `provider-${limit}-${active}`, activeRequests: active, queuedRequests: 3,
          maxConcurrentRequests: limit, afterburnSeconds: 0, paused: true,
          pausedUntilMs: 0, strikeCount: 0,
        }))),
      },
    },
    deferredTriggers: [],
    onOpenDeferredMenu: () => {},
  }));

  assert.match(html, /1\/2/);
  assert.match(html, /provider-2-1/);
  assert.doesNotMatch(html, /provider-0-|provider-Infinity-|provider-2-0|∞|0\/2/);
});

test('provider segment and its separator disappear when no capacity is visible or the gate is disabled', () => {
  for (const enabled of [true, false]) {
    const html = renderToString(h(AggregateStatsStrip, {
      stats: {
        ...EMPTY_AGGREGATE_STATS,
        ready: true,
        providerGate: {
          enabled,
          providers: [{
            provider: 'idle', activeRequests: enabled ? 0 : 1, queuedRequests: 2,
            maxConcurrentRequests: 2, afterburnSeconds: 0, paused: true,
            pausedUntilMs: 0, strikeCount: 1,
          }, {
            provider: 'unlimited', activeRequests: 5, queuedRequests: 0,
            maxConcurrentRequests: 0, afterburnSeconds: 0, paused: false,
            pausedUntilMs: 0, strikeCount: 0,
          }],
        },
      },
      deferredTriggers: [],
      onOpenDeferredMenu: () => {},
    }));
    assert.doesNotMatch(html, /aggregate-strip-providers|Provider concurrency:/);
    assert.equal((html.match(/class="aggregate-strip-sep"/g) ?? []).length, 0);
  }
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
  assert.equal(focusableSegments.length, 8, 'independent cost, token, status, and provider items are focusable');
  for (const tag of focusableSegments) assert.ok(tag.length > 80, 'each segment has a meaningful label');
  assert.match(html, /Today's estimated token cost/);
  assert.match(html, /Estimated token cost this week/);
  assert.match(html, /Today's input tokens:/);
  assert.match(html, /Today's output tokens:/);
  assert.doesNotMatch(html, /Latest completed run|\blast\b/);
  assert.match(html, />tdy /);
  assert.doesNotMatch(html, />today /);
  assert.match(html, /Provider concurrency:/);
  assert.doesNotMatch(html, /Today's adjusted user input|character-volume details/);
  assert.match(html, /Focus for 14-day work trend/);
});

test("independent token popovers open on their anchor's series and retain the toggle", () => {
  const stats = { ...EMPTY_AGGREGATE_STATS, ready: true };
  for (const kind of ['input', 'output'] as const) {
    const html = renderToString(tokensTooltipNode(stats, kind));
    assert.match(html, new RegExp(`aria-pressed="true">${kind === 'input' ? 'Input' : 'Output'}`));
    assert.match(html, /Token chart series/);
  }
});

test("token popovers persist each anchor's explicit toggle across reopen without cross-anchor bleed", async () => {
  const stats = { ...EMPTY_AGGREGATE_STATS, ready: true, todayInputTokens: 100, todayOutputTokens: 200 };
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { width: this.classList.contains('aggregate-strip-metrics') ? 10000 : 80 } as DOMRect;
  };
  const root = document.createElement('div');
  document.body.appendChild(root);
  try {
    act(() => render(h(AggregateStatsStrip, {
      stats,
      deferredTriggers: [],
      onOpenDeferredMenu: () => {},
    }), root));
    const openAnchor = async (key: string) => {
      const seg = root.querySelector<HTMLElement>(`[data-stat="${key}"] [tabindex]`);
      assert.ok(seg, `anchor ${key} renders an interactive trigger`);
      await act(async () => {
        seg.focus();
        await new Promise((resolve) => window.setTimeout(resolve, 400));
      });
      const region = document.getElementById(seg.getAttribute('aria-describedby')!);
      assert.ok(region, `anchor ${key} opens its rich token tooltip`);
      return region;
    };
    const closePopover = (seg: HTMLElement) => {
      act(() => { seg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
      act(() => seg.blur());
    };
    const selected = (region: HTMLElement) =>
      region.querySelector<HTMLButtonElement>('[role="group"] button[aria-pressed="true"]')?.textContent;
    const toggleButton = (region: HTMLElement, label: string) =>
      [...region.querySelectorAll<HTMLButtonElement>('[role="group"] button')]
        .find((button) => button.textContent === label);

    // Fresh selection: clicking an anchor naturally presents its own series.
    const inputSeg = root.querySelector<HTMLElement>('[data-stat="input"] [tabindex]')!;
    const outputSeg = root.querySelector<HTMLElement>('[data-stat="output"] [tabindex]')!;
    assert.equal(selected(await openAnchor('input')), 'Input');
    closePopover(inputSeg);
    assert.equal(selected(await openAnchor('output')), 'Output');
    closePopover(outputSeg);

    // Explicit toggles persist per anchor across reopen.
    const inputRegion = await openAnchor('input');
    act(() => toggleButton(inputRegion, 'Output')!.click());
    assert.equal(selected(inputRegion), 'Output', 'the toggle applies within the open popover');
    closePopover(inputSeg);
    const outputRegion = await openAnchor('output');
    act(() => toggleButton(outputRegion, 'Input')!.click());
    assert.equal(selected(outputRegion), 'Input');
    closePopover(outputSeg);
    assert.equal(selected(await openAnchor('input')), 'Output', 'the input anchor replays its own explicit toggle');
    closePopover(inputSeg);
    assert.equal(selected(await openAnchor('output')), 'Input', 'the output anchor replays its own explicit toggle');
    closePopover(outputSeg);
  } finally {
    act(() => render(null, root));
    root.remove();
    HTMLElement.prototype.getBoundingClientRect = originalRect;
  }
});

test('daily and weekly cost tooltips omit routine scope rows and retain graphs and legends', () => {
  const stats = {
    ...EMPTY_AGGREGATE_STATS,
    ready: true,
    todayCost: 1.25,
    weekCost: 4.5,
    todayRunCount: 2,
    weekRunCount: 5,
    todayInputTokens: 1_200,
    todayOutputTokens: 3_400,
    todayCostByProvider: [{
      provider: 'alpha', cost: 1.25, inputTokens: 1_200, outputTokens: 3_400,
      cacheReadTokens: 0, cacheWriteTokens: 0,
    }],
    weekCostByProvider: [{
      provider: 'alpha', cost: 4.5, inputTokens: 5_600, outputTokens: 7_800,
      cacheReadTokens: 0, cacheWriteTokens: 0,
    }],
    todayCostSeries: [{
      ms: 1_750_000_000_000,
      byProvider: [{ key: 'alpha', value: 1.25 }],
      byModel: [{ key: 'model-a', provider: 'alpha', model: 'model-a', value: 1.25 }],
    }],
    weekCostSeries: [{
      ms: 1_750_000_000_000,
      byProvider: [{ key: 'alpha', value: 4.5 }],
      byModel: [{ key: 'model-a', provider: 'alpha', model: 'model-a', value: 4.5 }],
    }],
  };
  const todayHtml = renderToString(todayCostTooltipNode(stats));
  const weekHtml = renderToString(weekCostTooltipNode(stats));

  for (const html of [todayHtml, weekHtml]) {
    assert.doesNotMatch(html, /API-equivalent estimate; not an invoice|Across all sessions|\b[25] runs\b/);
    assert.doesNotMatch(html, /All-time|subscriptions|invoices are not reconciled/);
    assert.match(html, /rich-tooltip-legend-trigger/);
  }
  assert.match(todayHtml, /<svg\b/);
  assert.doesNotMatch(todayHtml, /↓1\.2k in {2}↑3\.4k out/);
  assert.match(todayHtml, /model-a/);
  assert.match(weekHtml, /<svg\b/);
  assert.match(weekHtml, /Token counts by provider · alpha ↓5\.6k in ↑7\.8k out/);
  assert.match(weekHtml, /model-a/);
});

test('aggregate strip keeps cost and token segments clean while provenance detail stays accessible', () => {
  const stats = {
    ...EMPTY_AGGREGATE_STATS,
    ready: true,
    todayCost: 1.25,
    weekCost: 4.5,
    todayInputTokens: 1_200,
    todayOutputTokens: 3_400,
    billableAccounting: {
      invocationCount: 10,
      todayUnknownInvocationCount: 1,
      todayUnpricedInvocationCount: 2,
      todayInstrumentationGapInvocationCount: 1,
      weekUnknownInvocationCount: 1,
      weekUnpricedInvocationCount: 2,
      weekInstrumentationGapInvocationCount: 1,
      unknownInvocationCount: 1,
      unpricedInvocationCount: 2,
      instrumentationGapInvocationCount: 1,
    },
  };
  const html = renderToString(h(AggregateStatsStrip, {
    stats,
    deferredTriggers: [],
    onOpenDeferredMenu: () => {},
  }));

  // Weak visible suffixes are gone from the strip's cost and token segments.
  assert.doesNotMatch(html, /\*[\s<]/);
  assert.doesNotMatch(html, /~[\s<]/);
  // The detail stays in the accessible labels — unknown is never a silent zero.
  assert.match(html, /Estimated token cost this week \$4\.50; incomplete billing provenance/);
  assert.match(html, /known subtotal with incomplete invocation usage/);

  const todayTooltip = renderToString(todayCostTooltipNode(stats));
  assert.match(todayTooltip, /Incomplete billing provenance: 1 unknown and 2 unpriced invocation\(s\) today/);
  const tokens = renderToString(tokensTooltipNode(stats, 'input'));
  assert.match(tokens, /Known subtotal · 1 invocation/);
  assert.equal((tokens.match(/↓1\.2k/g) ?? []).length, 1);
  assert.match(tokens, /aria-label="Token chart series"/);
  assert.match(tokens, />Input<\/button>/);
  assert.match(tokens, />Output<\/button>/);
  const weekTooltip = renderToString(weekCostTooltipNode(stats));
  assert.match(weekTooltip, /Incomplete billing provenance: 1 unknown and 2 unpriced invocation\(s\)/);
  for (const tooltip of [todayTooltip, weekTooltip]) {
    assert.match(tooltip, /1 instrumentation gap\(s\)/);
    assert.doesNotMatch(tooltip, /API-equivalent estimate; not an invoice|Across all sessions/);
  }
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

test('provider legend ids are per-instance pure: identical across renders and never cross-linked', () => {
  const items = [{ key: 'alpha', value: '$1.00', models: [] }];
  const draw = () => renderToString(h(ProviderLegend, { items }));
  const ids = (html: string) => [...html.matchAll(/aria-describedby="(pie-provider-legend-detail-[^"]+)"/g)].map((match) => match[1]);
  const first = ids(draw());
  assert.ok(first.length > 0);
  assert.deepEqual(ids(draw()), first, 'identical legends render deterministic ids regardless of prior render order');
  const pairIds = ids(renderToString(h('div', {}, h(ProviderLegend, { items }), h(ProviderLegend, { items }))));
  assert.equal(new Set(pairIds).size, pairIds.length, 'two mounted legends never share a detail id');
  assert.equal(pairIds.length, first.length * 2, 'each legend item keeps exactly one described-by id');
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
  const lastRun = {
    cost: 1, durationMs: 2, startedAt: 's', endedAt: 'e', modelId: 'm', provider: 'p',
    inputTokens: 1, outputTokens: 2,
    turnSeries: [{ ms: 1, outputTokens: 5 }, { ms: 2, outputTokens: 7 }],
  };
  assert.equal(
    aggregateStatsSignature(base),
    aggregateStatsSignature({ ...base, lastRun }),
    'removed last-run detail does not invalidate the strip memo signature',
  );
});

test('aggregate memo signature includes concurrency provenance and worker acknowledgement status', () => {
  const base = {
    ...EMPTY_AGGREGATE_STATS,
    providerGate: {
      enabled: true,
      providers: [{
        provider: 'alpha', activeRequests: 1, queuedRequests: 0, maxConcurrentRequests: 3,
        maxConcurrentRequestsSource: 'environment-override' as const,
        afterburnSeconds: 0, paused: false, pausedUntilMs: 0, strikeCount: 0,
      }],
      subagentConcurrency: {
        scope: 'worker-process' as const,
        configured: { value: 8, source: 'saved-preference' as const },
        workerCount: 2,
        pendingWorkers: 1,
      },
    },
  };

  assert.notEqual(
    aggregateStatsSignature(base),
    aggregateStatsSignature({
      ...base,
      providerGate: {
        ...base.providerGate,
        providers: [{ ...base.providerGate.providers[0]!, maxConcurrentRequestsSource: 'configured-default' }],
      },
    }),
    'provider source changes participate in the strip equality signature',
  );
  assert.notEqual(
    aggregateStatsSignature(base),
    aggregateStatsSignature({
      ...base,
      providerGate: {
        ...base.providerGate,
        subagentConcurrency: { ...base.providerGate.subagentConcurrency, pendingWorkers: 0 },
      },
    }),
    'worker sync status changes participate in the strip equality signature',
  );
  assert.notEqual(
    aggregateStatsSignature(base),
    aggregateStatsSignature({
      ...base,
      providerGate: {
        ...base.providerGate,
        subagentConcurrency: {
          ...base.providerGate.subagentConcurrency,
          effective: { value: 6, source: 'environment-override' },
        },
      },
    }),
    'runtime acknowledgement values and source participate in the strip equality signature',
  );
});

test('aggregate memo signature includes the work trend and productivity summaries', () => {
  const productivity = (sendCount: number) => ({
    ...EMPTY_AGGREGATE_STATS.todayProductivity,
    sendCount,
    adjustedUserInputChars: sendCount * 100,
    knownUserInputCharSampleCount: sendCount,
    expectedUserInputCharSampleCount: sendCount,
    userInputCharCap: 100,
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

test('Work tooltip contains working/open/snoozed state and the trend', () => {
  const productivity = (sendCount: number) => ({
    ...EMPTY_AGGREGATE_STATS.todayProductivity,
    sendCount,
    adjustedUserInputChars: sendCount * 120,
    knownUserInputCharSampleCount: sendCount,
    expectedUserInputCharSampleCount: sendCount,
    userInputCharCap: 120,
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
  assert.match(html, /rich-tooltip-head"><span>2 working<\/span><span class="rich-tooltip-head-value">5 open · 0 snoozed<\/span>/);
  // Dual-series trend labels + honest scope statement.
  assert.match(html, /<div role="group" aria-label="14-day work trend: daily distinct sessions used and peak concurrently working sessions\. Open-tab history is not tracked\." class="rich-tooltip-chart-group">/);
  assert.match(html, /sessions used/);
  assert.match(html, /peak working/);
  assert.doesNotMatch(html, /Today|7-day|prompt|question|productivity|all-time|runs|tokens/i);
});

test('Work tooltip retains its trend legend when no historical points exist', () => {
  const html = renderToString(workTooltipNode({
    ...EMPTY_AGGREGATE_STATS,
    ready: true,
    openTabCount: 1,
    dailyWorkTrend: [],
  }));
  assert.match(html, /sessions used/);
  assert.match(html, /peak working/);
});

test('User-input tooltip uses one continuous adjusted-character line with Today and 7-day totals', () => {
  const dailyWorkTrend = [
    { date: '2026-06-26', sessionsUsed: 1, peakWorkingSessions: 1, productivity: { ...EMPTY_AGGREGATE_STATS.todayProductivity, adjustedUserInputChars: 900, userInputCharCap: 400 } },
    ...['2026-06-27', '2026-06-28', '2026-06-29', '2026-06-30', '2026-07-01', '2026-07-02', '2026-07-03'].map((date, index) => ({
      date,
      sessionsUsed: 1,
      peakWorkingSessions: 1,
      productivity: { ...EMPTY_AGGREGATE_STATS.todayProductivity, adjustedUserInputChars: (index + 1) * 100, knownUserInputCharSampleCount: 1, expectedUserInputCharSampleCount: 1, userInputCharCap: 400 },
    })),
  ];
  const stats = {
    ...EMPTY_AGGREGATE_STATS,
    ready: true,
    todayRunCount: 2,
    weekRunCount: 3,
    todayProductivity: {
      ...EMPTY_AGGREGATE_STATS.todayProductivity,
      adjustedUserInputChars: 1_400,
      knownUserInputCharSampleCount: 3,
      expectedUserInputCharSampleCount: 4,
      cappedUserInputCharSampleCount: 1,
      userInputCharCap: 400,
      filesystemPathRefCount: 3,
      imageInputCount: 2,
      imageInputBytes: 2048,
      askUserAnsweredCount: 3,
      askUserCancelledCount: 4,
      askUserTrackedRuns: 1,
      inputTokens: 5_432,
    },
    weekProductivity: {
      ...EMPTY_AGGREGATE_STATS.weekProductivity,
      adjustedUserInputChars: 3_200,
      knownUserInputCharSampleCount: 8,
      expectedUserInputCharSampleCount: 9,
      cappedUserInputCharSampleCount: 2,
      userInputCharCap: 400,
      askUserCancelledCount: 1,
    },
    dailyWorkTrend,
  };
  const html = renderToString(userInputTooltipNode(stats));

  assert.match(html, /<span>Today<\/span><span class="rich-tooltip-head-value">≥1\.4k chars<\/span>/);
  assert.match(html, /3\/4 known · P95 cap 400 chars · 1 capped outlier · ≥ value is a lower bound/);
  assert.match(html, /<span>7-day<\/span><span class="rich-tooltip-head-value">≥3\.2k chars<\/span>/);
  assert.match(html, /8\/9 known · P95 cap 400 chars · 2 capped outliers · ≥ value is a lower bound/);
  assert.match(html, /3 file refs · 2 images \(2 KB\) · 5 attachments total · 4 asks cancelled/);

  assert.match(html, /aria-label="7-day daily adjusted user-input character volume\. One continuous line; values use the shared rolling P95 cap\."/);
  assert.match(html, /<caption>line chart data/);
  assert.equal((html.match(/<path\b/g) ?? []).length, 1, 'one continuous adjusted-character line is rendered');
  assert.equal((html.match(/<circle\b/g) ?? []).length, 7, 'the rolling week retains seven exact daily points');
  assert.doesNotMatch(html, /<rect\b/, 'the user-input trend is not discretized into bars');
  assert.doesNotMatch(html, />900<\/td>/, 'the chart is scoped to the same seven-day window as its headline');

  assert.match(html, /Prompt and answered ask_user characters/);
  assert.match(html, /rolling 14-day P95 cap/);
  assert.doesNotMatch(html, /fewer than 5 samples/);
  assert.match(html, /≥ marks incomplete legacy or malformed-answer coverage/);
  assert.doesNotMatch(html, /prompt text|prompt tok|prompts<|answered ask_user<|input tokens/i,
    'count, raw-prompt, token-estimate, and provider-token prose are absent');
});

test('User-input tooltip keeps filesystem references and images distinct from image bytes', () => {
  const stats = {
    ...EMPTY_AGGREGATE_STATS,
    ready: true,
    runningSessionCount: 0,
    openTabCount: 1,
    todayRunCount: 1,
    weekRunCount: 1,
    todayProductivity: {
      ...EMPTY_AGGREGATE_STATS.todayProductivity,
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
      ...EMPTY_AGGREGATE_STATS.weekProductivity,
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
  const html = renderToString(userInputTooltipNode(stats));
  assert.match(html, /2 file refs/);
  assert.doesNotMatch(html, /attachments/, 'a single attachment kind never claims a combined total');
  assert.doesNotMatch(html, /image/);
});

test('User-input tooltip reports cancellations without reverting to answer counts', () => {
  const stats = {
    ...EMPTY_AGGREGATE_STATS,
    ready: true,
    todayRunCount: 1,
    weekRunCount: 1,
    todayProductivity: {
      ...EMPTY_AGGREGATE_STATS.todayProductivity,
      adjustedUserInputChars: 42,
      knownUserInputCharSampleCount: 2,
      expectedUserInputCharSampleCount: 2,
      userInputCharCap: 30,
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
  const html = renderToString(userInputTooltipNode(stats));
  assert.match(html, /1 ask cancelled/);
  assert.match(html, /≥ marks incomplete legacy or malformed-answer coverage/);
  assert.doesNotMatch(html, /answered ask_user<|2 answers|answer count|rich-tooltip-legend-val/i);
});

test('User-input tooltip uses lower-bound character coverage without legacy prompt averages', () => {
  const stats = {
    ...EMPTY_AGGREGATE_STATS,
    ready: true,
    runningSessionCount: 0,
    openTabCount: 1,
    todayRunCount: 1,
    weekRunCount: 1,
    todayProductivity: {
      ...EMPTY_AGGREGATE_STATS.todayProductivity,
      sendCount: 1,
      adjustedUserInputChars: 10,
      knownUserInputCharSampleCount: 1,
      expectedUserInputCharSampleCount: 2,
      userInputCharCap: 10,
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
      ...EMPTY_AGGREGATE_STATS.weekProductivity,
      sendCount: 1,
      adjustedUserInputChars: 10,
      knownUserInputCharSampleCount: 1,
      expectedUserInputCharSampleCount: 2,
      userInputCharCap: 10,
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
  const html = renderToString(userInputTooltipNode(stats));
  assert.match(html, /<span>Today<\/span><span class="rich-tooltip-head-value">≥10 chars<\/span>/);
  assert.match(html, /1\/2 known · P95 cap 10 chars · 0 capped outliers · ≥ value is a lower bound/);
  assert.doesNotMatch(html, /avg |prompt text|prompt tok/);
});
