import assert from 'node:assert/strict';
import test from 'node:test';

import type { HistoricalSessionSourceSummary } from '../scripts/contracts.ts';
import { createModelLeaderboard } from '../scripts/leaderboard.ts';
import { prepareSourceAnalytics } from '../scripts/prepare.ts';
import { deepClone, loadFixture } from './helpers.ts';

function transcript(path: string, modelId: string, share = 1): HistoricalSessionSourceSummary {
  return {
    sessionId: path, normalizedSessionPath: path, startedAt: '2026-05-01T00:00:00.000Z', endedAt: '2026-05-01T00:10:00.000Z',
    firstUserMessageChars: 9_999,
    attributions: [{ modelId, thinkingLevel: 'high', share, successfulAssistantTurns: 1, attributedTokens: 10 }],
    successfulAssistantTurns: 1, errorAssistantTurns: 0, abortedAssistantTurns: 0,
    inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0,
    reportedCostUsd: null, toolCallCount: 2, toolErrorCount: 0, terminalStatus: 'success',
    mixedModel: false, sourceProvenance: ['legacy'],
  };
}

test('stage-2 family leaderboard discards unreviewed legacy transcript telemetry', async () => {
  const fixture = deepClone(await loadFixture());
  const matched = transcript(fixture.completedRuns[0]!.sessionPath, fixture.completedRuns[0]!.modelId!);
  const opus = transcript('C:/private/transcript-only-opus.jsonl', 'claude-opus-4.8');
  fixture.historicalSessions = [matched, opus];

  const leaderboard = createModelLeaderboard(prepareSourceAnalytics(fixture));
  assert.equal(leaderboard.schemaVersion, 7);
  assert.equal(leaderboard.rows.some((row) => row.modelId === 'claude-opus-4.8'), false,
    'legacy transcript attribution alone must not create a harness-comparison row');
  assert.equal(leaderboard.rows.some((row) => row.modelId === prepareSourceAnalytics(fixture).runs[0]!.modelFamily), false,
    'legacy run attribution alone must not create a harness-comparison row');
  assert.ok(Math.abs(leaderboard.caseMix.targetBandWeights.low + leaderboard.caseMix.targetBandWeights.medium + leaderboard.caseMix.targetBandWeights.high - 1) < 0.001);
});

test('mixed transcript attribution distributes one process task mass', async () => {
  const fixture = deepClone(await loadFixture());
  const mixed = transcript('C:/private/mixed.jsonl', 'claude-opus-4.8', 0.7);
  mixed.mixedModel = true;
  mixed.attributions.push({ modelId: 'stage2-other-family', thinkingLevel: 'low', share: 0.3, successfulAssistantTurns: 1, attributedTokens: 3 });
  fixture.historicalSessions = [mixed];
  const rows = createModelLeaderboard(prepareSourceAnalytics(fixture)).rows;
  const mass = rows.filter((row) => ['claude-opus-4.8', 'stage2-other-family'].includes(row.modelId))
    .reduce((sum, row) => sum + row.processEvidenceMass, 0);
  assert.equal(mass, 0, 'historical transcript process telemetry is excluded from current-harness diagnostics');
});

test('unreviewed transcript-only sessions do not create leaderboard diagnostics', async () => {
  const fixture = deepClone(await loadFixture());
  const withProcess = transcript('C:/private/with-process.jsonl', 'claude-opus-4.8');
  const noProcess: typeof withProcess = {
    ...transcript('C:/private/no-process.jsonl', 'claude-opus-4.8'),
    terminalStatus: 'none',
    toolCallCount: 0,
    toolErrorCount: 0,
  };
  fixture.historicalSessions = [withProcess, noProcess];
  const leaderboard = createModelLeaderboard(prepareSourceAnalytics(fixture));
  assert.equal(leaderboard.rows.some((row) => row.modelId === 'claude-opus-4.8'), false);
});
