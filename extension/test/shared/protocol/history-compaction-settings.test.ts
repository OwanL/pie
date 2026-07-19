import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_HISTORY_COMPACTION_SETTINGS,
  DEFAULT_HISTORY_COMPACTION_TOKEN_THRESHOLDS,
  resolveChatPrefs,
  resolveHistoryCompactionSettings,
  resolveHistoryCompactionThresholdTokens,
} from '../../../src/shared/protocol';

test('history compaction defaults to proactive 70/85 percent thresholds', () => {
  assert.deepEqual(resolveHistoryCompactionSettings(undefined), DEFAULT_HISTORY_COMPACTION_SETTINGS);
  assert.deepEqual(resolveChatPrefs().historyCompaction, DEFAULT_HISTORY_COMPACTION_SETTINGS);
});

test('history compaction accepts an ordered absolute-token policy', () => {
  const settings = resolveHistoryCompactionSettings({
    enabled: false,
    thresholdMode: 'tokens',
    softThreshold: 80_000,
    hardThreshold: 100_000,
  });
  assert.deepEqual(settings, {
    enabled: false,
    thresholdMode: 'tokens',
    softThreshold: 80_000,
    hardThreshold: 100_000,
    keepRecentTokens: 30_000,
    summaryInstructions: '',
    summaryThinkingLevel: 'inherit',
    summaryModel: null,
    modelProfiles: {},
  });
});

test('history compaction restores a safe pair when thresholds invert or leave range', () => {
  assert.deepEqual(
    resolveHistoryCompactionSettings({
      enabled: true,
      thresholdMode: 'percentage',
      softThreshold: 90,
      hardThreshold: 80,
    }),
    DEFAULT_HISTORY_COMPACTION_SETTINGS,
  );

  assert.deepEqual(
    resolveHistoryCompactionSettings({
      enabled: true,
      thresholdMode: 'tokens',
      softThreshold: 500,
      hardThreshold: 400,
    }),
    {
      enabled: true,
      thresholdMode: 'tokens',
      softThreshold: DEFAULT_HISTORY_COMPACTION_TOKEN_THRESHOLDS.soft,
      hardThreshold: DEFAULT_HISTORY_COMPACTION_TOKEN_THRESHOLDS.hard,
      keepRecentTokens: 30_000,
      summaryInstructions: '',
      summaryThinkingLevel: 'inherit',
      summaryModel: null,
      modelProfiles: {},
    },
  );
});

test('history compaction resolves percentage and token limits for an active model', () => {
  assert.equal(
    resolveHistoryCompactionThresholdTokens(DEFAULT_HISTORY_COMPACTION_SETTINGS, 200_000, 'soft'),
    140_000,
  );
  assert.equal(
    resolveHistoryCompactionThresholdTokens(DEFAULT_HISTORY_COMPACTION_SETTINGS, 200_000, 'hard'),
    170_000,
  );
  assert.equal(
    resolveHistoryCompactionThresholdTokens({
      enabled: true,
      thresholdMode: 'tokens',
      softThreshold: 80_500.8,
      hardThreshold: 100_900.2,
      keepRecentTokens: 30_000,
      summaryInstructions: '',
      summaryThinkingLevel: 'inherit',
      summaryModel: null,
      modelProfiles: {},
    }, 200_000, 'hard'),
    100_900,
  );
});

test('history compaction coerces new summary and retention fields', () => {
  const settings = resolveHistoryCompactionSettings({
    enabled: true,
    thresholdMode: 'tokens',
    softThreshold: 80_000,
    hardThreshold: 100_000,
    keepRecentTokens: 50_000,
    summaryInstructions: 'Summarize briefly.',
    summaryThinkingLevel: 'low',
    summaryModel: { provider: 'openai', id: 'gpt-5' },
  });
  assert.equal(settings.keepRecentTokens, 50_000);
  assert.equal(settings.summaryInstructions, 'Summarize briefly.');
  assert.equal(settings.summaryThinkingLevel, 'low');
  assert.deepEqual(settings.summaryModel, { provider: 'openai', id: 'gpt-5' });
});

test('history compaction clamps token-mode retention below the soft threshold', () => {
  const settings = resolveHistoryCompactionSettings({
    enabled: true,
    thresholdMode: 'tokens',
    softThreshold: 40_000,
    hardThreshold: 60_000,
    keepRecentTokens: 50_000,
  });
  assert.equal(settings.keepRecentTokens, 39_999);
});

test('history compaction clamps summary instructions and drops invalid model profiles', () => {
  const longInstructions = 'x'.repeat(5_000);
  const settings = resolveHistoryCompactionSettings({
    enabled: true,
    thresholdMode: 'tokens',
    softThreshold: 80_000,
    hardThreshold: 100_000,
    summaryInstructions: longInstructions,
    modelProfiles: {
      'openai/gpt-5': { softThreshold: 90_000, hardThreshold: 110_000, keepRecentTokens: 10_000 },
      'bad/invalid': { softThreshold: 5_000, hardThreshold: 100_000, keepRecentTokens: 6_000 },
      'also/bad': 'nope' as unknown as { softThreshold: number; hardThreshold: number; keepRecentTokens: number },
    },
  });
  assert.equal(settings.summaryInstructions.length, 4_000);
  assert.deepEqual(settings.modelProfiles, {
    'openai/gpt-5': { softThreshold: 90_000, hardThreshold: 110_000, keepRecentTokens: 10_000 },
  });
});
