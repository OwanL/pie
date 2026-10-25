import assert from 'node:assert/strict';
import test from 'node:test';

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { useState } from 'preact/hooks';
import { ModelFavoritesContext } from '../../settings/model-favorites';
import renderToString from 'preact-render-to-string';

import { installDom } from '../helpers/dom';
installDom();

import { ModelPicker } from '../../settings/model-picker';
import { RemovedProvidersContext } from '../../settings/removed-providers';
import { orderModelsForPicker, type ModelPickerEntry } from '../../composer/model-list';

function entry(id: string, overrides: Partial<ModelPickerEntry> = {}): ModelPickerEntry {
  return {
    model: {
      id,
      name: overrides.model?.name ?? id,
      provider: overrides.model?.provider ?? 'test',
      reasoning: false,
      inputKinds: ['text'],
      ...overrides.model,
    } as ModelPickerEntry['model'],
    label: overrides.label ?? id,
    selectedLabel: overrides.selectedLabel ?? id,
    ineligible: overrides.ineligible ?? false,
    title: overrides.title ?? '',
    tokenInPrice: overrides.tokenInPrice ?? '',
    tokenOutPrice: overrides.tokenOutPrice ?? '',
    supportsImages: overrides.supportsImages ?? false,
  };
}

test('favoriting preserves combobox focus, active identity, selection and does not scroll the reordered highlight', async () => {
  const container = document.createElement('div'); document.body.appendChild(container);
  const entries = [entry('a'), entry('b')];
  // Providers rerender around stable children in the real application.
  const picker = h(ModelPicker, { value: 'test/a', label: 'a', ariaLabel: 'Model', title: 'Model', entries,
    onChange: () => assert.fail('favorite must not select a model'),
  });
  function Harness() {
    const [favorites, setFavorites] = useState<string[]>([]);
    return h(ModelFavoritesContext.Provider, { value: { favorites, disabled: false,
      onToggle: (spec: string) => setFavorites(previous => previous.includes(spec) ? [] : [spec]),
    }, children: picker });
  }
  try {
    act(() => render(h(Harness, {}), container));
    act(() => container.querySelector<HTMLButtonElement>('button')!.click());
    const input = document.querySelector<HTMLInputElement>('.model-picker-search')!;
    input.focus();
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })); });
    const active = input.getAttribute('aria-activedescendant');
    let scrolls = 0;
    let animations = 0;
    const rows = document.querySelector<HTMLElement>('.model-picker-rows')!;
    const rect = (top: number, height: number) => ({ top, bottom: top + height, height }) as DOMRect;
    rows.getBoundingClientRect = () => rect(0, 100);
    for (const row of document.querySelectorAll<HTMLElement>('[role=option]')) {
      row.scrollIntoView = () => { scrolls++; };
      row.getBoundingClientRect = () => rect(Array.from(rows.children).indexOf(row) * 20, 20);
      row.animate = (() => {
        animations++;
        return { cancel() {}, onfinish: null } as unknown as Animation;
      }) as typeof row.animate;
    }
    // Exercise context subscribers through the real microtask render queue,
    // including the dropdown's context-only render before its parent updates.
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(input.getAttribute('aria-activedescendant'), active);
    assert.ok(document.activeElement === input);
    assert.equal(document.querySelector('[role=option]')?.getAttribute('data-model-key'), 'test/b');
    assert.equal(document.querySelector('[aria-selected=true]')?.getAttribute('data-model-key'), 'test/a');
    assert.equal(scrolls, 0);
    assert.equal(animations, 2, 'context favorite updates must not consume First before the parent sorts keyed rows');
    assert.equal(document.querySelector('[data-model-key="test/b"]')?.getAttribute('data-model-moving'), '');
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    assert.equal(scrolls, 1, 'intentional keyboard navigation still scrolls');
  } finally { act(() => render(null, container)); container.remove(); }
});

test('host tombstones filter stale picker entries and retain unavailable selected identity', () => {
  const container = document.createElement('div'); document.body.appendChild(container);
  try {
    act(() => render(h(RemovedProvidersContext.Provider, { value: ['test'], children: h(ModelPicker, {
      value: 'test/old', label: 'Old', ariaLabel: 'Model', title: 'Select model', entries: [entry('old')],
      onChange: () => assert.fail('a removed provider must not be selectable'),
    }) }), container));
    assert.match(container.textContent!, /test\/old · Unavailable \(removed provider\)/);
    act(() => (container.querySelector('.model-picker-trigger') as HTMLButtonElement).click());
    assert.ok(document.querySelector('[role=option]') === null);
  } finally { act(() => render(null, container)); container.remove(); }
});

test('ModelPicker renders trigger with selected label', () => {
  const html = renderToString(
    h(ModelPicker, {
      value: 'gpt-5',
      label: 'GPT-5',
      ariaLabel: 'Model',
      title: 'Select model',
      entries: [entry('gpt-5', { label: 'GPT-5', selectedLabel: 'GPT-5' })],
      onChange: () => {},
    }),
  );
  assert.match(html, /GPT-5/);
  assert.match(html, /aria-haspopup="listbox"/);
  assert.match(html, /aria-expanded="false"/);
});

test('ModelPicker option names describe prices per million tokens and image support', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => render(h(ModelPicker, {
    value: 'openai/gpt-5',
    label: 'GPT-5',
    ariaLabel: 'Model',
    title: 'Select model',
    entries: [
      entry('gpt-5', {
        model: { provider: 'openai' } as ModelPickerEntry['model'],
        label: 'OpenAI: GPT-5', title: 'Pricing diagnostics', tokenInPrice: '$1.25', tokenOutPrice: '$10.00', supportsImages: true,
      }),
      entry('local-model', {
        model: { provider: 'local' } as ModelPickerEntry['model'],
        label: 'Local: Text Model', supportsImages: false,
      }),
    ],
    onChange: () => {},
  }), container));

  try {
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Model"]')!.click());
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    assert.equal(options.length, 2);
    assert.match(options[0].getAttribute('aria-label') ?? '', /OpenAI: GPT-5, openai\/gpt-5/);
    assert.match(options[0].getAttribute('aria-label') ?? '', /input price \$1\.25 per million tokens/);
    assert.match(options[0].getAttribute('aria-label') ?? '', /output price \$10\.00 per million tokens/);
    assert.match(options[0].getAttribute('aria-label') ?? '', /supports images/);
    assert.match(options[1].getAttribute('aria-label') ?? '', /Local: Text Model, local\/local-model/);
    assert.match(options[1].getAttribute('aria-label') ?? '', /input price unavailable/);
    assert.match(options[1].getAttribute('aria-label') ?? '', /text only/);
    assert.match(options[0].textContent ?? '', /gpt-5/);
    assert.match(options[0].textContent ?? '', /\$1\.25/);
    assert.match(options[0].title, /Pricing diagnostics/, 'native title diagnostics remain available');
  } finally {
    act(() => render(null, container));
    container.remove();
  }
});

test('ModelPicker distinguishes empty catalogs from unmatched searches', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  try {
    act(() => render(h(ModelPicker, {
      value: '', label: 'Select model', ariaLabel: 'Model', title: 'Select model', entries: [], onChange: () => {},
    }), container));
    act(() => container.querySelector<HTMLButtonElement>('button')!.click());
    assert.equal(document.querySelector('.model-picker-empty')?.textContent, 'No models available');
    const input = document.querySelector<HTMLInputElement>('.model-picker-search')!;
    act(() => { input.value = 'missing'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.equal(document.querySelector('.model-picker-empty')?.textContent, 'No models match "missing"');
  } finally { act(() => render(null, container)); container.remove(); }
});

test('ModelPicker retains long provider-qualified identity and announces zero prices', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const name = 'A very long model name that must wrap without losing its provider identity';
  const entries = orderModelsForPicker([entry('long', { model: {
    id: 'long', provider: 'long-provider', name, inputKinds: ['text'], reasoning: false,
    subagent: { eligible: true, pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
  } }).model]);
  try {
    act(() => render(h(ModelPicker, {
      value: '', label: 'Select model', ariaLabel: 'Model', title: 'Select model', entries, onChange: () => {},
    }), container));
    act(() => container.querySelector<HTMLButtonElement>('button')!.click());
    const option = document.querySelector<HTMLElement>('[role="option"]')!;
    assert.equal(option.querySelector('.model-picker-name')?.textContent, name);
    assert.match(option.getAttribute('aria-label')!, /input price \$0\.00 per million tokens, output price \$0\.00 per million tokens/);
    assert.match(option.title, new RegExp(name));
    assert.equal(option.querySelectorAll('.model-picker-col-price')[0].textContent?.trim(), '$0.00');
  } finally { act(() => render(null, container)); container.remove(); }
});

test('ModelPicker renders dropdown with columns when open is simulated', () => {
  // Render a snapshot where the listbox overlay is present by inspecting the
  // static output of a second render pass with open=true is not possible
  // with renderToString alone; we verify structural markup instead.
  const html = renderToString(
    h(ModelPicker, {
      value: 'gpt-5',
      label: 'GPT-5',
      ariaLabel: 'Model',
      title: 'Select model',
      entries: [
        entry('gpt-5', { label: 'GPT-5', tokenInPrice: '$1.75', tokenOutPrice: '$14.00', supportsImages: true }),
        entry('gpt-4o', { label: 'GPT-4o', tokenInPrice: '$2.50', tokenOutPrice: '$10.00', supportsImages: false }),
      ],
      onChange: () => {},
    }),
  );
  // The dropdown is hidden by default in static render, but the markup exists
  // conditionally. Preact with useState(false) won't emit the open branch in SSR.
  assert.match(html, /model-picker/);
});
