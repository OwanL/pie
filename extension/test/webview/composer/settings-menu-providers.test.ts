import test from 'node:test';
import assert from 'node:assert/strict';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { installDom } from '../../_helpers/dom';
installDom();

import { EMPTY_PROVIDER_GATE_STATS } from '../../../src/shared/protocol';
import { validateWebviewToHostMessage } from '../../../src/shared/protocol-validation';
import { initialArchState, reducer } from '../../../src/host/core/reducer';
import { ProvidersSection } from '../../../src/webview/panel/composer/settings-menu-providers';

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
    assert.equal(updates, 4);
    assert.deepEqual(state.settings.prefs.providerConcurrency, {
      openai: { maxConcurrentRequests: 4, afterburnSeconds: 15, queueWaitSeconds: 45, headerWaitSeconds: 120 },
      anthropic: { maxConcurrentRequests: 3 },
    });
  } finally {
    act(() => render(null, container));
  }
});
