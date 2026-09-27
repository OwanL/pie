import test from 'node:test';
import assert from 'node:assert/strict';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { installDom } from '../helpers/dom';
installDom();

import { DEFAULT_CHAT_PREFS, EMPTY_PROVIDER_GATE_STATS } from '../../../lib/protocol/index.js';
import { validateWebviewToHostMessage } from '../../../lib/validation/protocol-validation';
import { initialArchState, reducer } from '../../../backend/conversation-state/reducer';
import { ProvidersSection } from '../../settings/settings-menu-providers';

test('provider max slider distinguishes a saved request from the live applied value and uses live queue wait', () => {
  const container = document.createElement('div');
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
    assert.match(container.textContent ?? '', /Configured\/requested: 5 · Saved preference/);
    assert.match(container.textContent ?? '', /Runtime\/applied: 3 · Environment override/);
  } finally {
    act(() => render(null, container));
  }
});

test('provider max slider reports unknown without inventing an effective default', () => {
  const container = document.createElement('div');
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
    assert.match(container.textContent ?? '', /Configured\/requested: unavailable/);
    assert.match(container.textContent ?? '', /Runtime\/applied: unavailable/);
    assert.doesNotMatch(container.textContent ?? '', /Configured default/);
    assert.doesNotMatch(container.textContent ?? '', /2 active/);
  } finally {
    act(() => render(null, container));
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
