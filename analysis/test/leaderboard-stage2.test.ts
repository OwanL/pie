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

test('stage-2 family leaderboard includes transcript-only families but does not double count matched transcripts', async () => {
  const fixture = deepClone(await loadFixture());
  const matched = transcript(fixture.completedRuns[0]!.sessionPath, fixture.completedRuns[0]!.modelId!);
  const opus = transcript('C:/private/transcript-only-opus.jsonl', 'claude-opus-4.8');
  fixture.historicalSessions = [matched, opus];

  const leaderboard = createModelLeaderboard(prepareSourceAnalytics(fixture));
  assert.equal(leaderboard.schemaVersion, 6);
  const opusRow = leaderboard.rows.find((row) => row.modelId === 'claude-opus-4.8');
  assert.ok(opusRow, 'transcript-only Opus family appears');
  assert.equal(opusRow.thinkingLevel, '(all)');
  assert.equal(opusRow.transcriptOnlySessionCount, 1);
  assert.equal(opusRow.processEvidenceMass, 1);
  assert.equal(opusRow.evidenceTier, 'telemetry-only');
  assert.equal(opusRow.rank, null, 'transcript runtime telemetry cannot create a V2 quality rank');
  assert.equal(opusRow.scoreInterval80, null);

  const canonicalFamily = prepareSourceAnalytics(fixture).runs[0]!.modelFamily!;
  const canonicalRow = leaderboard.rows.find((row) => row.modelId === canonicalFamily)!;
  assert.equal(canonicalRow.transcriptOnlySessionCount, 0, 'matched transcript is not appended as process evidence');
  assert.ok(canonicalRow.thinkingLevels.length >= 1, 'thinking levels collapse into a family breakdown');
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
  assert.equal(mass, 1);
});

test('transcriptOnlySessionCount counts every unique session regardless of process-value availability', async () => {
  const fixture = deepClone(await loadFixture());
  // One session WITH a process value (terminalStatus=success, toolCallCount>0).
  const withProcess = transcript('C:/private/with-process.jsonl', 'claude-opus-4.8');
  // One session WITHOUT a process value (terminalStatus=none, no tool calls) —
  // it must still be counted in transcriptOnlySessionCount but not in processEvidenceMass.
  const noProcess: typeof withProcess = {
    ...transcript('C:/private/no-process.jsonl', 'claude-opus-4.8'),
    terminalStatus: 'none',
    toolCallCount: 0,
    toolErrorCount: 0,
  };
  fixture.historicalSessions = [withProcess, noProcess];
  const leaderboard = createModelLeaderboard(prepareSourceAnalytics(fixture));
  const row = leaderboard.rows.find((row) => row.modelId === 'claude-opus-4.8')!;
  assert.equal(row.transcriptOnlySessionCount, 2, 'both sessions counted regardless of process value');
  assert.equal(row.processEvidenceMass, 1, 'only the session with a process value contributes process mass');
});

test('provider breakdown includes transcriptOnlySessionCount and transcriptEvidenceMass', async () => {
  const fixture = deepClone(await loadFixture());
  const t1 = transcript('C:/private/t1.jsonl', 'claude-opus-4.8', 0.6);
  const t2 = transcript('C:/private/t2.jsonl', 'claude-opus-4.8', 0.4);
  fixture.historicalSessions = [t1, t2];
  const leaderboard = createModelLeaderboard(prepareSourceAnalytics(fixture));
  const row = leaderboard.rows.find((row) => row.modelId === 'claude-opus-4.8')!;
  const provider = row.providers.find((provider) => provider.modelId === 'claude-opus-4.8')!;
  assert.ok(provider, 'transcript-only provider entry exists');
  assert.equal(provider.runCount, 0, 'transcript sessions do not inflate canonical runCount');
  assert.equal(provider.transcriptOnlySessionCount, 2, 'two unique transcript sessions');
  assert.equal(provider.transcriptEvidenceMass, 1, '0.6 + 0.4 = 1.0 fractional mass');
});
