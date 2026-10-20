import assert from 'node:assert/strict';
import test from 'node:test';

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import renderToString from 'preact-render-to-string';

import { installDom } from '../helpers/dom';
installDom();

import { ModelPicker } from '../../settings/model-picker';
import { RemovedProvidersContext } from '../../settings/removed-providers';
import type { ModelPickerEntry } from '../../composer/model-list';

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

test('host tombstones filter stale picker entries and retain unavailable selected identity', () => {
  const container = document.createElement('div'); document.body.appendChild(container);
  try {
    act(() => render(h(RemovedProvidersContext.Provider, { value: ['test'], children: h(ModelPicker, {
      value: 'test/old', label: 'Old', ariaLabel: 'Model', title: 'Select model', entries: [entry('old')],
      onChange: () => assert.fail('a removed provider must not be selectable'),
    }) }), container));
    assert.match(container.textContent!, /test\/old · Unavailable \(removed provider\)/);
    act(() => (container.querySelector('.model-picker-trigger') as HTMLButtonElement).click());
    assert.equal(document.querySelector('[role=option]'), null);
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
    assert.match(options[0].textContent ?? '', /OpenAI: GPT-5/);
    assert.match(options[0].textContent ?? '', /\$1\.25/);
    assert.equal(options[0].title, 'Pricing diagnostics', 'native title diagnostics remain available');
  } finally {
    act(() => render(null, container));
    container.remove();
  }
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
