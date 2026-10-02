import assert from 'node:assert/strict';
import test from 'node:test';

import type { HistoryCompactionSettings } from '../../../../session-storage/settings/history-compaction.js';
import { shouldRunHistoryCompaction } from '../sdk';

const config: HistoryCompactionSettings = {
  enabled: true,
  thresholdMode: 'tokens',
  softThreshold: 1_000,
  hardThreshold: 2_000,
  keepRecentTokens: 30_000,
  summaryInstructions: '',
  summaryThinkingLevel: 'inherit',
  summaryModel: null,
  modelProfiles: {},
};

// Runtime behavior is owned by source-history-compaction.test.ts; summary
// policy uses the public factory/beforeCompact bridge in source-sdk-loader.test.ts.
// Prototype installation and unsupported private SDK shapes are retired.
test('history compaction threshold helper resolves percentage and token modes', () => {
  assert.equal(shouldRunHistoryCompaction(config, { tokens: 999, contextWindow: 10_000 }, 'soft'), false);
  assert.equal(shouldRunHistoryCompaction(config, { tokens: 1_000, contextWindow: 10_000 }, 'soft'), true);
  assert.equal(shouldRunHistoryCompaction({ ...config, thresholdMode: 'percentage', softThreshold: 70, hardThreshold: 85 }, { tokens: 8_500, contextWindow: 10_000 }, 'hard'), true);
  assert.equal(shouldRunHistoryCompaction(undefined, { tokens: 9_000, contextWindow: 10_000 }, 'hard'), false);
  assert.equal(shouldRunHistoryCompaction({ ...config, enabled: false }, { tokens: 9_000, contextWindow: 10_000 }, 'hard'), false);

  const profiled: HistoryCompactionSettings = {
    ...config,
    modelProfiles: {
      'test/profiled': { softThreshold: 3_000, hardThreshold: 4_000, keepRecentTokens: 1_000 },
    },
  };
  assert.equal(
    shouldRunHistoryCompaction(profiled, { tokens: 2_500, contextWindow: 10_000 }, 'soft', { provider: 'test', id: 'profiled' }),
    false,
  );
  assert.equal(
    shouldRunHistoryCompaction(profiled, { tokens: 3_000, contextWindow: 10_000 }, 'soft', { provider: 'test', id: 'profiled' }),
    true,
  );
});
