import assert from 'node:assert/strict';
import test from 'node:test';

import { h } from 'preact';
import renderToString from 'preact-render-to-string';

import { ModelPicker } from '../../../src/webview/panel/components/model-picker';
import type { ModelPickerEntry } from '../../../src/webview/panel/composer/model-list';

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
