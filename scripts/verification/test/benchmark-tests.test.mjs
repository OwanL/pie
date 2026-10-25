import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { benchmark, parseBenchmarkArgs } from '../benchmark-tests.mjs';

const files = [path.resolve('tiny.test.js')];
const counts = { tests: 1, passed: 1, failed: 0, cancelled: 0, skipped: 0, todo: 0, suites: 0, topLevel: 1 };
const good = () => ({ summary: { success: true, counts: { ...counts }, durationMs: 2 }, failures: [],
  fileAccounting: { success: true, executedFiles: files, timings: {
    files: [{ file: files[0], passed: true, durationMs: 1 }], totalFileDurationMs: 1, reportedTestDurationMs: 1 } } });
function harness(overrides = {}) {
  const calls = { resolve: 0, runtime: 0, overlay: 0, fixtures: 0, disposed: 0, overlayDisposed: 0, abortDisposed: 0, active: 0, runs: 0 };
  let output;
  let selection;
  const dependencies = {
    print: text => { if (text.startsWith('Benchmark output: ')) output = text.slice('Benchmark output: '.length); },
    resolveTestFiles: () => { calls.resolve++; return files; },
    withVerificationRuntime: async (_, signal, run) => { calls.runtime++; return run({ sdkPath: '/artifact/sdk', identity: 'abc', artifactDir: '/artifact' }); },
    createRunnerTsconfigOverlay: (_, options) => { calls.overlay++; assert.equal(options.sdkPath, '/artifact/sdk'); return { configPath: '/overlay', dispose: () => calls.overlayDisposed++ }; },
    createTestEnvironment: () => { calls.fixtures++; return { root: `fixture-${calls.fixtures}`, env: { fixture: calls.fixtures }, dispose: () => calls.disposed++ }; },
    abortOnProcessSignals: () => ({ signal: new AbortController().signal, dispose() { calls.abortDisposed++; } }),
    runNodeTests: async (selected, options) => {
      assert.equal(options.sdkPath, '/artifact/sdk');
      calls.runs++;
      assert.equal(calls.active++, 0);
      assert.ok(Object.isFrozen(selected));
      if (selection) assert.equal(selection, selected);
      selection = selected;
      assert.equal(options.env.fixture, calls.runs);
      assert.equal(options.env.TSX_TSCONFIG_PATH, '/overlay');
      await Promise.resolve();
      calls.active--;
      return { code: 0, teardownConfirmed: true };
    },
    readBenchmarkReport: good,
    ...overrides,
  };
  return { calls, dependencies, get outputDir() { return output; },
    cleanup: () => output && rmSync(output, { recursive: true, force: true }) };
}
const options = { artifactDir: path.resolve('artifact'), selectors: ['tiny.test.js'], nodeFlags: [], concurrencyList: [4, 8], repeat: 2 };

test('requires explicit artifact and rejects owned flags and SDK selection', () => {
  assert.throws(() => parseBenchmarkArgs(['tiny.test.js']), /required/);
  for (const flag of ['--test-concurrency=2', '--test-reporter', '--test-reporter-destination=x']) {
    assert.throws(() => parseBenchmarkArgs(['--pi-runtime', options.artifactDir, 'tiny.test.js', '--', flag]), /owns/);
  }
  assert.throws(() => parseBenchmarkArgs(['--pi-runtime', options.artifactDir, '--sdk-path=x', 'tiny.test.js']), /sdk-path/);
  const parsed = parseBenchmarkArgs(['--pi-runtime', options.artifactDir, '--repeat=2', '--concurrency-list=1,3', '--include=**/*.js', 'tiny.test.js', '--', '--test-name-pattern=tiny']);
  assert.deepEqual(parsed.concurrencyList, [1, 3]);
  assert.equal(parsed.repeat, 2);
  assert.deepEqual(parsed.nodeFlags, ['--test-name-pattern=tiny']);
});

test('serial runs reuse selection/runtime/overlay but never fixtures', async () => {
  const times = [0, 10, 10, 30, 30, 70, 70, 150];
  const h = harness({ now: () => times.shift() });
  try {
    const result = await benchmark(options, h.dependencies);
    assert.equal(result.status, 'complete');
    assert.equal(result.runs.length, 4);
    assert.equal(result.comparisons.length, 2);
    assert.deepEqual(result.runs.map(run => run.concurrency), [4, 8, 8, 4]);
    assert.deepEqual(result.variants.map(variant => variant.medianWallMs), [45, 30]);
    assert.ok(Math.abs(result.comparisons[1].wallPercentDifference + 100 / 3) < 1e-9);
    assert.equal(result.comparisons[1].suitePercentDifference, 0);
    assert.deepEqual([h.calls.resolve, h.calls.runtime, h.calls.overlay], [1, 1, 1]);
    assert.equal(h.calls.disposed, 4);
    assert.equal(h.calls.overlayDisposed, 1);
    assert.equal(h.calls.abortDisposed, 1);
  } finally { h.cleanup(); }
});

test('invalid plans fail before runtime acquisition', async () => {
  const h = harness();
  try {
    for (const invalid of [{ concurrencyList: [] }, { concurrencyList: [0] }, { repeat: 0 },
      { nodeFlags: ['--test-reporter=dot'] }, { nodeFlags: ['--test-concurrency=2'] }]) {
      await assert.rejects(benchmark({ ...options, ...invalid }, h.dependencies));
    }
    assert.equal(h.calls.runtime, 0);
    assert.equal(h.calls.runs, 0);
  } finally { h.cleanup(); }
});

test('real isolated Node runs produce comparable reports without an SDK build', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pie-benchmark-fixture-'));
  let outputDir;
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
    if (outputDir) rmSync(outputDir, { recursive: true, force: true });
  });
  const file = path.join(directory, 'tiny.test.mjs');
  writeFileSync(file, "import test from 'node:test'; import assert from 'node:assert/strict'; test('tiny', () => assert.equal(2 + 2, 4)); test.skip('skipped', () => {});");
  const result = await benchmark({ ...options, selectors: [file], concurrencyList: [1, 2], repeat: 1 }, {
    resolveTestFiles: () => [file],
    withVerificationRuntime: async (_, signal, run) => run({ sdkPath: '/unused-sdk', identity: 'fixture' }),
    createRunnerTsconfigOverlay: () => null,
    print: text => { if (text.startsWith('Benchmark output: ')) outputDir = text.slice('Benchmark output: '.length); },
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.runs.length, 2);
  for (const run of result.runs) {
    assert.equal(run.counts.passed, 1);
    assert.equal(run.counts.skipped, 1);
    assert.equal(run.timings.files.length, 1);
    assert.equal(run.timings.files[0].file, file);
    assert.ok(run.timings.totalFileDurationMs > 0);
    assert.ok(run.wallMs >= run.summary.durationMs);
  }
  const saved = JSON.parse(readFileSync(path.join(outputDir, 'report.json'), 'utf8'));
  assert.equal(saved.status, 'complete');
  assert.equal(saved.comparisons.length, 2);
});

for (const scenario of ['exit', 'missing', 'malformed', 'accounting', 'counts', 'cancel', 'uncertain', 'unconfirmed-result']) {
  test(`stops immediately on ${scenario}`, async () => {
    let runs = 0;
    const controller = new AbortController();
    const h = harness({
      abortOnProcessSignals: () => ({ signal: controller.signal, dispose() { h.calls.abortDisposed++; } }),
      runNodeTests: async () => {
        runs++;
        if (scenario === 'uncertain') throw Object.assign(new Error('uncertain'), { teardownUnconfirmed: true });
        if (scenario === 'cancel') controller.abort(new Error('cancelled'));
        return { code: scenario === 'exit' ? 1 : 0, teardownConfirmed: scenario !== 'unconfirmed-result' };
      },
      readBenchmarkReport: () => {
        if (scenario === 'missing') throw new Error('missing summary');
        const report = good();
        if (scenario === 'malformed') report.summary.counts.tests = NaN;
        if (scenario === 'accounting') report.fileAccounting.executedFiles = [];
        if (scenario === 'counts' && runs === 2) report.summary.counts.tests++;
        return report;
      },
    });
    try {
      const uncertain = scenario === 'uncertain' || scenario === 'unconfirmed-result';
      await assert.rejects(benchmark(options, h.dependencies), error => {
        if (uncertain) { assert.equal(error.teardownUnconfirmed, true); assert.equal(error.code, 125); }
        return true;
      });
      assert.equal(runs, scenario === 'counts' ? 2 : 1);
      assert.equal(h.calls.disposed, uncertain ? 0 : runs);
      assert.equal(h.calls.overlayDisposed, uncertain ? 0 : 1);
      assert.equal(h.calls.abortDisposed, uncertain ? 0 : 1);
      const saved = JSON.parse(readFileSync(path.join(h.outputDir, 'report.json'), 'utf8'));
      assert.equal(saved.status, 'failed');
      assert.deepEqual(saved.comparisons, []);
    } finally { h.cleanup(); }
  });
}
