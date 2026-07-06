import assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';

import type { ToolResultPruningSourceEvent, SourceAnalyticsPayload } from '../scripts/contracts.ts';
import { coerceSourceAnalyticsPayload } from '../scripts/source.ts';
import { prepareSourceAnalytics } from '../scripts/prepare.ts';
import { buildSiteDataBundle, readSiteDataBundle, validateSiteDataBundle, writeSiteData } from '../scripts/site-data.ts';
import { deepClone, loadFixture, withTempDir } from './helpers.ts';

function makeEvent(sessionId: string, toolName: string, rules: string[], opts: { before?: number; after?: number } = {}): ToolResultPruningSourceEvent {
  const before = opts.before ?? 100;
  const after = opts.after ?? 60;
  return {
    event: 'tool_result_pruned',
    sessionId,
    toolName,
    rules,
    beforeTokens: before,
    afterTokens: after,
    tokensSaved: before - after,
    timestamp: '2026-07-04T08:00:00.000Z',
  };
}

test('coerceSourceAnalyticsPayload ingests and filters toolResultPruningEvents', async () => {
  const fixture = await loadFixture();
  const payload: SourceAnalyticsPayload = {
    ...fixture,
    toolResultPruningEvents: [
      makeEvent('sess-a', 'bash', ['ansi-strip', 'minify-json'], { before: 200, after: 80 }),
      makeEvent('sess-a', 'ls', ['collapse-blank-runs']),
      // Malformed entries below must be dropped:
      { event: 'tool_result_pruned', sessionId: 'sess-a', toolName: 'bash', rules: ['ansi-strip'], beforeTokens: 10, afterTokens: 5 } as unknown as ToolResultPruningSourceEvent, // missing tokensSaved + timestamp
      { event: 'tool_result_pruned', sessionId: 'sess-a', toolName: 'bash', rules: ['ansi-strip', 7], beforeTokens: 10, afterTokens: 5, tokensSaved: 5, timestamp: '2026-07-04T08:00:00.000Z' } as unknown as ToolResultPruningSourceEvent, // non-string rule
      { event: 'other_event', sessionId: 'sess-a', toolName: 'bash', rules: [], beforeTokens: 1, afterTokens: 0, tokensSaved: 1, timestamp: '2026-07-04T08:00:00.000Z' } as unknown as ToolResultPruningSourceEvent, // wrong event type
      { event: 'tool_result_pruned', toolName: 'bash', rules: [], beforeTokens: 1, afterTokens: 0, tokensSaved: 1, timestamp: '2026-07-04T08:00:00.000Z' } as unknown as ToolResultPruningSourceEvent, // missing sessionId
      'not-an-object' as unknown as ToolResultPruningSourceEvent,
    ],
  };

  const coerced = coerceSourceAnalyticsPayload(payload);
  assert.equal(coerced.toolResultPruningEvents.length, 2, 'only the two well-formed events survive coercion');
  assert.equal(coerced.toolResultPruningEvents[0]!.toolName, 'bash');
  assert.deepEqual(coerced.toolResultPruningEvents[0]!.rules, ['ansi-strip', 'minify-json']);
  assert.equal(coerced.toolResultPruningEvents[0]!.tokensSaved, 120);
});

test('coerceSourceAnalyticsPayload tolerates a missing toolResultPruningEvents array', async () => {
  const fixture = deepClone(await loadFixture());
  const { toolResultPruningEvents: _ignored, ...without } = fixture;
  const coerced = coerceSourceAnalyticsPayload(without);
  assert.deepEqual(coerced.toolResultPruningEvents, []);
});

test('prepareSourceAnalytics joins tool-result-pruning rows to runs by sessionPathHash', async () => {
  const fixture = deepClone(await loadFixture());
  const targetRun = fixture.completedRuns[0]!;
  const sessionPath = targetRun.sessionPath;

  fixture.toolResultPruningEvents = [
    makeEvent(sessionPath, 'bash', ['ansi-strip', 'minify-json'], { before: 200, after: 80 }),
    makeEvent(sessionPath, 'grep', ['ansi-strip']),
  ];

  const prepared = prepareSourceAnalytics(fixture);
  assert.equal(prepared.toolResultPruning.length, 2);
  for (const row of prepared.toolResultPruning) {
    assert.equal(row.runId, targetRun.runId, `row for ${row.toolName} joined to expected run`);
    assert.equal(row.sessionPathHash, prepared.runs[0]!.sessionPathHash);
    assert.equal(row.startedDay, '2026-07-04');
  }
  assert.deepEqual(prepared.toolResultPruning[0]!.rules, ['ansi-strip', 'minify-json']);
  assert.equal(prepared.toolResultPruning[0]!.tokensSaved, 120);
});

test('toolResultPruningImpact summary aggregates by rule and by tool', async () => {
  const fixture = deepClone(await loadFixture());
  const sessionPath = fixture.completedRuns[0]!.sessionPath;

  fixture.toolResultPruningEvents = [
    makeEvent(sessionPath, 'bash', ['ansi-strip', 'minify-json'], { before: 200, after: 80 }), // saves 120
    makeEvent(sessionPath, 'bash', ['ansi-strip'], { before: 100, after: 60 }), // saves 40
    makeEvent(sessionPath, 'ls', ['collapse-blank-runs'], { before: 50, after: 45 }), // saves 5
  ];

  const bundle = buildSiteDataBundle(prepareSourceAnalytics(fixture));
  const impact = bundle.toolResultPruningImpact;

  assert.equal(impact.summary.totalEvents, 3);
  assert.equal(impact.summary.totalBeforeTokens, 350);
  assert.equal(impact.summary.totalAfterTokens, 185);
  assert.equal(impact.summary.totalTokensSaved, 165);

  // ansi-strip fired on both bash results → count 2, tokensSaved 120+40=160
  const ansi = impact.summary.byRule.find((r) => r.rule === 'ansi-strip')!;
  assert.equal(ansi.count, 2);
  assert.equal(ansi.tokensSaved, 160);
  const minify = impact.summary.byRule.find((r) => r.rule === 'minify-json')!;
  assert.equal(minify.count, 1);
  assert.equal(minify.tokensSaved, 120);
  // byRule sorted by tokensSaved desc → ansi-strip first.
  assert.equal(impact.summary.byRule[0]!.rule, 'ansi-strip');

  // byTool: bash count 2, tokensSaved 160; ls count 1, tokensSaved 5.
  const bash = impact.summary.byTool.find((t) => t.toolName === 'bash')!;
  assert.equal(bash.count, 2);
  assert.equal(bash.tokensSaved, 160);
  assert.equal(bash.beforeTokens, 300);
  assert.equal(bash.afterTokens, 140);
  const ls = impact.summary.byTool.find((t) => t.toolName === 'ls')!;
  assert.equal(ls.count, 1);
  assert.equal(ls.tokensSaved, 5);
});

test('tool-result-pruning-impact.json round-trips through write/read and validates', async () => {
  const fixture = deepClone(await loadFixture());
  const sessionPath = fixture.completedRuns[0]!.sessionPath;
  fixture.toolResultPruningEvents = [
    makeEvent(sessionPath, 'bash', ['ansi-strip']),
    makeEvent(sessionPath, 'grep', ['minify-json', 'collapse-blank-runs'], { before: 80, after: 30 }),
  ];

  const bundle = buildSiteDataBundle(prepareSourceAnalytics(fixture));
  validateSiteDataBundle(bundle);

  await withTempDir(async (dir) => {
    await writeSiteData(dir, bundle);
    const roundTrip = await readSiteDataBundle(dir);
    assert.equal(roundTrip.toolResultPruningImpact.summary.totalEvents, 2);
    assert.equal(roundTrip.toolResultPruningImpact.summary.totalTokensSaved, 90);
    assert.deepEqual(
      roundTrip.toolResultPruningImpact.rows.map((r) => r.toolName),
      ['bash', 'grep'],
    );
  });
});

test('toolResultPruningImpact is empty-but-well-formed when no events were recorded', async () => {
  const fixture = deepClone(await loadFixture());
  fixture.toolResultPruningEvents = [];
  const bundle = buildSiteDataBundle(prepareSourceAnalytics(fixture));
  assert.equal(bundle.toolResultPruningImpact.summary.totalEvents, 0);
  assert.equal(bundle.toolResultPruningImpact.summary.totalTokensSaved, 0);
  assert.deepEqual(bundle.toolResultPruningImpact.summary.byRule, []);
  assert.deepEqual(bundle.toolResultPruningImpact.summary.byTool, []);
  validateSiteDataBundle(bundle);
});

test('readToolResultPruningLog-style ingestion is best-effort (missing file → [])', async () => {
  // The extension writes data/tool-result-pruning.jsonl; the analysis reader
  // treats a missing file as no events. We exercise the coerce path (the
  // reader shares its validation predicate) with a raw JSONL-shaped buffer.
  const fixture = await loadFixture();
  const lines = [
    JSON.stringify(makeEvent('sess-a', 'bash', ['ansi-strip'])),
    'not-json',
    JSON.stringify({ event: 'tool_result_pruned', sessionId: 'sess-a', toolName: 'ls', rules: ['minify-json'], beforeTokens: 40, afterTokens: 10, tokensSaved: 30, timestamp: '2026-07-04T08:00:00.000Z' }),
  ];
  const parsed = lines.filter((l) => l.trim().length > 0).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter((x) => x !== null);
  const coerced = coerceSourceAnalyticsPayload({ ...fixture, toolResultPruningEvents: parsed as ToolResultPruningSourceEvent[] });
  assert.equal(coerced.toolResultPruningEvents.length, 2);
  assert.equal(coerced.toolResultPruningEvents[1]!.toolName, 'ls');
  void path; // keep import meaningful for future file-based reads
});

test('tool-result-pruning-outcomes.json buckets runs by enabled state and contrasts satisfaction', async () => {
  const fixture = deepClone(await loadFixture());
  // Stamp toolResultPruningEnabled onto the first three completed runs: true / false / true.
  const completed = fixture.completedRuns;
  completed[0]!.functionalSettings = {
    subagentAlwaysParentModel: false, pruningMode: 'auto', extensionToggles: {},
    toolResultPruningEnabled: true, toolResultPruningProfile: 'default',
  };
  completed[1]!.functionalSettings = {
    subagentAlwaysParentModel: false, pruningMode: 'auto', extensionToggles: {},
    toolResultPruningEnabled: false, toolResultPruningProfile: 'default',
  };
  completed[2]!.functionalSettings = {
    subagentAlwaysParentModel: false, pruningMode: 'auto', extensionToggles: {},
    toolResultPruningEnabled: true, toolResultPruningProfile: 'security',
  };
  // Give the runs user outcomes so the scored counts are nonzero.
  for (const [i, run] of completed.entries()) {
    if (i >= 3) break;
    run.scored = true;
    run.outcome = { resolution: i === 1 ? 'partially_resolved' : 'resolved', satisfaction: i === 1 ? 3 : 5 };
  }

  const bundle = buildSiteDataBundle(prepareSourceAnalytics(fixture));
  validateSiteDataBundle(bundle);

  const byEnabled = new Map(bundle.toolResultPruningOutcomes.buckets.map((b) => [String(b.enabled), b]));
  assert.equal(byEnabled.get('true')!.runCount, 2);
  assert.equal(byEnabled.get('true')!.scoredRunCount, 2);
  assert.equal(byEnabled.get('true')!.meanSatisfaction, 5);
  assert.equal(byEnabled.get('false')!.runCount, 1);
  assert.equal(byEnabled.get('false')!.scoredRunCount, 1);
  assert.equal(byEnabled.get('false')!.meanSatisfaction, 3);
  assert.equal(byEnabled.get('false')!.resolvedRate, 0); // partially_resolved
  assert.ok(byEnabled.get('true')!.resolvedRate === 1);
  // Legacy runs (no functionalSettings) land in the null bucket.
  assert.ok(byEnabled.has('null'));
  assert.ok(bundle.toolResultPruningOutcomes.notes.length > 0);

  // Round-trips through write/read.
  await withTempDir(async (dir) => {
    await writeSiteData(dir, bundle);
    const roundTrip = await readSiteDataBundle(dir);
    assert.equal(roundTrip.toolResultPruningOutcomes.buckets.length, bundle.toolResultPruningOutcomes.buckets.length);
  });
});