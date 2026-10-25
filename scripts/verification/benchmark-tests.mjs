#!/usr/bin/env node
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { parseArgs, resolveTestFiles, resolveTsconfigPath, createRunnerTsconfigOverlay,
  createTestEnvironment, runNodeTests, parseNodeTestFlags, assertCoverageQualification,
  TEST_TEARDOWN_UNCONFIRMED_EXIT_CODE } from './test-node.mjs';
import { extractRuntimeArgs, withVerificationRuntime } from './verification-runtime.mjs';
import { abortOnProcessSignals } from '../lib/process-watchdog.mjs';
import { REPORT_PREFIX, TEST_FILE_ACCOUNTING_ENV, accountTestFiles } from './test-reporter.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const reporterPath = fileURLToPath(new URL('./test-reporter.mjs', import.meta.url));

function validateSettings({ sdkPath, concurrencyList, repeat, nodeFlags }) {
  if (sdkPath !== undefined) throw new Error('Use --pi-runtime, not --sdk-path.');
  if (!Array.isArray(concurrencyList) || concurrencyList.length === 0
    || concurrencyList.some(n => !Number.isSafeInteger(n) || n < 1)) throw new Error('Invalid --concurrency-list');
  if (!Number.isSafeInteger(repeat) || repeat < 1) throw new Error('Invalid --repeat');
  if (nodeFlags.some(flag => /^--test-(?:concurrency|reporter(?:-destination)?)(?:=|$)/u.test(flag))) {
    throw new Error('Benchmark owns concurrency and reporter flags.');
  }
  parseNodeTestFlags(nodeFlags);
}

export function parseBenchmarkArgs(argv) {
  const { args, artifactDir } = extractRuntimeArgs(argv);
  if (!artifactDir) throw new Error('--pi-runtime <absolute verified artifact> is required; no implicit build.');
  const forwarded = [];
  let concurrencyList = [4, 8];
  let repeat = 1;
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') { forwarded.push(...args.slice(index)); break; }
    const name = arg.split('=')[0];
    if (name !== '--concurrency-list' && name !== '--repeat') { forwarded.push(arg); continue; }
    if (seen.has(name)) throw new Error(`${name} may be specified only once.`);
    seen.add(name);
    const value = arg.includes('=') ? arg.slice(name.length + 1) : args[++index];
    if (!value || !/^\d+(?:,\d+)*$/u.test(value)) throw new Error(`Invalid ${name}`);
    const numbers = value.split(',').map(Number);
    if (numbers.some(n => !Number.isSafeInteger(n) || n < 1)) throw new Error(`Invalid ${name}`);
    if (name === '--repeat') {
      if (numbers.length !== 1) throw new Error('Invalid --repeat');
      repeat = numbers[0];
    } else concurrencyList = [...new Set(numbers)];
  }
  const parsed = parseArgs(forwarded);
  const result = { ...parsed, artifactDir, concurrencyList, repeat };
  validateSettings(result);
  return result;
}

export function readBenchmarkReport(rawPath) {
  const prefix = REPORT_PREFIX;
  const lines = readFileSync(rawPath, 'utf8').split(/\r?\n/u).filter(line => line.startsWith(prefix));
  if (lines.length !== 1) throw new Error('Missing or ambiguous reporter summary.');
  return JSON.parse(lines[0].slice(prefix.length));
}

function validateReport(report, files) {
  const summary = report?.summary;
  const counts = summary?.counts;
  if (!summary || !counts || !Number.isFinite(summary.durationMs) || summary.durationMs < 0
    || ['tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo', 'suites', 'topLevel']
      .some(key => !Number.isSafeInteger(counts[key]) || counts[key] < 0)) {
    throw new Error('Malformed reporter summary.');
  }
  if (summary.success !== true || counts.failed !== 0 || counts.cancelled !== 0) throw new Error('Tests failed or were cancelled.');
  const accounting = report.fileAccounting;
  const actual = accounting?.executedFiles;
  if (accounting?.success !== true || !Array.isArray(actual)
    || !accountTestFiles(files, actual).success) throw new Error('Incomplete selected-file accounting.');
  const timings = accounting.timings;
  if (!timings || !Array.isArray(timings.files)
    || !accountTestFiles(files, timings.files.map(item => item.file)).success
    || timings.files.some(item => item.passed !== true || !Number.isFinite(item.durationMs) || item.durationMs < 0)
    || !Number.isFinite(timings.totalFileDurationMs) || timings.totalFileDurationMs < 0
    || !Number.isFinite(timings.reportedTestDurationMs) || timings.reportedTestDurationMs < 0) {
    throw new Error('Missing or malformed file timings.');
  }
  return counts;
}

/** Serial orchestration only: Node's existing runner owns all scheduling. */
export async function benchmark(options, dependencies = {}) {
  options = { nodeFlags: [], ...options };
  validateSettings(options);
  const d = { resolveTestFiles, resolveTsconfigPath, createRunnerTsconfigOverlay, createTestEnvironment,
    runNodeTests, withVerificationRuntime, abortOnProcessSignals, readBenchmarkReport,
    now: () => performance.now(), freeMemory: () => os.freemem(), print: console.log, ...dependencies };
  const outputDir = mkdtempSync(path.join(os.tmpdir(), 'pie-test-benchmark-'));
  d.print(`Benchmark output: ${outputDir}`);
  const reportPath = path.join(outputDir, 'report.json');
  const report = { schemaVersion: 1, status: 'running', outputDir,
    startedAt: new Date().toISOString(),
    machine: { nodeVersion: process.version, coreCount: os.availableParallelism(), totalMemory: os.totalmem() },
    selection: { selectors: options.selectors, includeGlobs: options.includeGlobs, excludeGlobs: options.excludeGlobs,
      nodeFlags: options.nodeFlags, concurrencyList: options.concurrencyList, repeat: options.repeat }, runs: [], comparisons: [] };
  const save = () => writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  save();
  const abort = d.abortOnProcessSignals();
  let overlay;
  let uncertain = false;
  try {
    if (!options.artifactDir || !path.isAbsolute(options.artifactDir)) throw new Error('Explicit absolute pi-runtime required.');
    const files = Object.freeze([...d.resolveTestFiles(root, options.selectors, options)]);
    assertCoverageQualification(files, options.nodeFlags);
    const tsconfigPath = options.tsconfig === undefined ? undefined : d.resolveTsconfigPath(root, options.tsconfig);
    report.files = files;
    const accountingPath = path.join(outputDir, 'accounting.json');
    writeFileSync(accountingPath, JSON.stringify({ expectedFiles: files, collectTimings: true }));
    await d.withVerificationRuntime({ artifactDir: options.artifactDir }, abort.signal, async runtime => {
      report.sdk = { artifactDir: runtime.artifactDir, sdkPath: runtime.sdkPath, identity: runtime.identity };
      overlay = d.createRunnerTsconfigOverlay(root, {
        sdkPath: runtime.sdkPath,
        ...(tsconfigPath === undefined ? {} : { tsconfigPath }),
      });
      let baseline;
      for (let repetition = 1; repetition <= options.repeat; repetition++) {
        const variants = [...new Set(options.concurrencyList)];
        if (repetition % 2 === 0) variants.reverse();
        for (const concurrency of variants) {
          abort.signal.throwIfAborted();
          const fixture = d.createTestEnvironment();
          const run = { concurrency, repetition, rawPath: path.join(outputDir, `run-${report.runs.length + 1}.txt`),
            freeMemoryBefore: d.freeMemory(), status: 'running' };
          report.runs.push(run);
          save();
          const start = d.now();
          try {
            const result = await d.runNodeTests(files, { signal: abort.signal, sdkPath: runtime.sdkPath,
              env: { ...fixture.env, ...(overlay ? { TSX_TSCONFIG_PATH: overlay.configPath } : {}),
                [TEST_FILE_ACCOUNTING_ENV]: accountingPath },
              nodeFlags: [...options.nodeFlags, `--test-concurrency=${concurrency}`,
                `--test-reporter=${reporterPath}`, `--test-reporter-destination=${run.rawPath}`] });
            run.wallMs = d.now() - start;
            run.code = result?.code;
            if (result?.teardownConfirmed !== true) throw Object.assign(new Error('Test teardown unconfirmed.'), { teardownUnconfirmed: true });
            abort.signal.throwIfAborted();
            const parsed = d.readBenchmarkReport(run.rawPath);
            Object.assign(run, { summary: parsed.summary, counts: parsed.summary?.counts,
              failures: parsed.failures, fileAccounting: parsed.fileAccounting, timings: parsed.fileAccounting?.timings });
            if (result.code !== 0) throw new Error(`Tests exited with code ${result.code}.`);
            const counts = validateReport(parsed, files);
            if (baseline && Object.keys(counts).some(key => counts[key] !== baseline.counts[key])) throw new Error('Test counts differ between runs.');
            run.status = 'complete';
            if (!baseline) baseline = run;
            d.print(`Concurrency ${concurrency}, round ${repetition}: wall ${run.wallMs.toFixed(1)}ms, suite ${run.summary.durationMs.toFixed(1)}ms`);
          } catch (error) {
            run.wallMs ??= d.now() - start;
            run.status = 'failed';
            run.error = error.message;
            if (error.teardownUnconfirmed === true) {
              uncertain = true;
              run.retainedFixture = fixture.root;
              throw Object.assign(error, { code: TEST_TEARDOWN_UNCONFIRMED_EXIT_CODE });
            }
            throw error;
          } finally {
            if (!uncertain) fixture.dispose();
            save();
          }
        }
      }
    });
    const median = values => {
      const sorted = values.sort((a, b) => a - b), middle = Math.floor(values.length / 2);
      return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    };
    report.variants = [...new Set(options.concurrencyList)].map(concurrency => {
      const runs = report.runs.filter(run => run.concurrency === concurrency);
      return { concurrency, medianWallMs: median(runs.map(run => run.wallMs)), medianSuiteMs: median(runs.map(run => run.summary.durationMs)) };
    });
    const baseline = report.variants[0];
    const difference = (value, base) => base === 0 ? null : (value - base) / base * 100;
    report.comparisons = report.variants.map(variant => ({ concurrency: variant.concurrency, baselineConcurrency: baseline.concurrency,
      wallPercentDifference: difference(variant.medianWallMs, baseline.medianWallMs), suitePercentDifference: difference(variant.medianSuiteMs, baseline.medianSuiteMs) }));
    for (const [index, variant] of report.variants.entries()) {
      const difference = report.comparisons[index].wallPercentDifference;
      const change = difference === null ? 'n/a' : `${difference.toFixed(1)}%`;
      d.print(`Median concurrency ${variant.concurrency}: wall ${(variant.medianWallMs / 1000).toFixed(2)}s, suite ${(variant.medianSuiteMs / 1000).toFixed(2)}s (${change} wall vs ${baseline.concurrency})`);
    }
    report.status = 'complete';
    return report;
  } catch (error) {
    uncertain ||= error.teardownUnconfirmed === true;
    report.status = 'failed';
    report.error = error.message;
    if (uncertain) {
      report.teardownUnconfirmed = true;
      report.retainedOverlay = overlay?.configPath;
      Object.assign(error, { teardownUnconfirmed: true, code: TEST_TEARDOWN_UNCONFIRMED_EXIT_CODE });
    }
    throw error;
  } finally {
    if (!uncertain) {
      overlay?.dispose();
      abort.dispose();
    }
    save();
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    console.log('Usage: test:bench --pi-runtime <absolute artifact> [--concurrency-list 4,8] [--repeat 1] [test:file selection options] <selectors...> [-- Node test flags]\nSerial runs reuse one selection and SDK setup, not test processes. Reports are saved in OS temp. Keep source files unchanged during comparison.');
    return;
  }
  try { await benchmark(parseBenchmarkArgs(argv)); }
  catch (error) { console.error(error.message); process.exitCode = error.teardownUnconfirmed ? TEST_TEARDOWN_UNCONFIRMED_EXIT_CODE : 1; }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
