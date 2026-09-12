import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
// @ts-expect-error The test runner imports this plain ESM validation module directly.
import * as enduranceValidationModule from '../../scripts/analytics-p0-endurance-validation.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..', '..');
const harness = path.join(repositoryRoot, 'extension', 'scripts', 'analytics-p0-qualification.mjs');
type EnduranceTrial = {
  decision: string;
  ratePerSecond: number;
  hostCount: number;
  handoff: Record<string, unknown>;
  observationToCommitted: Record<string, unknown>;
  workerMemory: { sampleCount: number; workers: unknown[] };
  requirements: { continuousWorkerMemory: { satisfied: boolean } };
};
type EndurancePlan = Readonly<{ label: string; ratePerSecond: number; sampleCount: number; hostCount: number; minimumElapsedMs: number }>;
type EnduranceValidationModule = {
  ENDURANCE_REQUIRED_WORKER_MEMORY_FIELDS: readonly string[];
  ENDURANCE_SMOKE_TRIALS: readonly EndurancePlan[];
  validateEnduranceTerminalReceipt: (endurance: any, receipt: any, options: { reportSha256: string }) => { valid: boolean; errors: string[] };
  validateEnduranceTrials: (endurance: any, options: { mode: 'smoke'; enforcePacing?: boolean }) => { valid: boolean; errors: string[] };
};
const {
  ENDURANCE_REQUIRED_WORKER_MEMORY_FIELDS,
  ENDURANCE_SMOKE_TRIALS,
  validateEnduranceTerminalReceipt,
  validateEnduranceTrials,
} = enduranceValidationModule as unknown as EnduranceValidationModule;

function reportPath(directory: string): string {
  return path.join(directory, 'endurance.json');
}

function validSmokeEndurance() {
  return {
    mode: 'smoke',
    productionDefaultRecorderHeap: true,
    summary: { lightP99Pooled: null },
    trials: ENDURANCE_SMOKE_TRIALS.map((target, trialIndex) => {
      const submissionElapsedMs = target.sampleCount * 1_000 / target.ratePerSecond;
      return {
        target,
        sampleCount: target.sampleCount,
        acceptedSampleCount: target.sampleCount,
        submissionElapsedMs,
        offeredRatePerSecond: target.ratePerSecond,
        elapsedMs: Math.max(100, target.minimumElapsedMs),
        endingBacklogRecords: 0,
        endingBacklogBytes: 0,
        workerMemory: {
          sampleCount: 2,
          workers: Array.from({ length: target.hostCount }, (_, workerIndex) => ({
            identity: {
              instanceId: `00000000-0000-4000-8000-${String(trialIndex * 4 + workerIndex + 1).padStart(12, '0')}`,
              pid: trialIndex * 4 + workerIndex + 1,
              spawnedAtMs: 1_789_214_141_000 + trialIndex * 4 + workerIndex,
            },
            sampleCount: 2,
            maxRssBytes: 1_000,
            maxHeapTotalBytes: 2_000,
            maxHeapUsedBytes: 1_000,
            maxExternalBytes: 500,
            maxArrayBuffersBytes: 100,
          })),
        },
      };
    }),
  };
}

test('endurance mode rejects the old environment execution switch', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pie-p0-endurance-args-'));
  try {
    const report = reportPath(directory);
    const result = spawnSync(process.execPath, [harness, '--scenario', 'endurance', '--smoke', '--seed', 'arg-check', '--report', report], {
      cwd: repositoryRoot,
      env: { ...process.env, PIE_ANALYTICS_P0_ENDURANCE: '1' },
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /no longer an execution switch/u);
    assert.equal(result.error, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('full endurance mode rejects harness-only heap ceilings', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pie-p0-endurance-heap-'));
  try {
    const report = reportPath(directory);
    const result = spawnSync(process.execPath, [harness, '--scenario', 'endurance', '--seed', 'heap-check', '--report', report], {
      cwd: repositoryRoot,
      env: { ...process.env, PIE_ANALYTICS_P0_RECORDER_HEAP_MB: '128' },
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /production-default recorder heap/u);
    assert.equal(result.error, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('endurance smoke records independent condition results and mandatory memory telemetry', { timeout: 30_000 }, () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pie-p0-endurance-smoke-'));
  try {
    const report = reportPath(directory);
    const result = spawnSync(process.execPath, [harness, '--scenario', 'endurance', '--smoke', '--seed', 'smoke-check', '--report', report], {
      cwd: repositoryRoot,
      env: { ...process.env },
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const evidence = JSON.parse(readFileSync(report, 'utf8')) as {
      status: string;
      configuration: { scenario: string; mode: string; rows: null; resolvedRowsFrom: string };
      qualification: { decision: string; overallP0: string };
      results: { endurance: { trials: EnduranceTrial[]; summary: { lightP99Pooled: unknown } } };
      gates: Record<string, { decision: string }>;
      provenance: { fingerprint: string; gitHead: string };
      cleanup: { completed: boolean; rootRemoved: boolean };
    };
    assert.equal(evidence.status, 'passed');
    assert.deepEqual(evidence.configuration, {
      scenario: 'endurance',
      mode: 'smoke',
      rows: null,
      seed: 'smoke-check',
      reportPath: report,
      resolvedRowsFrom: 'not-applicable',
    });
    assert.equal(evidence.qualification.decision, 'scenario-passed');
    assert.equal(evidence.qualification.overallP0, 'unqualified');
    assert.equal(evidence.results.endurance.trials.length, 6);
    assert.equal(evidence.results.endurance.summary.lightP99Pooled, null);
    assert.match(evidence.provenance.fingerprint, /^[0-9a-f]{64}$/u);
    assert.match(evidence.provenance.gitHead, /^[0-9a-f]{40}$/u);
    for (const trial of evidence.results.endurance.trials) {
      assert.equal(trial.decision, 'smoke-unqualified');
      assert.ok(trial.workerMemory.sampleCount >= 1);
      assert.equal(trial.workerMemory.workers.length, trial.hostCount);
      assert.equal(trial.requirements.continuousWorkerMemory.satisfied, true);
      for (const worker of trial.workerMemory.workers as Array<Record<string, unknown>>) {
        for (const field of ENDURANCE_REQUIRED_WORKER_MEMORY_FIELDS) {
          assert.ok(Number.isSafeInteger(worker[field]) && (worker[field] as number) >= 0, `${field} telemetry missing`);
        }
      }
    }
    const lightTrials = evidence.results.endurance.trials.filter((trial) => trial.ratePerSecond === 1);
    const sustainedTrials = evidence.results.endurance.trials.filter((trial) => trial.ratePerSecond === 50);
    assert.equal(lightTrials.length, 2);
    assert.equal(sustainedTrials.length, 4);
    assert.equal(sustainedTrials.filter((trial) => trial.hostCount === 1).length, 2);
    assert.equal(sustainedTrials.filter((trial) => trial.hostCount === 4).length, 2);
    assert.ok(lightTrials.every((trial) => !Object.hasOwn(trial.handoff, 'p99Ms')));
    assert.ok(lightTrials.every((trial) => !Object.hasOwn(trial.observationToCommitted, 'p99Ms')));
    assert.ok(Object.values(evidence.gates).every((gate) => gate.decision === 'unqualified'));
    assert.equal(evidence.cleanup.completed, true);
    assert.equal(evidence.cleanup.rootRemoved, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('endurance validation rejects a forged or mismeasured offered rate', () => {
  const endurance = validSmokeEndurance();
  endurance.trials[0].offeredRatePerSecond = 999;
  const validation = validateEnduranceTrials(endurance, { mode: 'smoke', enforcePacing: true });
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join('; '), /offered rate/u);
});

test('endurance validation requires every persisted worker heap high-water field', () => {
  const endurance = validSmokeEndurance();
  delete (endurance.trials[0].workerMemory.workers[0] as Record<string, unknown>).maxHeapUsedBytes;
  const validation = validateEnduranceTrials(endurance, { mode: 'smoke' });
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join('; '), /maxHeapUsedBytes/u);
});

test('terminal receipt validation rejects a worker observed alive', () => {
  const endurance = validSmokeEndurance();
  const receipt = {
    schemaVersion: 1,
    kind: 'pie-p0-endurance-terminal-receipt-v1',
    originalReportSha256: 'a'.repeat(64),
    workers: endurance.trials.flatMap((trial) => trial.workerMemory.workers.map((worker) => ({
      identity: worker.identity,
      processObservedAlive: false,
      observationKind: 'post-hoc-process-absence',
      exitCodeKnown: false,
      signalKnown: false,
    }))),
  };
  receipt.workers[0].processObservedAlive = true;
  const validation = validateEnduranceTerminalReceipt(endurance, receipt, { reportSha256: 'a'.repeat(64) });
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join('; '), /observed absent/u);
});
