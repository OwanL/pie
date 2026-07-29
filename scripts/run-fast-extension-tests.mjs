#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPORT_PREFIX = '__PI_TEST_SUMMARY__';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = path.join(repoRoot, 'extension');
const reporterSpecifier = pathToFileURL(path.join(repoRoot, 'scripts', 'test-reporter.mjs')).href;
const extensionRequire = createRequire(path.join(extensionRoot, 'package.json'));

// Computed imports, child-process entry points, and __dirname-dependent modules
// retain tsx isolation. import.meta.url is rewritten to its source URL below,
// so ordinary filesystem fixture tests remain safe to bundle.
const UNSAFE_SOURCE = /node:child_process|node:worker_threads|__dirname|\bimport\s*\(/u;
const UNSAFE_BUNDLE_ENTRIES = new Set([
  'test/backend/runtime/extension-ui-bridge.test.ts',
  'test/host/core/lifecycle/pinned-tab-groups.test.ts',
  'test/shared/utilities/tab-behavior.test.ts',
]);
const UNSAFE_BATCH_ENTRIES = new Set([
  'test/host/core/lifecycle/pinned-tab-groups.test.ts',
  'test/webview/file-changes/file-changes-panel.test.ts',
  'test/webview/transcript/activity/turn-activity-region.test.ts',
]);
const UNSAFE_BATCH_SOURCE = /process\.env|mock\.|\b(?:test\.)?(?:before|after|beforeEach|afterEach)\s*\(|(?:globalThis|window|document)[^\n]{0,80}=|Object\.(?:assign|defineProperty)\s*\(\s*(?:globalThis|window|document)|delete\s+(?:globalThis|window|document)/u;

async function walkTestFiles(relativeDir, output) {
  const absoluteDir = path.join(extensionRoot, relativeDir);
  for (const entry of await readdir(absoluteDir, { withFileTypes: true })) {
    const relativePath = path.posix.join(relativeDir.replace(/\\/gu, '/'), entry.name);
    if (entry.isDirectory()) await walkTestFiles(relativePath, output);
    else if (entry.name.endsWith('.test.ts')) output.push(relativePath);
  }
}

export function isBundleSafeTest(relativePath, source) {
  return !UNSAFE_BUNDLE_ENTRIES.has(relativePath.replace(/\\/gu, '/')) && !UNSAFE_SOURCE.test(source);
}

function parseReport(output) {
  const line = output.split(/\r?\n/u).map((value) => value.trim())
    .filter((value) => value.startsWith(REPORT_PREFIX)).at(-1);
  return line ? JSON.parse(line.slice(REPORT_PREFIX.length)) : null;
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
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
  for (const relativePath of testFiles) {
    const source = await readFile(path.join(extensionRoot, relativePath), 'utf8');
    if (isBundleSafeTest(relativePath, source)) {
      safe.push(relativePath);
      if (!UNSAFE_BATCH_ENTRIES.has(relativePath) && !UNSAFE_BATCH_SOURCE.test(source)) batchable.add(relativePath);
    } else {
      unsafe.push(relativePath);
    }
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pie-extension-fast-'));
  try {
    const tsxCli = path.join(extensionRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const reporterArg = `--test-reporter=${reporterSpecifier}`;
    const bundledArgs = ['--test', '--test-force-exit', '--test-concurrency=32', reporterArg];
    const isolatedArgs = ['--test', '--test-force-exit', '--test-concurrency=16', reporterArg];
    const { build } = extensionRequire('esbuild');
    const preserveSourceUrls = {
      name: 'preserve-source-urls',
      setup(esbuild) {
        esbuild.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path: sourcePath }) => {
          const source = await readFile(sourcePath, 'utf8');
          return {
            contents: source.replace(/import\.meta\.url/gu, JSON.stringify(pathToFileURL(sourcePath).href)),
            loader: sourcePath.endsWith('x') ? 'tsx' : 'ts',
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
      .filter((file) => !batchable.has(file))
      .map((file) => path.join(tempDir, file.replace(/\.ts$/u, '.js')));
    const batchBuckets = Array.from({ length: 10 }, () => []);
    [...batchable].forEach((file, index) => {
      batchBuckets[index % batchBuckets.length].push(path.join(tempDir, file.replace(/\.ts$/u, '.js')));
    });
    const batchFiles = await Promise.all(batchBuckets.map(async (files, index) => {
      const batchPath = path.join(tempDir, `bundle-batch-${index}.mjs`);
      await writeFile(batchPath, files.map((file) => `await import(${JSON.stringify(pathToFileURL(file).href)});`).join('\n'), 'utf8');
      return batchPath;
    }));
    const bundledFiles = [...standaloneBundles, ...batchFiles];
    // Keep the two waves sequential: each wave is highly parallel internally,
    // and overlapping them only increases transform contention.
    const bundledResult = await run(process.execPath, [...bundledArgs, ...bundledFiles], extensionRoot);
    const unsafeResult = await run(process.execPath, [tsxCli, ...isolatedArgs, ...unsafe], extensionRoot);
    const results = [bundledResult, unsafeResult];
    const report = mergeReports(results, performance.now() - startedAt);
    process.stdout.write(`${REPORT_PREFIX}${JSON.stringify(report)}\n`);
    if (!report.summary.success) process.exitCode = 1;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) await main();
