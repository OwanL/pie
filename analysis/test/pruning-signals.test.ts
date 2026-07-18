import assert from 'node:assert/strict';
import test from 'node:test';

import type { PruningSourceDecision, PruningSourceEvent, SourceAnalyticsPayload } from '../scripts/contracts.ts';
import { coerceSourceAnalyticsPayload } from '../scripts/source.ts';
import { prepareSourceAnalytics } from '../scripts/prepare.ts';
import { buildSiteDataBundle, readSiteDataBundle, validateSiteDataBundle, writeSiteData } from '../scripts/site-data.ts';
import { deepClone, loadFixture, withTempDir } from './helpers.ts';

/** Minimal decision shape (only the fields preparePruningEvents reads are exercised here). */
function makeDecision(sessionPath: string, opts: { toolExcluded?: string[]; toolIncluded?: string[]; excluded?: string[]; included?: string[] }): PruningSourceDecision {
  return {
    timestamp: '2026-05-12T10:00:00.000Z',
    sessionId: sessionPath,
    sessionPath,
    mode: 'auto',
    query: 'test query',
    llmModel: 'test-model',
    llmThinkingLevel: 'medium',
    llmLatencyMs: 120,
    included: opts.included ?? ['kept-skill'],
    excluded: opts.excluded ?? ['pruned-skill'],
    skillBlockTokens: 100,
    originalBlockTokens: 200,
    toolIncluded: opts.toolIncluded ?? ['kept-tool'],
    toolExcluded: opts.toolExcluded ?? [],
    toolBlockTokens: 50,
    originalToolBlockTokens: 100,
  };
}

function makeEvent(event: PruningSourceEvent['event'], sessionId: string, name?: string): PruningSourceEvent {
  const base: PruningSourceEvent = { event, sessionId, timestamp: '2026-05-12T10:05:00.000Z' };
  if (event === 'tool_recovered') {
    base.toolName = name ?? 'pruned-tool';
  } else {
    base.skillName = name ?? 'pruned-skill';
  }
  return base;
}

test('coerceSourceAnalyticsPayload ingests and filters pruningEvents', async () => {
  const fixture = await loadFixture();
  const payload: SourceAnalyticsPayload = {
    ...fixture,
    pruningEvents: [
      makeEvent('skill_read', 'sess-a', 'read-skill'),
      makeEvent('skill_miss', 'sess-a', 'missed-skill'),
      makeEvent('shadow_miss_candidate', 'sess-a', 'shadow-skill'),
      makeEvent('skill_recovered', 'sess-a', 'recovered-skill'),
      makeEvent('tool_recovered', 'sess-a', 'recovered-tool'),
      // Malformed entries below must be dropped:
      { event: 'skill_read', sessionId: 'sess-a' } as PruningSourceEvent, // missing timestamp
      { event: 'bogus_event', sessionId: 'sess-a', timestamp: '2026-05-12T10:05:00.000Z' } as unknown as PruningSourceEvent, // unknown event
      { event: 'skill_miss', timestamp: '2026-05-12T10:05:00.000Z' } as PruningSourceEvent, // missing sessionId
      'not-an-object' as unknown as PruningSourceEvent,
    ],
  };

  const coerced = coerceSourceAnalyticsPayload(payload);
  assert.equal(coerced.pruningEvents.length, 5, 'only the five well-formed events survive coercion');
  assert.deepEqual(
    coerced.pruningEvents.map((e) => e.event),
    ['skill_read', 'skill_miss', 'shadow_miss_candidate', 'skill_recovered', 'tool_recovered'],
  );
  assert.equal(coerced.pruningEvents[4].toolName, 'recovered-tool');
  assert.equal(coerced.pruningEvents[3].skillName, 'recovered-skill');
  assert.equal(coerced.pruningEvents[0].skillName, 'read-skill');
});

test('coerceSourceAnalyticsPayload tolerates a missing pruningEvents array', async () => {
  const fixture = await loadFixture();
  const { pruningEvents: _ignored, ...withoutEvents } = fixture;
  const coerced = coerceSourceAnalyticsPayload(withoutEvents);
  assert.deepEqual(coerced.pruningEvents, []);
});

test('prepareSourceAnalytics joins pruning signals to runs by sessionPathHash', async () => {
  const fixture = deepClone(await loadFixture());
  const targetRun = fixture.completedRuns[0];
  const sessionPath = targetRun.sessionPath;

  fixture.pruningDecisions = [
    makeDecision(sessionPath, { toolExcluded: ['pruned-tool-a'] }),
    makeDecision(sessionPath, { toolExcluded: ['pruned-tool-b'] }),
    makeDecision(sessionPath, { toolExcluded: [] }), // pruned 0 tools — excluded from recovered-rate denominator
  ];
  fixture.pruningEvents = [
    makeEvent('skill_read', sessionPath, 'read-1'),
    makeEvent('skill_read', sessionPath, 'read-2'),
    makeEvent('skill_read', sessionPath, 'read-3'),
    makeEvent('skill_miss', sessionPath, 'missed-1'),
    makeEvent('skill_miss', sessionPath, 'missed-2'),
    makeEvent('shadow_miss_candidate', sessionPath, 'shadow-1'),
    makeEvent('tool_recovered', sessionPath, 'pruned-tool-a'),
  ];

  const prepared = prepareSourceAnalytics(fixture);

  // All 7 events become signal rows joined to the target run.
  assert.equal(prepared.pruningSignals.length, 7);
  for (const signal of prepared.pruningSignals) {
    assert.equal(signal.runId, targetRun.runId, `signal ${signal.event} joined to expected run`);
    assert.equal(signal.sessionPathHash, prepared.runs[0].sessionPathHash);
  }
  assert.equal(prepared.pruningSignals[6].toolName, 'pruned-tool-a');
  assert.equal(prepared.pruningSignals[6].skillName, null);
  assert.equal(prepared.pruningSignals[0].skillName, 'read-1');
  assert.equal(prepared.pruningSignals[0].toolName, null);
});

test('pruningImpact summary reports miss/recovery counts and the recovered rate', async () => {
  const fixture = deepClone(await loadFixture());
  const targetRun = fixture.completedRuns[0];
  const sessionPath = targetRun.sessionPath;

  fixture.pruningDecisions = [
    makeDecision(sessionPath, { toolExcluded: ['pruned-tool-a'] }),
    makeDecision(sessionPath, { toolExcluded: ['pruned-tool-b'] }),
    makeDecision(sessionPath, { toolExcluded: [] }), // 0 tools pruned
  ];
  // 3 skill reads, 2 skill misses, 1 shadow miss, 1 tool recovery.
  fixture.pruningEvents = [
    makeEvent('skill_read', sessionPath),
    makeEvent('skill_read', sessionPath),
    makeEvent('skill_read', sessionPath),
    makeEvent('skill_miss', sessionPath),
    makeEvent('skill_miss', sessionPath),
    makeEvent('shadow_miss_candidate', sessionPath),
    makeEvent('tool_recovered', sessionPath, 'pruned-tool-a'),
  ];

  const bundle = buildSiteDataBundle(prepareSourceAnalytics(fixture));
  const summary = bundle.pruningImpact.summary;

  assert.equal(summary.skillReadCount, 3);
  assert.equal(summary.skillMissCount, 2);
  assert.equal(summary.shadowMissCandidateCount, 1);
  assert.equal(summary.toolRecoveredCount, 1);
  // 2 of 3 decisions pruned >=1 tool.
  assert.equal(summary.decisionsThatPrunedTools, 2);
  // recovered rate = 1 tool_recovered / 2 tool-pruning decisions = 0.5
  assert.equal(summary.pruneRecoveredRate, 0.5);
  // skill miss rate = (2 skill_miss + 1 shadow) / (3 read + 2 miss + 1 shadow) = 3/6 = 0.5
  assert.equal(summary.skillMissRate, 0.5);
  assert.equal(bundle.pruningImpact.signalRows.length, 7);

  validateSiteDataBundle(bundle);
});

test('pruneRecoveredRate is null when no decision pruned a tool (denominator 0)', async () => {
  const fixture = deepClone(await loadFixture());
  const targetRun = fixture.completedRuns[0];
  const sessionPath = targetRun.sessionPath;

  fixture.pruningDecisions = [makeDecision(sessionPath, { toolExcluded: [] })];
  fixture.pruningEvents = [makeEvent('tool_recovered', sessionPath, 'pruned-tool-a')];

  const bundle = buildSiteDataBundle(prepareSourceAnalytics(fixture));
  const summary = bundle.pruningImpact.summary;

  assert.equal(summary.decisionsThatPrunedTools, 0);
  assert.equal(summary.pruneRecoveredRate, null, 'null denominator → null rate');
  // skillMissRate is also null when there are no skill reads at all.
  assert.equal(summary.skillMissRate, null);
});

test('pruneRecoveredRate can exceed 1 when one decision yields multiple recoveries', async () => {
  const fixture = deepClone(await loadFixture());
  const targetRun = fixture.completedRuns[0];
  const sessionPath = targetRun.sessionPath;

  fixture.pruningDecisions = [makeDecision(sessionPath, { toolExcluded: ['pruned-tool-a', 'pruned-tool-b'] })];
  fixture.pruningEvents = [
    makeEvent('tool_recovered', sessionPath, 'pruned-tool-a'),
    makeEvent('tool_recovered', sessionPath, 'pruned-tool-b'),
    makeEvent('tool_recovered', sessionPath, 'pruned-tool-a'),
  ];

  const bundle = buildSiteDataBundle(prepareSourceAnalytics(fixture));
  const summary = bundle.pruningImpact.summary;

  // 3 recovery events / 1 tool-pruning decision = 3 (>1 — a rate-of-incidence signal, not a strict fraction).
  assert.equal(summary.decisionsThatPrunedTools, 1);
  assert.equal(summary.toolRecoveredCount, 3);
  assert.equal(summary.pruneRecoveredRate, 3);
});

test('pruning signal rows + summary survive a site-data write/read round-trip', async () => {
  const fixture = deepClone(await loadFixture());
  const targetRun = fixture.completedRuns[0];
  const sessionPath = targetRun.sessionPath;

  fixture.pruningDecisions = [
    makeDecision(sessionPath, { toolExcluded: ['pruned-tool-a'] }),
  ];
  fixture.pruningEvents = [
    makeEvent('skill_read', sessionPath, 'read-1'),
    makeEvent('skill_miss', sessionPath, 'missed-1'),
    makeEvent('shadow_miss_candidate', sessionPath, 'shadow-1'),
    makeEvent('tool_recovered', sessionPath, 'pruned-tool-a'),
  ];

  const bundle = buildSiteDataBundle(prepareSourceAnalytics(fixture));

  await withTempDir(async (dir) => {
    await writeSiteData(dir, bundle);
    const readBack = await readSiteDataBundle(dir);
    assert.equal(readBack.pruningImpact.signalRows.length, 4);
    assert.equal(readBack.pruningImpact.summary.skillMissCount, 1);
    assert.equal(readBack.pruningImpact.summary.shadowMissCandidateCount, 1);
    assert.equal(readBack.pruningImpact.summary.toolRecoveredCount, 1);
    assert.equal(readBack.pruningImpact.summary.decisionsThatPrunedTools, 1);
    assert.equal(readBack.pruningImpact.summary.pruneRecoveredRate, 1);
  });
});
