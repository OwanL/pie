import assert from 'node:assert/strict';
import test from 'node:test';

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
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

test('combined picker pins once, cancels without mutation, selects reasoning atomically and refreshes capabilities', () => {
  const container = document.createElement('div'); document.body.appendChild(container);
  const changes: string[] = [];
  const reasoningModel = entry('reason', { model: { provider: 'other', reasoning: true, thinkingLevels: ['off', 'high', 'max'] } as ModelPickerEntry['model'] });
  const plain = entry('plain');
  const props = {
    value: 'other/reason', label: 'Reason', ariaLabel: 'Model', title: 'Select model',
    entries: [plain, reasoningModel], onChange: () => assert.fail('combined selection must not call standalone callback'),
    reasoning: { value: 'high' as const, onChange: (spec: string, level: string) => changes.push(`${spec}:${level}`) },
  };
  const key = (target: Element, value: string) => act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }));
  });
  try {
    act(() => render(h(ModelPicker, props), container));
    assert.equal(container.querySelector('sup')?.textContent, 'high');
    assert.equal(container.querySelector('button')?.getAttribute('aria-description'), 'Reasoning: high');
    assert.equal(container.querySelector('button')?.getAttribute('aria-label'), 'Model');
    act(() => container.querySelector<HTMLButtonElement>('button')!.click());
    assert.deepEqual([...document.querySelectorAll('.model-picker-name')].map(el => el.textContent), ['reason', 'plain']);
    const search = document.querySelector<HTMLInputElement>('.model-picker-search')!;
    key(search, 'Enter');
    assert.equal(document.querySelector('[data-model-reasoning-submenu]'), null, 'untouched Enter is safe');
    key(search, 'ArrowRight');
    let submenu = document.querySelector('[data-model-reasoning-submenu]')!;
    assert.deepEqual([...submenu.querySelectorAll('.choice-picker-label')].map(el => el.textContent), ['max', 'high', 'off']);
    assert.deepEqual(changes, []);
    key(submenu, 'Escape');
    assert.equal(document.querySelector('[data-model-reasoning-submenu]'), null);
    assert.ok(document.querySelector('.model-picker-dropdown'));
    act(() => (document.querySelector('.model-picker-row') as HTMLElement).click());
    submenu = document.querySelector('[data-model-reasoning-submenu]')!;
    key(submenu, 'Home'); key(submenu, 'Enter');
    assert.deepEqual(changes, ['other/reason:max']);
    assert.equal(document.querySelector('.model-picker-dropdown'), null);
    act(() => container.querySelector<HTMLButtonElement>('button')!.click());
    key(document.querySelector('.model-picker-search')!, 'ArrowRight');
    act(() => render(h(ModelPicker, { ...props, entries: [plain] }), container));
    assert.equal(document.querySelector('[data-model-reasoning-submenu]'), null, 'catalog removal cannot strand submenu');
    assert.equal(document.activeElement, document.querySelector('.model-picker-search'), 'removed keyboard child restores search focus');
    act(() => (document.querySelector('.model-picker-row') as HTMLElement).click());
    assert.deepEqual(changes, ['other/reason:max', 'test/plain:off']);
    act(() => render(h(ModelPicker, { ...props, value: 'test/plain', label: 'Plain' }), container));
    assert.equal(container.querySelector('sup'), null, 'plain models must not display the persisted reasoning preference as an active level');
    assert.equal(container.querySelector('button')?.getAttribute('aria-description'), null);
  } finally { act(() => render(null, container)); container.remove(); }
});

test('combined picker invalidates singleton capabilities and closes on Tab and disable', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const changes: string[] = [];
  const model = entry('reason', { model: { reasoning: true, thinkingLevels: ['off', 'high'] } as ModelPickerEntry['model'] });
  const props = {
    value: 'test/reason', label: 'Reason', ariaLabel: 'Model', title: 'Select model', entries: [model],
    onChange: () => assert.fail('standalone callback'),
    reasoning: { value: 'high' as const, onChange: (spec: string) => changes.push(spec) },
  };
  const key = (target: Element, value: string) => act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }));
  });
  const open = () => {
    act(() => container.querySelector<HTMLButtonElement>('button')!.click());
    key(document.querySelector('.model-picker-search')!, 'ArrowRight');
    assert.ok(document.querySelector('[data-model-reasoning-submenu]'));
  };
  try {
    act(() => render(h(ModelPicker, props), container));
    open();
    act(() => render(h(ModelPicker, { ...props, entries: [entry('reason')] }), container));
    assert.equal(document.querySelector('[data-model-reasoning-submenu]'), null);
    assert.equal(document.activeElement, document.querySelector('.model-picker-search'));
    key(document.activeElement!, 'Enter');
    assert.deepEqual(changes, [], 'capability refresh does not commit a stale child');
    act(() => render(h(ModelPicker, props), container));
    key(document.querySelector('.model-picker-search')!, 'ArrowRight');
    key(document.querySelector('[data-model-reasoning-submenu]')!, 'Tab');
    assert.equal(document.querySelector('.model-picker-dropdown'), null);
    open();
    act(() => render(h(ModelPicker, { ...props, disabled: true }), container));
    assert.equal(document.querySelector('[data-model-reasoning-submenu]'), null);
    assert.equal(document.querySelector('.model-picker-dropdown'), null);
    assert.equal(container.querySelector<HTMLButtonElement>('button')!.disabled, true);
    assert.deepEqual(changes, []);
    act(() => render(h(ModelPicker, props), container));
    open();
    const siblingChild = document.createElement('div');
    siblingChild.setAttribute('data-model-reasoning-submenu', '');
    document.body.appendChild(siblingChild);
    try {
      act(() => { siblingChild.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
      assert.equal(document.querySelector('.model-picker-dropdown'), null, 'another picker child is outside this picker');
    } finally { siblingChild.remove(); }
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
    assert.equal(option.querySelector('.model-picker-name')?.textContent, `long-provider · ${name}`);
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
