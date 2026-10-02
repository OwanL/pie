#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { realpathSync, readFileSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { withoutPiHarnessEnv } from '../lib/pi-harness-env.mjs';
import { createOwnerRequire, createTsconfigOverlay, resolveOwnerTsx, resolvePackageRoots } from '../lib/package-resolution.mjs';
import { isProtectedDirectoryName } from '../lib/traversal-policy.mjs';
import { packageTestFiles, packageTestRoots, resolvePackageEntry } from '../lib/test-packages.mjs';
import {
  accountTestFiles,
  normalizeTestFileIdentity,
  summarizeTestFileAccounting,
  TEST_FILE_ACCOUNTING_ENV,
  TEST_FILE_MARKER,
} from './test-reporter.mjs';

import { extractRuntimeArgs, verificationChildEnv, withVerificationRuntime } from './verification-runtime.mjs';
import { abortOnProcessSignals, killProcessTree, watchChildProcess, withProcessTreeIsolation, resolveChildProcessTimeoutMs } from '../lib/process-watchdog.mjs';

const REPORT_PREFIX = '__PI_TEST_SUMMARY__';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXTENSION_PACKAGE = resolvePackageEntry('extension');
const extensionPackageRoot = path.join(repoRoot, EXTENSION_PACKAGE.dir);
const SOURCE_FIXTURE_SOURCE = path.join(
  repoRoot, 'harness', 'agent-processes', 'lib', 'sdk-integration', 'test', 'source-fixture.ts',
);
export const EXTENSION_TEST_ROOTS = packageTestRoots(EXTENSION_PACKAGE).map((testRoot) => testRoot.startsWith('test/')
  ? { relativeDir: `repo/${testRoot}`, root: repoRoot }
  : { relativeDir: testRoot, root: repoRoot });
// Timing overrides (used by scripts/verification/update-extension-test-costs.mjs and by
// one-off perf probes): swap the summarizing reporter for the timing one.
const reporterSpecifier = process.env.PIE_TIMING_REPORTER
  ? pathToFileURL(process.env.PIE_TIMING_REPORTER).href
  : pathToFileURL(path.join(repoRoot, 'scripts', 'verification', 'test-reporter.mjs')).href;
const ownerRoot = resolvePackageRoots().dependencyOwnerRoot;
const ownerRequire = createOwnerRequire();

// Measured per-file serial test costs (scripts/verification/update-extension-test-costs.mjs)
// drive load-balanced batch bucketing. Without the table, bucketing falls back
// to the stable FNV hash so fresh checkouts still shard deterministically.
const costTablePath = path.join(repoRoot, 'scripts', 'verification', 'extension-test-costs.json');
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
  'test/host/core/lifecycle/pinned-tab-groups.test.ts',
  'test/shared/utilities/tab-behavior.test.ts',
  'application/frontend/test/components/ui-loading-states.test.ts',
  'application/frontend/test/transcript/tools/registry.test.ts',
  // JSDOM resolves xhr-sync-worker.js relative to its source; bundling moves it away from jsdom.
  'application/frontend/test/transcript/messages/markdown-rendering.test.ts',
]);
const UNSAFE_BATCH_ENTRIES = new Set([
  'test/host/core/lifecycle/pinned-tab-groups.test.ts',
  'application/frontend/test/file-changes/file-changes-panel.test.ts',
  'application/frontend/test/transcript/activity/turn-activity-region.test.ts',
]);
const SAFE_BATCH_ENTRIES = new Set([
  'test/host/core/architecture/arch-arrival-order.test.ts',
  'test/host/core/lifecycle/persist-tabs-via-command.test.ts',
  'application/frontend/test/transcript/activity/streaming-without-overlay.test.ts',
  'application/frontend/test/transcript/tools/ask-user-tool-render.test.ts',
  'application/frontend/test/transcript/tools/tool-call-heading-css.test.ts',
  'application/frontend/test/transcript/tools/web-search-tool-render.test.ts',
]);
const UNSAFE_BATCH_SOURCE = /\bimport\s*\(|process\.env|mock\.|\b(?:test\.)?(?:before|after|beforeEach|afterEach)\s*\(|(?:globalThis|window|document)[^\n]{0,80}=|Object\.(?:assign|defineProperty)\s*\(\s*(?:globalThis|window|document)|delete\s+(?:globalThis|window|document)/u;
const UNSAFE_SCOPED_BATCH_ENTRIES = new Set([
  'application/frontend/test/composer/composer-draft.test.ts',
  'application/frontend/test/transcript/messages/transcript-host-commit.test.ts',
]);
const UNSAFE_SCOPED_BATCH_SOURCE = /\bModule\.(?:register|_load)|\bmodule\.register|\bimport\s*\(/u;

async function walkTestFiles(relativeDir, output, root = extensionPackageRoot) {
  const diskRelativeDir = relativeDir.startsWith('repo/') ? relativeDir.slice('repo/'.length) : relativeDir;
  const absoluteDir = path.join(root, diskRelativeDir);
  for (const entry of await readdir(absoluteDir, { withFileTypes: true })) {
    if (entry.isDirectory() && isProtectedDirectoryName(entry.name)) continue;
    const relativePath = path.posix.join(relativeDir.replace(/\\/gu, '/'), entry.name);
    if (entry.isDirectory()) await walkTestFiles(relativePath, output, root);
    else if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx') || entry.name.endsWith('.test.mjs')) output.push(relativePath);
  }
}

export function resolveExtensionTestPath(relativePath) {
  const normalizedPath = relativePath.replace(/\\/gu, '/');
  if (normalizedPath.startsWith('repo/')) return path.join(repoRoot, normalizedPath.slice('repo/'.length));
  if (normalizedPath.startsWith('harness/') || normalizedPath.startsWith('application/') || normalizedPath.startsWith('extension/')) {
    return path.join(repoRoot, normalizedPath);
  }
  return path.join(extensionPackageRoot, normalizedPath);
}

export function extensionBundleOutputPath(tempDir, sourceFile) {
  return path.join(tempDir, path.relative(repoRoot, resolveExtensionTestPath(sourceFile)).replace(/\.tsx?$/u, '.js'));
}

function resolveExtensionTestArgument(relativePath) {
  return path.relative(extensionPackageRoot, resolveExtensionTestPath(relativePath)).replace(/\\/gu, '/');
}

export function bundledSuiteMarker(sourceFile) {
  return `${TEST_FILE_MARKER}${resolveExtensionTestPath(sourceFile)}`;
}

export function isBundleSafeTest(relativePath, source) {
  return !UNSAFE_BUNDLE_ENTRIES.has(relativePath.replace(/\\/gu, '/')) && !UNSAFE_SOURCE.test(source);
}

export function hasDirectSourceFixtureImport(source) {
  return /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)['"](?:[^'"]*\/)?source-fixture(?:\.[cm]?[jt]s)?['"]/u.test(source);
}

export function partitionSourceFixtureTests(files, sourceFixtureFiles) {
  const sourceFixtureSet = new Set(sourceFixtureFiles);
  return {
    normal: files.filter((file) => !sourceFixtureSet.has(file)),
    sourceFixture: files.filter((file) => sourceFixtureSet.has(file)),
  };
}

export function classifyExtensionTest(relativePath, source) {
  const normalizedPath = relativePath.replace(/\\/gu, '/');
  if (normalizedPath.startsWith('application/hosts/') || normalizedPath.endsWith('.test.mjs')) return 'tsx';
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

function unconfirmedTeardownError(message) {
  const error = new Error(message);
  error.processTreeTeardownUnconfirmed = true;
  return error;
}

function run(command, args, cwd, onSpawn = undefined, extraEnv = {}, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, withProcessTreeIsolation({
      cwd,
      env: verificationChildEnv(withoutPiHarnessEnv({ ...process.env, FORCE_COLOR: '0', ...extraEnv })),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }));
    const watchdog = watchChildProcess(child, { signal, timeoutMs: resolveChildProcessTimeoutMs(), label: 'bundled extension tests' });
    onSpawn?.(child);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', async (error) => {
      const cleanup = await watchdog.settle().catch(() => ({ gone: false }));
      reject(cleanup.gone ? error : unconfirmedTeardownError('Extension test tree teardown is unconfirmed'));
    });
    child.on('close', async (code, closeSignal) => {
      const cleanup = await watchdog.settle().catch(() => ({ gone: false }));
      if (!cleanup.gone) { reject(unconfirmedTeardownError('Extension test tree teardown is unconfirmed')); return; }
      resolve({ code: watchdog.timedOut || watchdog.aborted ? 1 : (code ?? 1), signal: closeSignal, stdout, stderr });
    });
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

function pathIsInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Resolve aliases selected from the verified artifact without applying package exports. */
export function resolveArtifactAliasPath(selected, runtime) {
  const artifactRoot = realpathSync(runtime.artifactDir);
  const absoluteSelected = path.resolve(selected);
  if (!pathIsInside(runtime.artifactDir, absoluteSelected)) {
    throw new Error(`Verified artifact alias is outside selected artifact: ${selected}`);
  }

  let resolved;
  try {
    // The path is absolute, so Node's CJS exports conditions are not consulted;
    // the candidate SDK anchor still owns the resolver context.
    resolved = createRequire(path.join(runtime.sdkPath, 'package.json')).resolve(absoluteSelected);
  } catch (error) {
    throw new Error(`Could not resolve verified artifact alias: ${selected}`, { cause: error });
  }
  const canonical = realpathSync(resolved);
  if (!pathIsInside(artifactRoot, canonical)) {
    throw new Error(`Verified artifact alias escaped selected artifact: ${selected}`);
  }
  return canonical;
}

function comparablePath(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const resolved = path.resolve(value).replace(/\\/gu, '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function resolvedMetafilePath(value) {
  return comparablePath(path.isAbsolute(value) ? value : path.resolve(repoRoot, value));
}

export function sourceFixtureConsumersFromMetafile(metafile, tempDir, sourceFiles) {
  const sourcesByOutput = new Map(sourceFiles.map((sourceFile) => [
    comparablePath(extensionBundleOutputPath(tempDir, sourceFile)), sourceFile,
  ]));
  const fixturePath = comparablePath(SOURCE_FIXTURE_SOURCE);
  const consumers = new Set();
  for (const [outputPath, output] of Object.entries(metafile?.outputs ?? {})) {
    const sourceFile = sourcesByOutput.get(resolvedMetafilePath(outputPath));
    if (!sourceFile) continue;
    if (Object.keys(output.inputs ?? {}).some((inputPath) => resolvedMetafilePath(inputPath) === fixturePath)) {
      consumers.add(sourceFile);
    }
  }
  return sourceFiles.filter((sourceFile) => consumers.has(sourceFile));
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
  const sourcesByOutput = new Map(sourceFiles.map((sourceFile) => [
    comparablePath(extensionBundleOutputPath(tempDir, sourceFile)),
    resolveExtensionTestPath(sourceFile),
  ]));

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
  let teardownConfirmed = true;
  const traceDirs = [];
  try {
    tempDir = await mkdtemp(path.join(tempRoot, 'pie-extension-fast-'));
    traceDirs.push(await mkdtemp(path.join(tempRoot, 'pie-extension-fast-traces-bundled-')));
    traceDirs.push(await mkdtemp(path.join(tempRoot, 'pie-extension-fast-traces-unsafe-')));
    traceDirs.push(await mkdtemp(path.join(tempRoot, 'pie-extension-fast-traces-source-fixture-')));
    return await action(tempDir, traceDirs);
  } catch (error) {
    if (error?.processTreeTeardownUnconfirmed) teardownConfirmed = false;
    throw error;
  } finally {
    if (teardownConfirmed) {
      await Promise.all([...(tempDir ? [tempDir] : []), ...traceDirs]
        .map((dir) => rm(dir, { recursive: true, force: true })));
    }
  }
}

export function mergeReports(results, durationMs, tempDir, bundledSourceFiles, enumeratedFiles) {
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

export async function runSerializedExtensionWaves(normalWave, sourceFixtureWave) {
  const results = await Promise.all(normalWave);
  for (const start of sourceFixtureWave) results.push(await start());
  return results;
}

async function runSuite(runtime, signal) {
  const startedAt = performance.now();
  const discoveredTestFiles = [];
  for (const { relativeDir, root } of EXTENSION_TEST_ROOTS) {
    await walkTestFiles(relativeDir, discoveredTestFiles, root);
  }
  const explicitTestFiles = packageTestFiles(EXTENSION_PACKAGE).map((testFile) => testFile.startsWith('test/') ? `repo/${testFile}` : testFile);
  const testFiles = [...new Set([...discoveredTestFiles, ...explicitTestFiles])].sort();

  const safe = [];
  const unsafe = [];
  const directSourceFixtureFiles = new Set();
  const batchable = new Set();
  const scopedBatchable = new Set();
  for (const relativePath of testFiles) {
    const source = await readFile(resolveExtensionTestPath(relativePath), 'utf8');
    if (hasDirectSourceFixtureImport(source)) directSourceFixtureFiles.add(relativePath);
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
    const sourceFilesByBundleOutput = new Map(safe.map((sourceFile) => [
      comparablePath(extensionBundleOutputPath(tempDir, sourceFile)),
      sourceFile,
    ]));
    const bundleSourcePath = (bundledFilePath) => sourceFilesByBundleOutput.get(comparablePath(bundledFilePath))
      ?? path.relative(tempDir, bundledFilePath).replace(/\\/gu, '/').replace(/\.js$/u, '.ts');
    let unsafeChild;
    let unsafeRun;
    let bundledRun;
    let sourceFixtureRun;
    try {
    const { normal: normalUnsafe, sourceFixture: sourceFixtureUnsafe } = partitionSourceFixtureTests(
      unsafe, directSourceFixtureFiles,
    );
    const unsafeSourceFiles = normalUnsafe.map(resolveExtensionTestPath);
    const unsafeAccountingContext = unsafeSourceFiles.length
      ? await writeAccountingContext(
        tempDir,
        'unsafe',
        unsafeSourceFiles,
        unsafeSourceFiles.map((file) => [file, file]),
      )
      : undefined;
    const tsxCli = resolveOwnerTsx();
    const tsxOverlay = createTsconfigOverlay(path.join(ownerRoot, 'tsconfig.json'), {
      directory: tempDir, includeOwnerDependencies: true, sdkPath: runtime.sdkPath,
    });
    const reporterArg = `--test-reporter=${reporterSpecifier}`;
    const bundledArgs = ['--test', '--test-force-exit', '--test-concurrency=16', reporterArg];
    const isolatedArgs = ['--test', '--test-force-exit', '--test-concurrency=10', reporterArg];
    // The small isolated tsx subset can run while esbuild prepares the bundled
    // wave, hiding both compiler and tsx startup latency.
    if (normalUnsafe.length > 0) {
      unsafeRun = run(
        process.execPath,
        [tsxCli, `--tsconfig=${tsxOverlay.configPath}`, ...isolatedArgs, ...normalUnsafe.map(resolveExtensionTestArgument)],
        extensionPackageRoot,
        (child) => { unsafeChild = child; },
        {
          PIE_LIVE_PIPELINE_TRACE_DIR: traceDirs[1],
          [TEST_FILE_ACCOUNTING_ENV]: unsafeAccountingContext,
          TSX_TSCONFIG_PATH: tsxOverlay.configPath,
        }, signal,
      );

      // Preserve the rejection for the join below without an unhandled rejection
      // while esbuild is still preparing the other wave.
      void unsafeRun.catch(() => {});
    }
    const { build } = ownerRequire('esbuild');
    const bundlePiPackageDeps = {
      name: 'bundle-pi-package-deps',
      setup(esbuild) {
        // What a bundled test's runtime requires look like: temp bundles sit
        // in %TEMP% with only a `node_modules` junction to the application
        // dependency owner's node_modules. Resolve from that anchor so we can tell
        // which bare imports the runtime will and will not find.
        const bundleAnchorRequire = createRequire(path.join(ownerRoot, 'node_modules', '.pi-anchor.cjs'));
        const aliases = JSON.parse(readFileSync(tsxOverlay.configPath, 'utf8')).compilerOptions.paths;
        esbuild.onResolve({ filter: /^[^./]/ }, (args) => {
          if (isBuiltin(args.path)) return null;
          const exact = aliases[args.path]?.[0];
          const wildcard = Object.keys(aliases).find((key) => key.endsWith('/*') && args.path.startsWith(key.slice(0, -1)));
          const selected = exact ?? (wildcard ? aliases[wildcard][0].replace('*', args.path.slice(wildcard.length - 1)) : undefined);
          if (typeof selected === 'string' && path.isAbsolute(selected)
            && pathIsInside(runtime.artifactDir, selected)) {
            return { path: resolveArtifactAliasPath(selected, runtime), external: false };
          }
          if (/^(?:@earendil-works|@mariozechner)\/pi-(?:ai|agent-core|tui|coding-agent)(?:\/|$)/u.test(args.path)
            || /^(?:@sinclair\/)?typebox(?:\/|$)/u.test(args.path)) {
            throw new Error(`Missing verified artifact alias: ${args.path}`);
          }
          if (args.resolveDir.startsWith(runtime.artifactDir + path.sep)) {
            const resolved = createRequire(path.join(args.resolveDir, '.pi-anchor.cjs')).resolve(args.path);
            if (!resolved.startsWith(runtime.artifactDir + path.sep)) throw new Error(`Artifact dependency escaped: ${args.path}`);
            return { path: resolved, external: false };
          }
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
    const bundleBuild = await build({
      absWorkingDir: repoRoot,
      entryPoints: safe.map(resolveExtensionTestPath),
      outdir: tempDir,
      outbase: repoRoot,
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
      metafile: true,
    });
    await symlink(path.join(ownerRoot, 'node_modules'), path.join(tempDir, 'node_modules'), 'junction');

    const sourceFixtureConsumerSet = new Set([
      ...directSourceFixtureFiles,
      ...sourceFixtureConsumersFromMetafile(bundleBuild.metafile, tempDir, safe),
    ]);
    const { normal: normalSafe, sourceFixture: sourceFixtureSafe } = partitionSourceFixtureTests(
      safe, sourceFixtureConsumerSet,
    );
    const standaloneSources = normalSafe.filter((file) => !batchable.has(file) && !scopedBatchable.has(file));
    const standaloneBundles = standaloneSources.map((file) => extensionBundleOutputPath(tempDir, file));
    const sourceFixtureBundles = sourceFixtureSafe.map((file) => extensionBundleOutputPath(tempDir, file));
    const compiledBatchFile = (file) => extensionBundleOutputPath(tempDir, file);
    const bucketToBatch = (buckets, prefix) => Promise.all(buckets.map(async (files, index) => {
      const batchPath = path.join(tempDir, `${prefix}-${index}.mjs`);
      const suites = files.map((sourceFile) => {
        const compiledFile = compiledBatchFile(sourceFile);
        return `describe(${JSON.stringify(bundledSuiteMarker(sourceFile))}, { concurrency: false }, async () => { await import(${JSON.stringify(pathToFileURL(compiledFile).href)}); });`;
      });
      await writeFile(batchPath, `import { describe } from 'node:test';\n${suites.join('\n')}`, 'utf8');
      return batchPath;
    }));
    const normalBatchable = [...batchable].filter((file) => !sourceFixtureConsumerSet.has(file));
    const normalScopedBatchable = [...scopedBatchable].filter((file) => !sourceFixtureConsumerSet.has(file));
    const batchFiles = await bucketToBatch(balancedBuckets(normalBatchable, costTable), 'bundle-batch');
    const scopedBatchFiles = await bucketToBatch(balancedBuckets(normalScopedBatchable, costTable), 'scoped-bundle-batch');
    const bundledFiles = [...standaloneBundles, ...batchFiles, ...scopedBatchFiles];
    const bundledAccountingContext = await writeAccountingContext(
      tempDir,
      'bundled',
      normalSafe.map(resolveExtensionTestPath),
      standaloneBundles.map((bundle, index) => [bundle, resolveExtensionTestPath(standaloneSources[index])]),
      [...batchFiles, ...scopedBatchFiles],
    );
    const sourceFixtureBundleAccountingContext = sourceFixtureBundles.length
      ? await writeAccountingContext(
        tempDir,
        'source-fixture-bundled',
        sourceFixtureSafe.map(resolveExtensionTestPath),
        sourceFixtureBundles.map((bundle, index) => [bundle, resolveExtensionTestPath(sourceFixtureSafe[index])]),
      )
      : undefined;
    const sourceFixtureUnsafeFiles = sourceFixtureUnsafe.map(resolveExtensionTestPath);
    const sourceFixtureUnsafeAccountingContext = sourceFixtureUnsafeFiles.length
      ? await writeAccountingContext(
        tempDir,
        'source-fixture-unsafe',
        sourceFixtureUnsafeFiles,
        sourceFixtureUnsafeFiles.map((file) => [file, file]),
      )
      : undefined;

    if (costTable) {
      const weight = (file) => costTable[file.replace(/\\/gu, '/')] ?? 0;
      bundledFiles.sort((a, b) => weight(bundleSourcePath(b)) - weight(bundleSourcePath(a)));
    }
    if (bundledFiles.length > 0) {
      bundledRun = run(process.execPath, [...bundledArgs, ...bundledFiles], extensionPackageRoot, undefined, {
        PIE_LIVE_PIPELINE_TRACE_DIR: traceDirs[0],
        [TEST_FILE_ACCOUNTING_ENV]: bundledAccountingContext,
        TSX_TSCONFIG_PATH: tsxOverlay.configPath,
      }, signal);
    }
    const sourceFixtureArgs = ['--test', '--test-force-exit', '--test-concurrency=1', reporterArg];
    const sourceFixtureWave = [];
    if (sourceFixtureBundles.length > 0) {
      sourceFixtureWave.push(() => {
        sourceFixtureRun = run(process.execPath, [...sourceFixtureArgs, ...sourceFixtureBundles], extensionPackageRoot, undefined, {
          PIE_LIVE_PIPELINE_TRACE_DIR: traceDirs[2],
          [TEST_FILE_ACCOUNTING_ENV]: sourceFixtureBundleAccountingContext,
          TSX_TSCONFIG_PATH: tsxOverlay.configPath,
        }, signal);
        return sourceFixtureRun;
      });
    }
    if (sourceFixtureUnsafe.length > 0) {
      sourceFixtureWave.push(() => {
        sourceFixtureRun = run(
          process.execPath,
          [tsxCli, `--tsconfig=${tsxOverlay.configPath}`, ...sourceFixtureArgs, ...sourceFixtureUnsafe.map(resolveExtensionTestArgument)],
          extensionPackageRoot,
          undefined,
          {
            PIE_LIVE_PIPELINE_TRACE_DIR: traceDirs[2],
            [TEST_FILE_ACCOUNTING_ENV]: sourceFixtureUnsafeAccountingContext,
            TSX_TSCONFIG_PATH: tsxOverlay.configPath,
          }, signal,
        );
        return sourceFixtureRun;
      });
    }
    const results = await runSerializedExtensionWaves(
      [bundledRun, unsafeRun].filter(Boolean),
      sourceFixtureWave,
    );
    const report = mergeReports(
      results,
      performance.now() - startedAt,
      tempDir,
      safe,
      [...safe, ...unsafe].map(resolveExtensionTestPath),
    );
    process.stdout.write(`${REPORT_PREFIX}${JSON.stringify(report)}\n`);
    if (!report.summary.success) process.exitCode = 1;
    } finally {
      let unsafeTeardownError;
      if (unsafeChild?.exitCode === null && unsafeChild?.signalCode === null) {
        const cleanup = await killProcessTree(unsafeChild).catch(() => ({ gone: false }));
        if (!cleanup.gone) unsafeTeardownError = unconfirmedTeardownError('Unsafe extension wave teardown is unconfirmed');
      }
      const settledRuns = await Promise.allSettled([unsafeRun, bundledRun, sourceFixtureRun].filter(Boolean));
      const unconfirmedRun = settledRuns.find((result) => (
        result.status === 'rejected' && result.reason?.processTreeTeardownUnconfirmed
      ));
      if (unsafeTeardownError) throw unsafeTeardownError;
      if (unconfirmedRun) throw unconfirmedRun.reason;
    }
  });
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  const abort = abortOnProcessSignals();
  try {
    const selection = extractRuntimeArgs(process.argv.slice(2));
    if (selection.args.some((arg) => ['--help', '-h', '--list'].includes(arg))) {
      console.log('Usage: run-fast-extension-tests.mjs [--pi-runtime <absolute artifact root>]');
    } else {
      if (selection.args.length) throw new Error('Unknown fast extension runner argument');
      await withVerificationRuntime(selection, abort.signal, (runtime) => runSuite(runtime, abort.signal));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { abort.dispose(); }
}
