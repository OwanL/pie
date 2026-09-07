/**
 * Safe startup-accounting benchmark.
 *
 * Copies only the named accounting/run inputs from the identified runtime
 * store into OS temporary directories, then drives the real StatsService (and
 * its real BillableAccounting dependency) without network access. The source
 * store is never opened for writing. The missing-ledger case is a synthetic
 * fixture made from the copied run history; it is intentionally not reported
 * as a production first migration.
 *
 * Run from the repository root:
 *   npm run perf:startup-accounting
 *
 * This is a perf file (*.perf.ts), so it is excluded from the normal test
 * suites. A timestamped JSON report is left in the OS temporary directory.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import assert from 'node:assert/strict';

import { createInitialArchState } from '../../src/host/core/arch-state';
import { StatsService, type StatsStartupStageMetric } from '../../src/host/stats-service/service';
import { workspaceHash } from '../../src/host/stats-service/helpers';
import type { ActivityTimelineDiagnostics } from '../../src/host/activity-timeline/service';

const SOURCE_STORAGE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../data/outcomes/d0586130398071a9',
);
const WORKSPACE_ID = 'startup-accounting-perf';
const RUN_INPUTS = [
  'run-snapshots.jsonl',
  'open-runs.a.json',
  'open-runs.b.json',
  'open-runs.gen',
] as const;
const ACCOUNTING_INPUTS = [
  'activity-intervals.json',
  'billable-invocations.jsonl',
] as const;
const OPTIONAL_ACCOUNTING_INPUTS = [
  'activity-intervals.journal.jsonl',
  'accounting-private-sessions.json',
] as const;
interface Scenario {
  readonly label: string;
  readonly kind: 'fully-migrated-copy' | 'synthetic-missing-ledger-fixture';
  readonly root: string;
  readonly storageDir: string;
}

interface ScenarioMeasurement {
  readonly label: string;
  readonly kind: Scenario['kind'];
  readonly runs: {
    completed: number;
    open: number;
    total: number;
  };
  readonly startResolvedDurationMs: number;
  readonly backgroundDurationMs: number;
  readonly shutdownDurationMs: number;
  readonly stages: readonly StatsStartupStageMetric[];
  readonly timelineDiagnostics: ActivityTimelineDiagnostics;
};

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copyNamedInputs(destinationDir: string, names: readonly string[]): Promise<void> {
  await fs.mkdir(destinationDir, { recursive: true });
  for (const name of names) {
    const sourcePath = path.join(SOURCE_STORAGE_DIR, name);
    assert.equal(
      await exists(sourcePath),
      true,
      `required runtime input is missing: ${sourcePath}`,
    );
    await fs.copyFile(sourcePath, path.join(destinationDir, name));
  }
}

async function copyOptionalNamedInputs(destinationDir: string, names: readonly string[]): Promise<void> {
  for (const name of names) {
    const sourcePath = path.join(SOURCE_STORAGE_DIR, name);
    if (await exists(sourcePath)) await fs.copyFile(sourcePath, path.join(destinationDir, name));
  }
}

async function createScenario(
  label: Scenario['label'],
  kind: Scenario['kind'],
  names: readonly string[],
): Promise<Scenario> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-startup-accounting-'));
  const storageDir = path.join(root, 'outcomes', workspaceHash(WORKSPACE_ID));
  await copyNamedInputs(storageDir, names);
  if (kind === 'fully-migrated-copy') {
    await copyOptionalNamedInputs(storageDir, OPTIONAL_ACCOUNTING_INPUTS);
  }
  return { label, kind, root, storageDir };
}

function timelineDiagnostics(stats: StatsService): ActivityTimelineDiagnostics {
  const seams = stats as unknown as {
    accounting: {
      activityTimeline: {
        getDiagnostics: () => ActivityTimelineDiagnostics;
      };
    };
  };
  return seams.accounting.activityTimeline.getDiagnostics();
}

async function waitForBackground(stats: StatsService): Promise<void> {
  for (let tick = 0; tick < 100_000; tick += 1) {
    const stages = stats.getStartupStageMetrics();
    if (stages.some((metric) => metric.stage === 'historical-migration')) {
      const seams = stats as unknown as { backgroundWork: Promise<void> | null };
      const background = seams.backgroundWork;
      if (background) {
        await background;
        return;
      }
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('deferred startup accounting work did not finish');
}

async function measureScenario(scenario: Scenario): Promise<ScenarioMeasurement> {
  const stats = new StatsService({
    dataOutcomesRootPath: path.join(scenario.root, 'outcomes'),
    workspaceId: WORKSPACE_ID,
    getArchState: () => createInitialArchState(),
    now: () => new Date('2026-09-07T00:00:00.000Z'),
    // Deliberately no backend/provider dependency: this benchmark only reads
    // copied files and exercises local accounting/storage code.
    scheduleRender: () => undefined,
  });

  const startAt = performance.now();
  await stats.start();
  const startResolvedDurationMs = performance.now() - startAt;

  const backgroundAt = performance.now();
  await waitForBackground(stats);
  const backgroundDurationMs = performance.now() - backgroundAt;
  const stages = [...stats.getStartupStageMetrics()];
  const persisted = stages.find((metric) => metric.stage === 'persisted-query');
  assert.ok(persisted, 'persisted-query stage must be recorded');
  const completed = persisted.counts.completedRuns ?? 0;
  const open = persisted.counts.openRuns ?? 0;

  const shutdownAt = performance.now();
  await stats.shutdown();
  const shutdownDurationMs = performance.now() - shutdownAt;

  return {
    label: scenario.label,
    kind: scenario.kind,
    runs: { completed, open, total: completed + open },
    startResolvedDurationMs,
    backgroundDurationMs,
    shutdownDurationMs,
    stages,
    timelineDiagnostics: timelineDiagnostics(stats),
  };
}

async function main(): Promise<void> {
  // Validate the source using only exact paths. No directory walk or session
  // traversal is needed; the runtime store's unrelated child directories are
  // deliberately not copied or inspected.
  for (const name of [...RUN_INPUTS, ...ACCOUNTING_INPUTS]) {
    assert.equal(
      await exists(path.join(SOURCE_STORAGE_DIR, name)),
      true,
      `identified runtime input is missing: ${path.join(SOURCE_STORAGE_DIR, name)}`,
    );
  }

  const currentStore = await createScenario(
    'current runtime store copy (restart/reconciliation baseline)',
    'fully-migrated-copy',
    [...RUN_INPUTS, ...ACCOUNTING_INPUTS],
  );
  const missingLedger = await createScenario(
    'synthetic missing-ledger fixture (copied run history only)',
    'synthetic-missing-ledger-fixture',
    RUN_INPUTS,
  );
  const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-startup-accounting-report-'));

  try {
    const measurements = [
      await measureScenario(currentStore),
      {
        ...(await measureScenario(currentStore)),
        label: 'current copy after reconciliation (fully migrated no-op restart)',
      },
      await measureScenario(missingLedger),
    ];
    const report = {
      measuredAt: new Date().toISOString(),
      sourceStore: SOURCE_STORAGE_DIR,
      copiedInputs: {
        currentRuntimeStore: [...RUN_INPUTS, ...ACCOUNTING_INPUTS],
        syntheticMissingLedger: RUN_INPUTS,
      },
      uncertainty: [
        'The fully migrated case is a copy of the current store; it measures restart/no-new-row work, not the historical first-ever migration.',
        'The missing-ledger case is synthetic: it reuses copied run history while deliberately omitting accounting files, so its migration cost is not a production first-migration claim.',
        'Timeline diagnostics count timeline bytes/calls/fsyncs only; run-history and ledger parser bytes are not separately instrumented here.',
        'OS scheduling, filesystem cache state, antivirus, and concurrent writers can change wall-clock/fsync durations.',
      ],
      measurements,
    };
    const reportPath = path.join(
      reportDir,
      `startup-accounting-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    );
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    for (const measurement of measurements) {
      const migration = measurement.stages.find((stage) => stage.stage === 'historical-migration');
      const healing = measurement.stages.find((stage) => stage.stage === 'timeline-healing');
      console.log(`\n${measurement.label}`);
      console.log(`  runs=${measurement.runs.total} (completed=${measurement.runs.completed}, open=${measurement.runs.open})`);
      console.log(`  start resolved=${measurement.startResolvedDurationMs.toFixed(1)}ms, background=${measurement.backgroundDurationMs.toFixed(1)}ms, shutdown=${measurement.shutdownDurationMs.toFixed(1)}ms`);
      console.log(`  healing=${healing?.durationMs.toFixed(1) ?? 'n/a'}ms, migration=${migration?.durationMs.toFixed(1) ?? 'n/a'}ms, attempted=${migration?.counts.attemptedRows ?? 'n/a'}, new=${migration?.counts.newInvocationRows ?? 'n/a'}`);
      console.log(`  timeline bytesRead=${measurement.timelineDiagnostics.bytesRead}, bytesWritten=${measurement.timelineDiagnostics.bytesWritten}, journalAppended=${measurement.timelineDiagnostics.journalAppendedBytes}, recoveryJournal=${measurement.timelineDiagnostics.journalCompactionBytes}`);
      console.log(`  applyMutations=${measurement.timelineDiagnostics.applyMutationsCount}, fsync=${measurement.timelineDiagnostics.fsyncCount} (${measurement.timelineDiagnostics.fsyncDurationMs.toFixed(1)}ms)`);
    }
    console.log(`\nReport written to ${reportPath}`);
  } finally {
    await Promise.all([
      fs.rm(currentStore.root, { recursive: true, force: true }),
      fs.rm(missingLedger.root, { recursive: true, force: true }),
    ]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
