#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { withoutPiHarnessEnv } from './lib/pi-harness-env.mjs';
import { createOwnerRequire, createTsconfigOverlay, resolveOwnerTsx, resolvePackageRoots } from './lib/package-resolution.mjs';
import { isProtectedDirectoryName } from './lib/traversal-policy.mjs';
import {
  accountTestFiles,
  normalizeTestFileIdentity,
  summarizeTestFileAccounting,
  TEST_FILE_ACCOUNTING_ENV,
  TEST_FILE_MARKER,
} from './test-reporter.mjs';

const REPORT_PREFIX = '__PI_TEST_SUMMARY__';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = path.join(repoRoot, 'extension');
// Timing overrides (used by scripts/update-extension-test-costs.mjs and by
// one-off perf probes): swap the summarizing reporter for the timing one.
const reporterSpecifier = process.env.PIE_TIMING_REPORTER
  ? pathToFileURL(process.env.PIE_TIMING_REPORTER).href
  : pathToFileURL(path.join(repoRoot, 'scripts', 'test-reporter.mjs')).href;
const ownerRoot = resolvePackageRoots().dependencyOwnerRoot;
const ownerRequire = createOwnerRequire();

// Measured per-file serial test costs (scripts/update-extension-test-costs.mjs)
// drive load-balanced batch bucketing. Without the table, bucketing falls back
// to the stable FNV hash so fresh checkouts still shard deterministically.
const costTablePath = path.join(repoRoot, 'scripts', 'extension-test-costs.json');
function loadCostTable() {
  try {
    return JSON.parse(readFileSync(costTablePath, 'utf8'));
  } catch {
    return null;
  }
}

// pi packages (settings.json#packages) are installed into the gitignored
// `npm/` workspace, not the application owner's node_modules. The extension imports them via
// relative paths (e.g. `npm/node_modules/pi-mcp-adapter/config.ts`), and their
// own bare dependencies (smol-toml, strip-json-comments, zod, ...) exist only
// under npm/node_modules. `packages: 'external'` below would leave those bare
// imports as runtime requires that resolve from the application owner's node_modules
// symlink and fail. Bundle them instead; see `bundlePiPackageDeps`.
const npmNodeModules = path.join(repoRoot, 'npm', 'node_modules');

// Child-process entry points and __dirname-dependent modules retain tsx
// isolation. import.meta.url is rewritten to its source URL below, while
// computed imports are bundled but kept out of shared batch wrappers.
const UNSAFE_SOURCE = /node:child_process|node:worker_threads|__dirname|\binstallDom\s*\(|(?:\bfrom\s*|\bimport\s*)['"]preact(?:\/|['"])/u;
const UNSAFE_BUNDLE_ENTRIES = new Set([
  'test/backend/runtime/extension-ui-bridge.test.ts',
  'test/backend/worker/worker-client-transport.test.ts',
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
    if (entry.isDirectory() && isProtectedDirectoryName(entry.name)) continue;
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

async function writeAccountingContext(tempDir, name, expectedFiles, directFiles = [], ignoredFiles = []) {
  const contextPath = path.join(tempDir, `file-accounting-${name}.json`);
  const directFileMap = Object.fromEntries(directFiles.map(([inputPath, sourceFile]) => [
    normalizeTestFileIdentity(inputPath), path.resolve(sourceFile),
  ]));
  await writeFile(contextPath, JSON.stringify({
    expectedFiles: expectedFiles.map((file) => path.resolve(file)),
    directFiles: directFileMap,
    ignoredFiles: ignoredFiles.map((file) => path.resolve(file)),
    intentionalReruns: [],
  }), 'utf8');
  return contextPath;
}

function stableBucketIndex(file, bucketCount) {
  let hash = 2166136261;
  for (let index = 0; index < file.length; index += 1) {
    hash ^= file.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % bucketCount;
}

/**
 * Longest-processing-time bucket assignment using measured serial costs so no
 * `node --test` child becomes the wave's critical path. Bucket count grows
 * until every bucket's estimated cost fits the target child budget; batches
 * wrapper each bucket in one serial child process.
 */
function sourceOfBundle(bundledPath) {
  return path.relative(tempDir, bundledPath).replace(/\\/gu, '/').replace(/\.js$/u, '.ts');
}
function balancedBuckets(files, costTable) {
  const BUDGET_MS = 6_000;
  const costs = (file) => costTable?.[file.replace(/\\/gu, '/')] ?? 500;
  const totalCost = files.reduce((sum, file) => sum + costs(file), 0);
  const bucketCount = Math.max(1, Math.min(40, Math.ceil(totalCost / BUDGET_MS)));
  const buckets = Array.from({ length: bucketCount }, () => []);
  const bucketCosts = Array.from({ length: bucketCount }, () => 0);
  if (costTable) {
    const ordered = [...files].sort((a, b) => costs(b) - costs(a));
    for (const file of ordered) {
      const index = bucketCosts.indexOf(Math.min(...bucketCosts));
      buckets[index].push(file);
      bucketCosts[index] += costs(file);
    }
  } else {
    for (const file of files) {
      const index = stableBucketIndex(file, bucketCount);
      buckets[index].push(file);
      bucketCosts[index] += costs(file);
    }
  }
  return buckets;
}

function comparablePath(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const resolved = path.resolve(value).replace(/\\/gu, '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Recover source paths from failures reported by esbuild's temporary outputs.
 *
 * The repo-wide runner uses failure.file to rerun a red test in isolation.
 * Bundled extension tests otherwise report a generated
 * `%TEMP%/pie-extension-fast-<id>/test/<name>.js` path,
 * which disappears before that rerun and cannot be classified as a repo test.
 * Suite-wrapper failures report the temporary test path as their name instead,
 * so both fields participate in recovery.
 */
export function recoverBundledFailureSourceFiles(failures, tempDir, sourceFiles) {
  const sourcesByOutput = new Map(sourceFiles.map((sourceFile) => {
    const normalizedSource = sourceFile.replace(/\\/gu, '/');
    const outputFile = path.join(tempDir, normalizedSource.replace(/\.tsx?$/u, '.js'));
    return [comparablePath(outputFile), path.join(extensionRoot, normalizedSource)];
  }));

  return failures.map((failure) => {
    const sourceFile = sourcesByOutput.get(comparablePath(failure.file))
      ?? sourcesByOutput.get(comparablePath(failure.name));
    return sourceFile ? { ...failure, file: sourceFile } : failure;
  });
}

export function createPreserveSourceUrls(sourceRoot = repoRoot) {
  return {
    name: 'preserve-source-urls',
    setup(esbuild) {
      esbuild.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path: sourcePath }) => {
        const relative = path.relative(sourceRoot, sourcePath);
        const directories = relative.split(path.sep).slice(0, -1);
        // scripts/build contains hand-written publication helpers, not build output.
        const protectedDirectories = directories[0] === 'scripts' && directories[1] === 'build'
          ? directories.slice(2) : directories;
        if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)
          || path.isAbsolute(relative)
          || protectedDirectories.some(isProtectedDirectoryName)) return null;
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
}

export async function withFastRunnerTempDirs(action, tempRoot = os.tmpdir()) {
  let tempDir;
  const traceDirs = [];
  try {
    tempDir = await mkdtemp(path.join(tempRoot, 'pie-extension-fast-'));
    traceDirs.push(await mkdtemp(path.join(tempRoot, 'pie-extension-fast-traces-bundled-')));
    traceDirs.push(await mkdtemp(path.join(tempRoot, 'pie-extension-fast-traces-unsafe-')));
    return await action(tempDir, traceDirs);
  } finally {
    await Promise.all([...(tempDir ? [tempDir] : []), ...traceDirs]
      .map((dir) => rm(dir, { recursive: true, force: true })));
  }
}

function mergeReports(results, durationMs, tempDir, bundledSourceFiles, enumeratedFiles) {
  const counts = emptyCounts();
  const failures = [];
  const executedFiles = [];
  let success = true;
  for (const result of results) {
    const report = parseReport(`${result.stdout}\n${result.stderr}`);
    if (!report || result.code !== 0 || result.signal !== null) success = false;
    for (const key of Object.keys(counts)) counts[key] += report?.summary?.counts?.[key] ?? 0;
    failures.push(...recoverBundledFailureSourceFiles(
      report?.failures ?? [],
      tempDir,
      bundledSourceFiles,
    ));
    if (Array.isArray(report?.fileAccounting?.executedFiles)) executedFiles.push(...report.fileAccounting.executedFiles);
    else success = false;
    if (report?.fileAccounting && !report.fileAccounting.success) success = false;
    if (!report) {
      failures.push({
        name: 'fast extension test subprocess failed without a summary',
        message: `${result.stderr || result.stdout}`.trim().split(/\r?\n/u).slice(-20).join('\n'),
      });
    }
  }
  const fileAccounting = accountTestFiles(enumeratedFiles, executedFiles);
  if (!fileAccounting.success) {
    success = false;
    failures.push({
      name: 'aggregate extension test-file accounting mismatch',
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

  const costTable = loadCostTable();
  // Fresh per-wave trace directories keep test traces separate from the
  // shared canonical %TEMP% file. Allocate and remove them with the bundle dir.
  await withFastRunnerTempDirs(async (tempDir, traceDirs) => {
    const bundleSourcePath = (bundledFilePath) =>
      path.relative(tempDir, bundledFilePath).replace(/\\/gu, '/').replace(/\.js$/u, '.ts');
    let unsafeChild;
    try {
    const standaloneSources = safe.filter((file) => !batchable.has(file) && !scopedBatchable.has(file));
    const standaloneBundles = standaloneSources
      .map((file) => path.join(tempDir, file.replace(/\.tsx?$/u, '.js')));
    const unsafeSourceFiles = unsafe.map((file) => path.join(extensionRoot, file));
    const unsafeAccountingContext = await writeAccountingContext(
      tempDir,
      'unsafe',
      unsafeSourceFiles,
      unsafeSourceFiles.map((file) => [file, file]),
    );
    const tsxCli = resolveOwnerTsx();
    const tsxOverlay = createTsconfigOverlay(path.join(ownerRoot, 'tsconfig.json'), {
      directory: tempDir, includeOwnerDependencies: true,
    });
    const reporterArg = `--test-reporter=${reporterSpecifier}`;
    const bundledArgs = ['--test', '--test-force-exit', '--test-concurrency=16', reporterArg];
    const isolatedArgs = ['--test', '--test-force-exit', '--test-concurrency=10', reporterArg];
    // The small isolated tsx subset can run while esbuild prepares the bundled
    // wave, hiding both compiler and tsx startup latency.
    const unsafeRun = run(
      process.execPath,
      [tsxCli, `--tsconfig=${tsxOverlay.configPath}`, ...isolatedArgs, ...unsafe],
      extensionRoot,
      (child) => { unsafeChild = child; },
      {
        PIE_LIVE_PIPELINE_TRACE_DIR: traceDirs[1],
        [TEST_FILE_ACCOUNTING_ENV]: unsafeAccountingContext,
      },
    );

    const { build } = ownerRequire('esbuild');
    const bundlePiPackageDeps = {
      name: 'bundle-pi-package-deps',
      setup(esbuild) {
        // What a bundled test's runtime requires look like: temp bundles sit
        // in %TEMP% with only a `node_modules` junction to the application
        // dependency owner's node_modules. Resolve from that anchor so we can tell
        // which bare imports the runtime will and will not find.
        const bundleAnchorRequire = createRequire(path.join(ownerRoot, 'node_modules', '.pi-anchor.cjs'));
        esbuild.onResolve({ filter: /^[^./]/ }, (args) => {
          // The owner overlay maps bare vite to an absolute dependency file.
          // Keep Vite external: its own import.meta.url must resolve relative to
          // its installed package, not to the temporary CJS test bundle.
          if (args.path === 'vite') return { path: 'vite', external: true };
          // Leave node: builtins to esbuild's default (`packages: 'external'`)
          // handling.
          if (args.path.startsWith('node:')) return null;
          if (!args.resolveDir) return null;
          if (args.resolveDir.startsWith(npmNodeModules)) {
            try {
              // Resolve exactly as Node would from the importing file so
              // nested (non-hoisted) pi-package deps are found too.
              const importerRequire = createRequire(path.join(args.resolveDir, '.pi-anchor.cjs'));
              const resolved = importerRequire.resolve(args.path);
              if (resolved.startsWith(npmNodeModules)) return { path: resolved, external: false };
            } catch {
              // Not resolvable from npm/node_modules; fall through to default.
            }
            return null;
          }
          // Extension sources may import pi packages through tsconfig path
          // aliases (e.g. @mariozechner/pi-ai), which esbuild resolves to
          // absolute paths inside node_modules and therefore bundles. Their
          // own bare deps (e.g. typebox) exist only nested under
          // node_modules/<pkg>/node_modules and are invisible to the runtime
          // anchor above, so bundle exactly those nested-only deps.
          try {
            const importerRequire = createRequire(path.join(args.resolveDir, '.pi-anchor.cjs'));
            let resolved;
            try {
              resolved = importerRequire.resolve(args.path);
            } catch {
              // Not Node-resolvable from the importer (e.g. resolved later by
              // tsconfig paths); fall through to esbuild's default handling.
              return null;
            }
            let anchored;
            try {
              anchored = bundleAnchorRequire.resolve(args.path);
            } catch {
              anchored = null;
            }
            if (anchored === resolved) return null; // runtime finds it via the junction: keep external
            if (resolved.startsWith(path.join(ownerRoot, 'node_modules'))
              || resolved.startsWith(npmNodeModules)) {
              return { path: resolved, external: false };
            }
          } catch {
            // Fall through to esbuild's default handling.
          }
          return null;
        });
      },
    };
    await build({
      entryPoints: safe.map((file) => path.join(extensionRoot, file)),
      outdir: tempDir,
      outbase: extensionRoot,
      tsconfig: tsxOverlay.configPath,
      entryNames: '[dir]/[name]',
      bundle: true,
      format: 'cjs',
      platform: 'node',
      packages: 'external',
      plugins: [createPreserveSourceUrls(), bundlePiPackageDeps],
      // A bundled test is the process entry point. Disable application entry
      // guards so imported backend modules do not start the real server.
      define: { 'require.main': 'undefined' },
      logLevel: 'silent',
    });
    await symlink(path.join(ownerRoot, 'node_modules'), path.join(tempDir, 'node_modules'), 'junction');

    const compiledBatchFile = (file) => path.join(tempDir, file.replace(/\.tsx?$/u, '.js'));
    const bucketToBatch = (buckets, prefix) => Promise.all(buckets.map(async (files, index) => {
      const batchPath = path.join(tempDir, `${prefix}-${index}.mjs`);
      const suites = files.map((sourceFile) => {
        const compiledFile = compiledBatchFile(sourceFile);
        const sourcePath = path.join(extensionRoot, sourceFile);
        return `describe(${JSON.stringify(`${TEST_FILE_MARKER}${sourcePath}`)}, { concurrency: false }, async () => { await import(${JSON.stringify(pathToFileURL(compiledFile).href)}); });`;
      });
      await writeFile(batchPath, `import { describe } from 'node:test';\n${suites.join('\n')}`, 'utf8');
      return batchPath;
    }));
    const batchFiles = await bucketToBatch(balancedBuckets([...batchable], costTable), 'bundle-batch');
    const scopedBatchFiles = await bucketToBatch(balancedBuckets([...scopedBatchable], costTable), 'scoped-bundle-batch');
    const bundledFiles = [...standaloneBundles, ...batchFiles, ...scopedBatchFiles];
    const bundledAccountingContext = await writeAccountingContext(
      tempDir,
      'bundled',
      safe.map((file) => path.join(extensionRoot, file)),
      standaloneBundles.map((bundle, index) => [bundle, path.join(extensionRoot, standaloneSources[index])]),
      [...batchFiles, ...scopedBatchFiles],
    );

    if (costTable) {
      const weight = (file) => costTable[file.replace(/\\/gu, '/')] ?? 0;
      bundledFiles.sort((a, b) => weight(bundleSourcePath(b)) - weight(bundleSourcePath(a)));
    }
    const results = await Promise.all([
      run(process.execPath, [...bundledArgs, ...bundledFiles], extensionRoot, undefined, {
        PIE_LIVE_PIPELINE_TRACE_DIR: traceDirs[0],
        [TEST_FILE_ACCOUNTING_ENV]: bundledAccountingContext,
      }),
      unsafeRun,
    ]);
    const report = mergeReports(
      results,
      performance.now() - startedAt,
      tempDir,
      safe,
      [...safe, ...unsafe].map((file) => path.join(extensionRoot, file)),
    );
    process.stdout.write(`${REPORT_PREFIX}${JSON.stringify(report)}\n`);
    if (!report.summary.success) process.exitCode = 1;
    } finally {
      if (unsafeChild?.exitCode === null && unsafeChild?.signalCode === null) unsafeChild.kill();
    }
  });
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) await main();
