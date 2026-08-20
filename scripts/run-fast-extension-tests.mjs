#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { withoutPiHarnessEnv } from './lib/pi-harness-env.mjs';

const REPORT_PREFIX = '__PI_TEST_SUMMARY__';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = path.join(repoRoot, 'extension');
const reporterSpecifier = pathToFileURL(path.join(repoRoot, 'scripts', 'test-reporter.mjs')).href;
const extensionRequire = createRequire(path.join(extensionRoot, 'package.json'));

// Child-process entry points and __dirname-dependent modules retain tsx
// isolation. import.meta.url is rewritten to its source URL below, while
// computed imports are bundled but kept out of shared batch wrappers.
const UNSAFE_SOURCE = /node:child_process|node:worker_threads|__dirname|\binstallDom\s*\(|(?:\bfrom\s*|\bimport\s*)['"]preact(?:\/|['"])/u;
const UNSAFE_BUNDLE_ENTRIES = new Set([
  'test/backend/runtime/extension-ui-bridge.test.ts',
  'test/host/core/lifecycle/pinned-tab-groups.test.ts',
  'test/shared/utilities/tab-behavior.test.ts',
  'test/webview/components/ui-loading-states.test.ts',
  'test/webview/transcript/tools/registry.test.ts',
]);
const UNSAFE_BATCH_ENTRIES = new Set([
  'test/host/core/lifecycle/pinned-tab-groups.test.ts',
  'test/webview/file-changes/file-changes-panel.test.ts',
  'test/webview/transcript/activity/turn-activity-region.test.ts',
]);
const SAFE_BATCH_ENTRIES = new Set([
  'test/host/core/architecture/arch-arrival-order.test.ts',
  'test/host/core/lifecycle/persist-tabs-via-command.test.ts',
  'test/webview/transcript/activity/streaming-without-overlay.test.ts',
  'test/webview/transcript/tools/ask-user-tool-render.test.ts',
  'test/webview/transcript/tools/tool-call-heading-css.test.ts',
  'test/webview/transcript/tools/web-search-tool-render.test.ts',
]);
const UNSAFE_BATCH_SOURCE = /\bimport\s*\(|process\.env|mock\.|\b(?:test\.)?(?:before|after|beforeEach|afterEach)\s*\(|(?:globalThis|window|document)[^\n]{0,80}=|Object\.(?:assign|defineProperty)\s*\(\s*(?:globalThis|window|document)|delete\s+(?:globalThis|window|document)/u;
const UNSAFE_SCOPED_BATCH_ENTRIES = new Set([
  'test/webview/composer/composer-draft.test.ts',
  'test/webview/transcript/messages/markdown-rendering.test.ts',
  'test/webview/transcript/messages/transcript-host-commit.test.ts',
]);
const UNSAFE_SCOPED_BATCH_SOURCE = /\bModule\.(?:register|_load)|\bmodule\.register|\bimport\s*\(/u;

async function walkTestFiles(relativeDir, output) {
  const absoluteDir = path.join(extensionRoot, relativeDir);
  for (const entry of await readdir(absoluteDir, { withFileTypes: true })) {
    const relativePath = path.posix.join(relativeDir.replace(/\\/gu, '/'), entry.name);
    if (entry.isDirectory()) await walkTestFiles(relativePath, output);
    else if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) output.push(relativePath);
  }
}

export function isBundleSafeTest(relativePath, source) {
  return !UNSAFE_BUNDLE_ENTRIES.has(relativePath.replace(/\\/gu, '/')) && !UNSAFE_SOURCE.test(source);
}

export function classifyExtensionTest(relativePath, source) {
  const normalizedPath = relativePath.replace(/\\/gu, '/');
  if (!isBundleSafeTest(normalizedPath, source)) return 'tsx';
  if (UNSAFE_SCOPED_BATCH_ENTRIES.has(normalizedPath)
    || (!SAFE_BATCH_ENTRIES.has(normalizedPath) && UNSAFE_SCOPED_BATCH_SOURCE.test(source))) return 'bundle';
  if (!UNSAFE_BATCH_ENTRIES.has(normalizedPath)
    && (SAFE_BATCH_ENTRIES.has(normalizedPath) || !UNSAFE_BATCH_SOURCE.test(source))) {
    return 'batch';
  }
  if (!UNSAFE_BATCH_ENTRIES.has(normalizedPath)
    && !UNSAFE_SCOPED_BATCH_ENTRIES.has(normalizedPath)
    && !UNSAFE_SCOPED_BATCH_SOURCE.test(source)) {
    return 'scoped-batch';
  }
  return 'bundle';
}

function parseReport(output) {
  const line = output.split(/\r?\n/u).map((value) => value.trim())
    .filter((value) => value.startsWith(REPORT_PREFIX)).at(-1);
  return line ? JSON.parse(line.slice(REPORT_PREFIX.length)) : null;
}

function run(command, args, cwd, onSpawn = undefined, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: withoutPiHarnessEnv({ ...process.env, FORCE_COLOR: '0', ...extraEnv }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    onSpawn?.(child);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code: code ?? 1, signal, stdout, stderr }));
  });
}

function emptyCounts() {
  return { tests: 0, failed: 0, passed: 0, cancelled: 0, skipped: 0, todo: 0, topLevel: 0, suites: 0 };
}

function stableBucketIndex(file, bucketCount) {
  let hash = 2166136261;
  for (let index = 0; index < file.length; index += 1) {
    hash ^= file.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % bucketCount;
}

function mergeReports(results, durationMs) {
  const counts = emptyCounts();
  const failures = [];
  let success = true;
  for (const result of results) {
    const report = parseReport(`${result.stdout}\n${result.stderr}`);
    if (!report || result.code !== 0 || result.signal !== null) success = false;
    for (const key of Object.keys(counts)) counts[key] += report?.summary?.counts?.[key] ?? 0;
    failures.push(...(report?.failures ?? []));
    if (!report) {
      failures.push({
        name: 'fast extension test subprocess failed without a summary',
        message: `${result.stderr || result.stdout}`.trim().split(/\r?\n/u).slice(-20).join('\n'),
      });
    }
  }
  if (counts.failed > 0 || counts.cancelled > 0 || failures.length > 0) success = false;
  return { summary: { success, counts, durationMs }, coverage: null, failures };
}

async function main() {
  const startedAt = performance.now();
  const testFiles = [];
  await walkTestFiles('test', testFiles);
  testFiles.sort();

  const safe = [];
  const unsafe = [];
  const batchable = new Set();
  const scopedBatchable = new Set();
  for (const relativePath of testFiles) {
    const source = await readFile(path.join(extensionRoot, relativePath), 'utf8');
    const classification = classifyExtensionTest(relativePath, source);
    if (classification === 'tsx') {
      unsafe.push(relativePath);
      continue;
    }
    safe.push(relativePath);
    if (classification === 'batch') batchable.add(relativePath);
    else if (classification === 'scoped-batch') scopedBatchable.add(relativePath);
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pie-extension-fast-'));
  // Fresh per-wave trace directories: every spawned test process inherits the
  // wave's PIE_LIVE_PIPELINE_TRACE_DIR, so trace-writing tests (writer-trace,
  // diagnostics-trace, request-handler, service-loading-gate) no longer append
  // to the shared canonical %TEMP% file that accumulates across runs and
  // rotates at 2 MiB mid-run — a rotation between a test's before/after read
  // silently lost that test's records and flaked. A fresh dir stays far below
  // the rotation threshold for the whole wave.
  const traceDirs = [
    await mkdtemp(path.join(os.tmpdir(), 'pie-extension-fast-traces-bundled-')),
    await mkdtemp(path.join(os.tmpdir(), 'pie-extension-fast-traces-unsafe-')),
  ];
  let unsafeChild;
  try {
    const tsxCli = path.join(extensionRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const reporterArg = `--test-reporter=${reporterSpecifier}`;
    const bundledArgs = ['--test', '--test-force-exit', '--test-concurrency=32', reporterArg];
    const isolatedArgs = ['--test', '--test-force-exit', '--test-concurrency=16', reporterArg];
    // The small isolated tsx subset can run while esbuild prepares the bundled
    // wave, hiding both compiler and tsx startup latency.
    const unsafeRun = run(
      process.execPath,
      [tsxCli, ...isolatedArgs, ...unsafe],
      extensionRoot,
      (child) => { unsafeChild = child; },
      { PIE_LIVE_PIPELINE_TRACE_DIR: traceDirs[1] },
    );

    const { build } = extensionRequire('esbuild');
    const preserveSourceUrls = {
      name: 'preserve-source-urls',
      setup(esbuild) {
        esbuild.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path: sourcePath }) => {
          const source = await readFile(sourcePath, 'utf8');
          return {
            contents: source.replace(/import\.meta\.url/gu, JSON.stringify(pathToFileURL(sourcePath).href)),
            loader: sourcePath.endsWith('.tsx') ? 'tsx'
              : sourcePath.endsWith('.jsx') ? 'jsx'
                : /\.[cm]?ts$/u.test(sourcePath) ? 'ts'
                  : 'js',
          };
        });
      },
    };
    await build({
      entryPoints: safe.map((file) => path.join(extensionRoot, file)),
      outdir: tempDir,
      outbase: extensionRoot,
      entryNames: '[dir]/[name]',
      bundle: true,
      format: 'cjs',
      platform: 'node',
      packages: 'external',
      plugins: [preserveSourceUrls],
      // A bundled test is the process entry point. Disable application entry
      // guards so imported backend modules do not start the real server.
      define: { 'require.main': 'undefined' },
      logLevel: 'silent',
    });
    await symlink(path.join(extensionRoot, 'node_modules'), path.join(tempDir, 'node_modules'), 'junction');

    const standaloneBundles = safe
      .filter((file) => !batchable.has(file) && !scopedBatchable.has(file))
      .map((file) => path.join(tempDir, file.replace(/\.tsx?$/u, '.js')));
    const batchBuckets = Array.from({ length: 10 }, () => []);
    for (const file of batchable) {
      batchBuckets[stableBucketIndex(file, batchBuckets.length)]
        .push(path.join(tempDir, file.replace(/\.tsx?$/u, '.js')));
    }
    const batchFiles = await Promise.all(batchBuckets.map(async (files, index) => {
      const batchPath = path.join(tempDir, `bundle-batch-${index}.mjs`);
      const suites = files.map((file) =>
        `describe(${JSON.stringify(file)}, { concurrency: false }, async () => { await import(${JSON.stringify(pathToFileURL(file).href)}); });`);
      await writeFile(batchPath, `import { describe } from 'node:test';\n${suites.join('\n')}`, 'utf8');
      return batchPath;
    }));
    const scopedBuckets = Array.from({ length: 10 }, () => []);
    for (const file of scopedBatchable) {
      scopedBuckets[stableBucketIndex(file, scopedBuckets.length)]
        .push(path.join(tempDir, file.replace(/\.tsx?$/u, '.js')));
    }
    const scopedBatchFiles = await Promise.all(scopedBuckets.map(async (files, index) => {
      const batchPath = path.join(tempDir, `scoped-bundle-batch-${index}.mjs`);
      const suites = files.map((file) =>
        `describe(${JSON.stringify(file)}, { concurrency: false }, async () => { await import(${JSON.stringify(pathToFileURL(file).href)}); });`);
      await writeFile(batchPath, `import { describe } from 'node:test';\n${suites.join('\n')}`, 'utf8');
      return batchPath;
    }));
    const bundledFiles = [...standaloneBundles, ...batchFiles, ...scopedBatchFiles];
    const results = await Promise.all([
      run(process.execPath, [...bundledArgs, ...bundledFiles], extensionRoot, undefined, { PIE_LIVE_PIPELINE_TRACE_DIR: traceDirs[0] }),
      unsafeRun,
    ]);
    const report = mergeReports(results, performance.now() - startedAt);
    process.stdout.write(`${REPORT_PREFIX}${JSON.stringify(report)}\n`);
    if (!report.summary.success) process.exitCode = 1;
  } finally {
    if (unsafeChild?.exitCode === null && unsafeChild?.signalCode === null) unsafeChild.kill();
    await rm(tempDir, { recursive: true, force: true });
    await Promise.all(traceDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  }
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) await main();
