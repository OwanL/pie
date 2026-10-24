import test from 'node:test';
import assert from 'node:assert/strict';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { installDom } from '../helpers/dom';
installDom();

import { DEFAULT_CHAT_PREFS, EMPTY_PROVIDER_GATE_STATS } from '../../../lib/protocol/index.js';
import type { ProviderGateStats } from '../../../lib/protocol/index.js';
import { validateWebviewToHostMessage } from '../../../lib/validation/protocol-validation';
import { withRenderCount } from '../helpers/render-counter';
import { initialArchState, reducer } from '../../../backend/conversation-state/reducer';
import { ProvidersSection } from '../../settings/settings-menu-providers';

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function pausedOpenaiMetrics(pausedUntilMs: number, strikeCount = 2): ProviderGateStats {
  return {
    enabled: true,
    providers: [{
      provider: 'openai', activeRequests: 0, queuedRequests: 0,
      maxConcurrentRequests: 3, maxConcurrentRequestsSource: 'environment-override',
      afterburnSeconds: 0, queueWaitSeconds: 30, paused: true, pausedUntilMs, strikeCount,
    }],
  };
}

async function maxConcurrencyHelp(container: HTMLElement): Promise<string> {
  const help = container.querySelector<HTMLButtonElement>('[aria-label="About Max concurrent"]');
  assert.ok(help);
  await act(async () => {
    help.focus();
    await new Promise((resolve) => setTimeout(resolve, 180));
  });
  const id = help.getAttribute('aria-describedby');
  assert.ok(id);
  return document.getElementById(id)?.textContent ?? '';
}

test('provider max slider distinguishes a saved request from the live applied value and uses live queue wait', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const prefs = {
    ...DEFAULT_CHAT_PREFS,
    providerConcurrency: { openai: { maxConcurrentRequests: 5 } },
  };
  act(() => render(h(ProvidersSection, {
    providers: ['openai'],
    prefs,
    providerGateStats: {
      enabled: true,
      providers: [{
        provider: 'openai', activeRequests: 3, queuedRequests: 1,
        maxConcurrentRequests: 3, maxConcurrentRequestsSource: 'environment-override',
        afterburnSeconds: 0, queueWaitSeconds: 45, paused: false, pausedUntilMs: 0, strikeCount: 0,
      }],
    },
    onSetPrefs: () => undefined,
  }), container));

  try {
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Expand openai concurrency settings"]')!.click());
    const max = container.querySelector<HTMLInputElement>('[aria-label="Max concurrent requests for openai"]');
    const queue = container.querySelector<HTMLInputElement>('[aria-label="Queue wait timeout for openai"]');
    assert.equal(max?.value, '5', 'saved preference is the requested slider value');
    assert.equal(max?.getAttribute('aria-valuetext'), '5');
    assert.equal(queue?.value, '45', 'live queue wait is used when no preference override exists');
    assert.match(container.textContent ?? '', /Applied: 3/);
    assert.doesNotMatch(container.textContent ?? '', /Configured\/requested/);
    const help = await maxConcurrencyHelp(container);
    assert.match(help, /Configured\/requested: 5 · Saved preference/);
    assert.match(help, /Runtime\/applied: 3 · Environment override/);
    assert.equal(max?.value, '5', 'opening help does not change the requested value');
  } finally {
    act(() => render(null, container));
    container.remove();
  }
});

test('provider max slider reports unknown without inventing an effective default', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => render(h(ProvidersSection, {
    providers: ['openai'],
    prefs: { ...DEFAULT_CHAT_PREFS, providerConcurrency: { openai: {} } },
    providerGateStats: EMPTY_PROVIDER_GATE_STATS,
    onSetPrefs: () => undefined,
  }), container));

  try {
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Expand openai concurrency settings"]')!.click());
    const max = container.querySelector<HTMLInputElement>('[aria-label="Max concurrent requests for openai"]');
    assert.equal(max?.disabled, true, 'unknown max is not editable until runtime data or an override exists');
    assert.equal(max?.getAttribute('aria-valuetext'), 'Unavailable');
    assert.match(container.textContent ?? '', /Unavailable/);
    const help = await maxConcurrencyHelp(container);
    assert.match(help, /Configured\/requested: unavailable/);
    assert.match(help, /Runtime\/applied: unavailable/);
    assert.doesNotMatch(help, /Configured default/);
    assert.doesNotMatch(container.textContent ?? '', /2 active/);
  } finally {
    act(() => render(null, container));
    container.remove();
  }
});

test('provider Unlimited applies only to the provider gate, not the subagent tree cap', () => {
  const container = document.createElement('div');
  act(() => render(h(ProvidersSection, {
    providers: ['openai'],
    prefs: { ...DEFAULT_CHAT_PREFS, providerConcurrency: { openai: { maxConcurrentRequests: 0 } } },
    providerGateStats: EMPTY_PROVIDER_GATE_STATS,
    onSetPrefs: () => undefined,
  }), container));

  try {
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Expand openai concurrency settings"]')!.click());
    const max = container.querySelector<HTMLInputElement>('[aria-label="Max concurrent requests for openai"]');
    assert.equal(max?.getAttribute('aria-valuetext'), 'Unlimited');
    assert.match(max?.title ?? '', /does not bypass the separate subagent tree limit/);
  } finally {
    act(() => render(null, container));
  }
});

test('provider expand controls reference stable, unique mounted sections only', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => render(h(ProvidersSection, {
    providers: ['openai', 'anthropic'],
    prefs: {
      ...DEFAULT_CHAT_PREFS,
      providerConcurrency: { openai: {}, anthropic: {} },
    },
    providerGateStats: EMPTY_PROVIDER_GATE_STATS,
    onSetPrefs: () => undefined,
  }), container));

  try {
    const openai = container.querySelector<HTMLButtonElement>('[aria-label="Expand openai concurrency settings"]');
    const anthropic = container.querySelector<HTMLButtonElement>('[aria-label="Expand anthropic concurrency settings"]');
    assert.ok(openai && anthropic);
    assert.equal(openai.hasAttribute('aria-controls'), false);
    assert.equal(anthropic.hasAttribute('aria-controls'), false);

    act(() => openai.click());
    const openaiId = openai.getAttribute('aria-controls');
    assert.ok(openaiId);
    assert.ok(document.getElementById(openaiId));
    assert.equal(openai.getAttribute('aria-expanded'), 'true');
    assert.equal(anthropic.hasAttribute('aria-controls'), false);

    act(() => openai.click());
    assert.equal(openai.hasAttribute('aria-controls'), false);
    assert.ok(document.getElementById(openaiId) === null);
    act(() => openai.click());
    assert.equal(openai.getAttribute('aria-controls'), openaiId, 'reopening preserves the controls id');
    act(() => anthropic.click());
    const anthropicId = anthropic.getAttribute('aria-controls');
    assert.ok(anthropicId);
    assert.notEqual(anthropicId, openaiId);
    assert.ok(document.getElementById(anthropicId));
  } finally {
    act(() => render(null, container));
    container.remove();
  }
});

test('provider sliders survive validated host preference round trips without resetting other overrides', () => {
  const container = document.createElement('div');
  let state = {
    ...initialArchState,
    settings: {
      ...initialArchState.settings,
      prefs: {
        ...initialArchState.settings.prefs,
        providerConcurrency: {
          openai: { maxConcurrentRequests: 2, afterburnSeconds: 5 },
          anthropic: { maxConcurrentRequests: 3 },
        },
      },
    },
  } as typeof initialArchState;
  let updates = 0;
  const paint = () => render(h(ProvidersSection, {
    providers: ['openai', 'anthropic'],
    prefs: state.settings.prefs,
    providerGateStats: EMPTY_PROVIDER_GATE_STATS,
    onSetPrefs: (prefs) => {
      // Match renderer ingress: only validated commands reach the host store.
      const result = validateWebviewToHostMessage({ type: 'setPrefs', prefs });
      assert.equal(result.ok, true, 'slider updates must pass host ingress validation');
      if (!result.ok || result.value.type !== 'setPrefs') return;
      const reduced = reducer(state, {
        kind: 'Command',
        cmd: { kind: 'SetPrefs', corrId: `slider-${++updates}`, prefs: result.value.prefs },
      });
      assert.ok(reduced.effects.some((effect) => effect.kind === 'SetPrefsRpc'));
      state = reduced.state;
    },
  }), container);

  try {
    act(paint);
    const expand = container.querySelector<HTMLButtonElement>('[aria-label="Expand openai concurrency settings"]');
    assert.ok(expand);
    act(() => expand.click());

    const changes = [
      ['Max concurrent requests for openai', 'maxConcurrentRequests', 4],
      ['Afterburn sticky-slot window for openai', 'afterburnSeconds', 15],
      ['Queue wait timeout for openai', 'queueWaitSeconds', 45],
      ['Header wait timeout for openai', 'headerWaitSeconds', 120],
    ] as const;
    for (const [label, field, value] of changes) {
      const slider = container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
      assert.ok(slider);
      act(() => {
        slider.value = String(value);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
      });
      act(paint);
      assert.equal(slider.value, String(value), `${field} must not snap back on the host refresh`);
      assert.equal(state.settings.prefs.providerConcurrency.openai[field], value);
    }

    const maxSlider = container.querySelector<HTMLInputElement>('[aria-label="Max concurrent requests for openai"]');
    assert.ok(maxSlider);
    assert.equal(maxSlider.max, '129', 'the rightmost slider position is Unlimited after finite 1–128 values');
    for (const label of [
      'Max concurrent requests for openai',
      'Afterburn sticky-slot window for openai',
      'Queue wait timeout for openai',
      'Header wait timeout for openai',
    ]) {
      const slider = container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
      assert.ok(slider?.title, `${label} must expose an explanatory tooltip`);
    }
    act(() => {
      maxSlider.value = maxSlider.max;
      maxSlider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(paint);
    assert.equal(state.settings.prefs.providerConcurrency.openai.maxConcurrentRequests, 0);
    const unlimitedSlider = container.querySelector<HTMLInputElement>('[aria-label="Max concurrent requests for openai"]');
    assert.equal(unlimitedSlider?.value, '129');
    assert.equal(unlimitedSlider?.getAttribute('aria-valuetext'), 'Unlimited');
    assert.equal(updates, 5);
    assert.deepEqual(state.settings.prefs.providerConcurrency, {
      openai: { maxConcurrentRequests: 0, afterburnSeconds: 15, queueWaitSeconds: 45, headerWaitSeconds: 120 },
      anthropic: { maxConcurrentRequests: 3 },
    });
  } finally {
    act(() => render(null, container));
  }
});

function renderPausedProvidersSection(
  container: HTMLElement,
  providerGateStats: ProviderGateStats,
): void {
  act(() => render(h(ProvidersSection, {
    providers: ['openai'],
    prefs: { ...DEFAULT_CHAT_PREFS, providerConcurrency: { openai: { maxConcurrentRequests: 2 } } },
    providerGateStats,
    onSetPrefs: () => undefined,
  }), container));
}

function expandOpenai(container: HTMLElement): void {
  act(() => container
    .querySelector<HTMLButtonElement>('[aria-label="Expand openai concurrency settings"]')!
    .click());
}

test('paused countdown recalculates immediately when the deadline changes', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const originalNow = Date.now;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let now = 1_000_000;
  let nextId = 0;
  const callbacks = new Map<number, () => void>();
  const cleared: number[] = [];
  Date.now = () => now;
  globalThis.setInterval = ((handler: () => void) => {
    const id = ++nextId;
    callbacks.set(id, handler);
    return id;
  }) as typeof setInterval;
  globalThis.clearInterval = ((id: unknown) => {
    const intervalId = id as number;
    callbacks.delete(intervalId);
    cleared.push(intervalId);
  }) as typeof clearInterval;

  try {
    const paint = (deadline: number) => renderPausedProvidersSection(container, pausedOpenaiMetrics(deadline));
    act(() => paint(now + 5_000));
    expandOpenai(container);
    assert.match(container.textContent ?? '', /5s remaining/);
    assert.equal(callbacks.size, 1);

    act(() => paint(now + 12_000));
    assert.match(container.textContent ?? '', /12s remaining/, 'an extended deadline updates without waiting for a tick');
    assert.equal(callbacks.size, 1, 'the previous timer is replaced');
    const extendedTimer = [...callbacks.keys()][0]!;
    assert.ok(cleared.includes(1));

    now += 3_000;
    act(() => paint(now + 2_000));
    assert.match(container.textContent ?? '', /2s remaining/, 'a shortened deadline updates immediately');
    const shortenedTimer = [...callbacks.keys()][0]!;
    assert.notEqual(shortenedTimer, extendedTimer);

    now += 3_000;
    act(() => callbacks.get(shortenedTimer)?.());
    assert.match(container.textContent ?? '', /0s remaining/);
    assert.doesNotMatch(container.textContent ?? '', /-\d+s remaining/);

    act(() => render(null, container));
    assert.equal(callbacks.size, 0, 'unmount clears the active timer');
    assert.ok(cleared.includes(shortenedTimer));
  } finally {
    Date.now = originalNow;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    act(() => render(null, container));
    container.remove();
  }
});

test('paused provider countdown ticks down per second from a component-local interval', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const counts = new Map<string, number>();
  const Counted = withRenderCount(ProvidersSection, counts, () => 'section');
  const sectionProps = {
    providers: ['openai'],
    prefs: { ...DEFAULT_CHAT_PREFS, providerConcurrency: { openai: { maxConcurrentRequests: 2 } } },
    providerGateStats: pausedOpenaiMetrics(Date.now() + 5_000),
    onSetPrefs: () => undefined,
  };
  act(() => render(h(Counted, sectionProps), container));

  try {
    expandOpenai(container);
    assert.equal(counts.get('section'), 1);
    assert.match(container.textContent ?? '', /⏸ Paused — 5s remaining \(strike 2\)/);

    await act(async () => {
      await sleep(1_100);
    });
    assert.match(container.textContent ?? '', /Paused — 4s remaining/);
    assert.equal(counts.get('section'), 1, 'per-second ticks must not re-render the section');
  } finally {
    act(() => render(null, container));
    container.remove();
  }
});

test('stale pause deadlines clamp at zero instead of counting negative', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  renderPausedProvidersSection(container, pausedOpenaiMetrics(Date.now() - 30_000));

  try {
    expandOpenai(container);
    assert.match(container.textContent ?? '', /⏸ Paused — 0s remaining \(strike 2\)/);
    await act(async () => {
      await sleep(1_100);
    });
    assert.match(container.textContent ?? '', /Paused — 0s remaining/, 'clamped remaining stays at zero');
    assert.doesNotMatch(container.textContent ?? '', /-\d+s remaining/);
  } finally {
    act(() => render(null, container));
    container.remove();
  }
});

test('the paused countdown interval is cleared on unmount and on resume', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const createdIntervals: unknown[] = [];
  const clearedIntervals: unknown[] = [];
  globalThis.setInterval = ((handler: () => void, ms?: number) => {
    const id = originalSetInterval(handler, ms);
    createdIntervals.push(id);
    return id;
  }) as typeof setInterval;
  globalThis.clearInterval = ((id: unknown) => {
    clearedIntervals.push(id);
    return originalClearInterval(id as Parameters<typeof originalClearInterval>[0]);
  }) as typeof clearInterval;

  try {
    renderPausedProvidersSection(container, pausedOpenaiMetrics(Date.now() + 9_000));
    expandOpenai(container);
    assert.equal(createdIntervals.length, 1, 'one component-local interval while paused');
    assert.deepEqual(clearedIntervals, []);

    act(() => render(null, container));
    assert.deepEqual(clearedIntervals, createdIntervals, 'unmount clears the interval');

    // Resume: the paused row unmounts when the host stops reporting a pause.
    renderPausedProvidersSection(container, {
      enabled: true,
      providers: [{
        provider: 'openai', activeRequests: 1, queuedRequests: 0,
        maxConcurrentRequests: 3, maxConcurrentRequestsSource: 'environment-override',
        afterburnSeconds: 0, queueWaitSeconds: 30, paused: false, pausedUntilMs: 0, strikeCount: 2,
      }],
    });
    expandOpenai(container);
    assert.match(container.textContent ?? '', /Live: 1 active \/ 0 queued/);
    assert.deepEqual(clearedIntervals, createdIntervals, 'no new interval after resume');
    await act(async () => {
      await sleep(1_100);
    });
    assert.match(container.textContent ?? '', /Live: 1 active \/ 0 queued/,
      'no stale countdown writes after resume');
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    act(() => render(null, container));
    container.remove();
  }
});
