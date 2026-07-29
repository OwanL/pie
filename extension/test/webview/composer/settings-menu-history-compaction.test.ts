import assert from 'node:assert/strict';
import test from 'node:test';

import { h } from 'preact';
import renderToString from 'preact-render-to-string';

import { DEFAULT_HISTORY_COMPACTION_SETTINGS } from '../../../src/shared/protocol';
import type { ModelInfo } from '../../../src/shared/protocol';
import {
  convertMode,
  HistoryCompactionSection,
} from '../../../src/webview/panel/composer/settings-menu-history-compaction';

const availableModels: ModelInfo[] = [
  { id: 'm1', name: 'Model One', provider: 'test', reasoning: false, inputKinds: ['text'] },
  { id: 'm2', name: 'Model Two', provider: 'test', reasoning: false, inputKinds: ['text'] },
];

const activeModel = { provider: 'test', id: 'm1' };

function makeProps(overrides: Partial<Parameters<typeof HistoryCompactionSection>[0]> = {}) {
  return {
    settings: DEFAULT_HISTORY_COMPACTION_SETTINGS,
    contextWindow: 200_000,
    availableModels,
    activeModel,
    onSetPrefs: () => undefined,
    ...overrides,
  };
}

test('HistoryCompactionSection renders soft and hard trigger controls with model token equivalents', () => {
  const html = renderToString(h(HistoryCompactionSection, makeProps()));

  assert.match(html, /History compaction/);
  assert.match(html, /Proactive automatic compaction/);
  assert.match(html, /Soft trigger/);
  assert.match(html, /Hard trigger/);
  assert.match(html, /about 140k tokens/);
  assert.match(html, /about 170k tokens/);
  assert.match(html, /Never interrupts reasoning or a running tool/);
});

test('HistoryCompactionSection renders summary and retention controls', () => {
  const html = renderToString(h(HistoryCompactionSection, makeProps()));

  assert.match(html, /Recent retention/);
  assert.match(html, /Summary instructions/);
  assert.match(html, /Summary thinking level/);
  assert.match(html, /Summary model/);
  assert.match(html, /Active model/);
  assert.match(html, /aria-haspopup="listbox"/);
});

test('HistoryCompactionSection shows active-model profile controls in token mode', () => {
  const settings = convertMode(DEFAULT_HISTORY_COMPACTION_SETTINGS, 'tokens', 200_000);
  const html = renderToString(h(HistoryCompactionSection, makeProps({ settings })));

  assert.match(html, /Custom thresholds for active model/);
});

test('HistoryCompactionSection hides active-model profile controls in percentage mode', () => {
  const html = renderToString(h(HistoryCompactionSection, makeProps()));
  assert.doesNotMatch(html, /Custom thresholds for active model/);
});

test('HistoryCompactionSection disables profile controls when no active model is provided', () => {
  const settings = convertMode(DEFAULT_HISTORY_COMPACTION_SETTINGS, 'tokens', 200_000);
  const html = renderToString(h(HistoryCompactionSection, makeProps({ settings, activeModel: undefined })));
  assert.doesNotMatch(html, /Custom thresholds for active model/);
});

test('convertMode translates percentages to absolute token limits for the active model', () => {
  assert.deepEqual(
    convertMode(DEFAULT_HISTORY_COMPACTION_SETTINGS, 'tokens', 200_000),
    {
      enabled: true,
      thresholdMode: 'tokens',
      softThreshold: 140_000,
      hardThreshold: 170_000,
      keepRecentTokens: 30_000,
      summaryInstructions: '',
      summaryThinkingLevel: 'inherit',
      summaryModel: null,
      modelProfiles: {},
    },
  );
});
