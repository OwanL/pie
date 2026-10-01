#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { withoutPiHarnessEnv } from '../lib/pi-harness-env.mjs';
import { isProtectedDirectoryName } from '../lib/traversal-policy.mjs';
import {
  PACKAGE_REGISTRY,
  ROOT_BATCH_PACKAGE_IDS,
  fastBatchMetadata,
  packageOptionalTestRoots,
  packageTestFiles,
  packageTestRoots,
  resolvePackageEntry,
} from '../lib/test-packages.mjs';
import { createTsconfigOverlay } from '../lib/package-resolution.mjs';
import {
  accountTestFiles,
  normalizeTestFileIdentity,
  summarizeTestFileAccounting,
  TEST_FILE_ACCOUNTING_ENV,
  TEST_FILE_MARKER,
} from './test-reporter.mjs';

import { extractRuntimeArgs, verificationChildEnv, withVerificationRuntime } from './verification-runtime.mjs';
import { abortOnProcessSignals, watchChildProcess, withProcessTreeIsolation, resolveChildProcessTimeoutMs } from '../lib/process-watchdog.mjs';

const REPORT_PREFIX = '__PI_TEST_SUMMARY__';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const reporter = pathToFileURL(path.join(repoRoot, 'scripts', 'verification', 'test-reporter.mjs')).href;
// The root fast-batch composition is registry-derived: every package that runs
// from the repo root, needs no tsx path aliases, and has no dedicated batch mode.
// All routed test roots are walked (de-duplicated); missing roots fail unless
// the registry explicitly marks them as planned and optional.
export const rootBatchDirs = [...new Set(ROOT_BATCH_PACKAGE_IDS
  .flatMap((id) => packageTestRoots(resolvePackageEntry(id))))];
const rootBatchOptionalDirs = [...new Set(ROOT_BATCH_PACKAGE_IDS
  .flatMap((id) => packageOptionalTestRoots(resolvePackageEntry(id))))];
export const rootBatchFiles = [...new Set(ROOT_BATCH_PACKAGE_IDS
  .flatMap((id) => packageTestFiles(resolvePackageEntry(id))))];

/** Per-mode fast-batch plans, registry-derived (mode name = package id). */
export const fastBatchDefinitions = Object.fromEntries(PACKAGE_REGISTRY
  .map((entry) => [entry.id, fastBatchMetadata(entry)])
  .filter(([, metadata]) => metadata !== null)
  .map(([id, metadata]) => [id, {
    cwd: metadata.testCwd ? path.join(repoRoot, metadata.testCwd) : repoRoot,
    dir: metadata.testDir,
    dirs: metadata.testDirs,
    files: metadata.testFiles,
    optionalDirs: metadata.optionalTestDirs,
    batches: metadata.batches,
    tsxConfig: metadata.tsxConfig,
  }]));

async function walk(directory, extensions, output) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && isProtectedDirectoryName(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(absolutePath, extensions, output);
    else if (extensions.some((suffix) => entry.name.endsWith(suffix))) output.push(absolutePath);
  }
}

async function writeBatch(tempDir, index, files) {
  const suites = files.map((file) =>
    `describe(${JSON.stringify(`${TEST_FILE_MARKER}${path.resolve(file)}`)}, { concurrency: false }, async () => { await import(${JSON.stringify(pathToFileURL(file).href)}); });`);
  const batchPath = path.join(tempDir, `batch-${index}.mts`);
  await writeFile(batchPath, `import { describe } from 'node:test';\n${suites.join('\n')}`, 'utf8');
  return batchPath;
}

function run(command, args, cwd, extraEnv = {}, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, withProcessTreeIsolation({
      cwd,
      env: verificationChildEnv(withoutPiHarnessEnv({ ...process.env, FORCE_COLOR: '0', ...extraEnv })),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }));
    const watchdog = watchChildProcess(child, { signal, timeoutMs: resolveChildProcessTimeoutMs(), label: 'fast batch tests' });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', async (error) => {
      const cleanup = await watchdog.settle().catch(() => ({ gone: false }));
      if (!cleanup.gone) error.teardownUnconfirmed = true;
      reject(error);
    });
    child.on('close', async (code, closeSignal) => {
      const cleanup = await watchdog.settle().catch(() => ({ gone: false }));
      if (!cleanup.gone) {
        reject(Object.assign(new Error('Batch test tree teardown is unconfirmed'), { teardownUnconfirmed: true }));
        return;
      }
      resolve({ code: watchdog.timedOut || watchdog.aborted ? 1 : (code ?? 1), signal: closeSignal, stdout, stderr });
    });
  });
}

function parseReport(result) {
  const line = `${result.stdout}\n${result.stderr}`.split(/\r?\n/u)
    .map((value) => value.trim()).filter((value) => value.startsWith(REPORT_PREFIX)).at(-1);
  return line ? JSON.parse(line.slice(REPORT_PREFIX.length)) : null;
}

function merge(results, durationMs, enumeratedFiles, intentionalReruns = []) {
  const counts = { tests: 0, failed: 0, passed: 0, cancelled: 0, skipped: 0, todo: 0, topLevel: 0, suites: 0 };
  const failures = [];
  const executedFiles = [];
  let success = true;
  for (const result of results) {
    const report = parseReport(result);
    if (!report || result.code !== 0 || result.signal !== null) success = false;
    for (const key of Object.keys(counts)) counts[key] += report?.summary?.counts?.[key] ?? 0;
    failures.push(...(report?.failures ?? []));
    if (Array.isArray(report?.fileAccounting?.executedFiles)) executedFiles.push(...report.fileAccounting.executedFiles);
    else success = false;
    if (report?.fileAccounting && !report.fileAccounting.success) success = false;
    if (!report) failures.push({ name: 'batched test subprocess failed', message: (result.stderr || result.stdout).trim() });
  }
  const fileAccounting = accountTestFiles(enumeratedFiles, executedFiles, intentionalReruns);
  if (!fileAccounting.success) {
    success = false;
    failures.push({
      name: 'aggregate test-file accounting mismatch',
      message: JSON.stringify(summarizeTestFileAccounting(fileAccounting)),
    });
  }
  if (counts.failed > 0 || counts.cancelled > 0 || failures.length > 0) success = false;
  return {
    summary: { success, counts, durationMs },
    coverage: null,
    failures,
    fileAccounting: summarizeTestFileAccounting(fileAccounting),
  };
}

async function writeAccountingContext(tempDir, name, expectedFiles, directFiles = [], ignoredFiles = []) {
  const contextPath = path.join(tempDir, `file-accounting-${name}.json`);
  const directFileMap = Object.fromEntries(directFiles.map((file) => [
    normalizeTestFileIdentity(file), path.resolve(file),
  ]));
  await writeFile(contextPath, JSON.stringify({
    expectedFiles: expectedFiles.map((file) => path.resolve(file)),
    directFiles: directFileMap,
    ignoredFiles: ignoredFiles.map((file) => path.resolve(file)),
    intentionalReruns: [],
  }), 'utf8');
  return contextPath;
}

export function resolveExistingBatchRoots(relativeDirs, optionalDirs, root = repoRoot, directoryExists = existsSync) {
  const optional = new Set(optionalDirs);
  return relativeDirs.filter((relativeDir) => {
    if (directoryExists(path.join(root, relativeDir))) return true;
    if (optional.has(relativeDir)) return false;
    throw new Error(`Required fast-batch test root is missing: ${relativeDir}`);
  });
}

async function buildPlan(mode, tempDir) {
  if (mode === 'root') {
    const batches = [];
    const enumerated = new Set();
    const presentDirs = resolveExistingBatchRoots(rootBatchDirs, rootBatchOptionalDirs);
    for (const [index, relativeDir] of presentDirs.entries()) {
      const discovered = [];
      await walk(path.join(repoRoot, relativeDir), ['.test.ts', '.test.mjs'], discovered);
      const files = discovered.filter((file) => {
        if (enumerated.has(normalizeTestFileIdentity(file))) return false;
        enumerated.add(normalizeTestFileIdentity(file));
        return true;
      }).sort();
      batches.push(await writeBatch(tempDir, index, files));
    }
    const explicitFiles = rootBatchFiles.map((file) => path.join(repoRoot, file));
    for (const file of explicitFiles) {
      if (!existsSync(file)) throw new Error(`Required fast-batch test file is missing: ${path.relative(repoRoot, file)}`);
      enumerated.add(normalizeTestFileIdentity(file));
    }
    if (explicitFiles.length > 0) batches.push(await writeBatch(tempDir, batches.length, explicitFiles));
    return {
      cwd: repoRoot,
      batches,
      tsxConfig: null,
      forceExitFiles: [],
      directFiles: [],
      expectedFiles: [...enumerated].sort(),
    };
  }

  const definition = fastBatchDefinitions[mode];
  if (!definition) throw new Error(`Unknown fast batch mode: ${mode}`);
  const files = [];
  const enumerated = new Set();
  const presentDirs = resolveExistingBatchRoots(definition.dirs, definition.optionalDirs);
  for (const relativeDir of presentDirs) {
    const discovered = [];
    await walk(path.join(repoRoot, relativeDir), ['.test.ts'], discovered);
    for (const file of discovered) {
      const identity = normalizeTestFileIdentity(file);
      if (enumerated.has(identity)) continue;
      enumerated.add(identity);
      files.push(file);
    }
  }
  for (const relativeFile of definition.files) {
    const file = path.join(repoRoot, relativeFile);
    if (!existsSync(file)) throw new Error(`Required fast-batch test file is missing: ${relativeFile}`);
    const identity = normalizeTestFileIdentity(file);
    if (enumerated.has(identity)) continue;
    enumerated.add(identity);
    files.push(file);
  }
  files.sort();

  let ordinary = files;
  let individual = [];
  let forceExitFiles = [];
  if (mode === 'subagent') {
    forceExitFiles = files.filter((file) => file.endsWith(`${path.sep}preflight-abort.test.ts`));
    individual = [];
    ordinary = [];
    for (const file of files) {
      if (forceExitFiles.includes(file)) continue;
      const source = await readFile(file, 'utf8');
      (/\bModule\.register|\bmodule\.register/u.test(source) ? individual : ordinary).push(file);
    }
  }

  const buckets = Array.from({ length: definition.batches }, () => []);
  ordinary.forEach((file, index) => buckets[index % buckets.length].push(file));
  const batches = await Promise.all(buckets.map((bucket, index) => writeBatch(tempDir, index, bucket)));
  return {
    cwd: definition.cwd,
    batches: [...batches, ...individual],
    tsxConfig: definition.tsxConfig,
    forceExitFiles,
    directFiles: individual,
    expectedFiles: files,
  };
}

export function parseFastBatchArgs(argv) {
  const [mode, ...runnerArgs] = argv;
  let testConcurrency;
  for (let index = 0; index < runnerArgs.length; index += 1) {
    const arg = runnerArgs[index];
    if (arg === '--test-concurrency') {
      const value = runnerArgs[index + 1];
      if (!value) throw new Error('--test-concurrency requires a positive integer');
      testConcurrency = Number(value);
      index += 1;
    } else if (arg.startsWith('--test-concurrency=')) {
      testConcurrency = Number(arg.slice('--test-concurrency='.length));
    } else {
      throw new Error(`Unknown fast-batch argument: ${arg}`);
    }
    if (!Number.isInteger(testConcurrency) || testConcurrency < 1) {
      throw new Error('--test-concurrency requires a positive integer');
    }
  }
  return { mode, testConcurrency };
}

export async function runSuite({ mode, testConcurrency }, runtime, signal, dependencies = {}) {
  if (!mode) throw new Error('Usage: run-fast-batched-tests.mjs <root|analysis|subagent|computer-use|playwright> [--test-concurrency <n>]');
  const startedAt = performance.now();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), `pie-${mode}-tests-`));
  const runs = [];
  let failed = false;
  let firstError;
  let teardownUnconfirmed = false;
  const launch = (...args) => {
    // Observe failure immediately without unwinding while a sibling is alive.
    runs.push(Promise.resolve().then(() => (dependencies.run ?? run)(...args)).then(
      (result) => result,
      (error) => {
        if (!failed) firstError = error;
        failed = true;
        teardownUnconfirmed ||= error?.teardownUnconfirmed === true;
      },
    ));
  };
  try {
    const plan = await (dependencies.buildPlan ?? buildPlan)(mode, tempDir);
    // Registry-declared tsx configs run through a generated overlay (owner-
    // relative aliases extending the checked-in base config) written into the
    // same temp directory the batch files already live in; main() removes it.
    const tsxOverlay = (dependencies.createTsconfigOverlay ?? createTsconfigOverlay)(path.join(repoRoot, plan.tsxConfig ?? 'application/hosts/vscode/tsconfig.json'), {
      directory: tempDir, sdkPath: runtime.sdkPath,
    });
    const tsxCli = path.join(plan.cwd, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const configArgs = tsxOverlay ? [`--tsconfig=${tsxOverlay.configPath}`] : [];
    const common = [tsxCli, '--test', ...configArgs, `--test-reporter=${reporter}`];
    const forced = new Set(plan.forceExitFiles.map(normalizeTestFileIdentity));
    const primaryExpectedFiles = plan.expectedFiles.filter((file) => !forced.has(normalizeTestFileIdentity(file)));
    const directFileIdentities = new Set(plan.directFiles.map(normalizeTestFileIdentity));
    const primaryWrappers = plan.batches.filter((file) => !directFileIdentities.has(normalizeTestFileIdentity(file)));
    const primaryContext = await writeAccountingContext(
      tempDir,
      'primary',
      primaryExpectedFiles,
      plan.directFiles,
      primaryWrappers,
    );
    // Prepare both contexts before launching either child.
    const forceExitContext = plan.forceExitFiles.length > 0
      ? await writeAccountingContext(tempDir, 'force-exit', plan.forceExitFiles, plan.forceExitFiles)
      : null;
    launch(
      process.execPath,
      [...common, `--test-concurrency=${Math.min(testConcurrency ?? plan.batches.length, plan.batches.length)}`, ...plan.batches],
      plan.cwd,
      { [TEST_FILE_ACCOUNTING_ENV]: primaryContext, TSX_TSCONFIG_PATH: tsxOverlay.configPath }, signal,
    );
    if (plan.forceExitFiles.length > 0) {
      launch(
        process.execPath,
        [...common, '--test-force-exit', ...plan.forceExitFiles],
        plan.cwd,
        { [TEST_FILE_ACCOUNTING_ENV]: forceExitContext, TSX_TSCONFIG_PATH: tsxOverlay.configPath }, signal,
      );
    }
    const results = await Promise.all(runs);
    if (failed) {
      if (teardownUnconfirmed) {
        firstError = Object.assign(new Error(String(firstError?.message ?? firstError), { cause: firstError }), { teardownUnconfirmed: true });
      }
      throw firstError;
    }
    const report = merge(results, performance.now() - startedAt, plan.expectedFiles);
    process.stdout.write(`${REPORT_PREFIX}${JSON.stringify(report)}\n`);
    if (!report.summary.success) process.exitCode = 1;
  } finally {
    // Also drain on setup/dispatch errors. Unknown tree state retains all
    // batch/config/accounting files, just as runtime selection retains artifacts.
    await Promise.all(runs);
    if (!teardownUnconfirmed) await rm(tempDir, { recursive: true, force: true });
  }
}

// Only run main() when invoked directly, so registry-derived exports can be
// unit-tested (drift check) via `import` without side effects.
const invokedDirectly = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  const abort = abortOnProcessSignals();
  let teardownUnconfirmed = false;
  try {
    const selection = extractRuntimeArgs(process.argv.slice(2));
    if (selection.args.some((arg) => ['--help', '-h', '--list'].includes(arg))) {
      console.log('Usage: run-fast-batched-tests.mjs <mode> [--pi-runtime <absolute artifact root>]');
    } else {
      const args = parseFastBatchArgs(selection.args);
      if (!args.mode) throw new Error('A fast batch mode is required');
      await withVerificationRuntime(selection, abort.signal, (runtime) => runSuite(args, runtime, abort.signal));
    }
  } catch (error) {
    teardownUnconfirmed = error?.teardownUnconfirmed === true;
    console.error(error.message);
    process.exitCode = 1;
  } finally { if (!teardownUnconfirmed) abort.dispose(); }
}
