#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTsconfigOverlay, resolveSdkPackages } from '../lib/package-resolution.mjs';
import { resolveDevelopmentSdkWorkspaceRoot, withDevelopmentSdkReader } from '../lib/development-sdk-reader.mjs';
import { withoutGitRepositoryEnv } from '../lib/git-environment.mjs';
import { withoutPiHarnessEnv } from '../lib/pi-harness-env.mjs';
import { initializeTestEnvironment, resolveTestProcessDirectories } from './test-environment.mjs';
import { OWNERSHIP_STARTUP_TOKEN } from './ownership-startup.mjs';
import { runInNativeTestKeeper } from './native-test-keeper.mjs';
import { runOwnedTestDriver } from './owned-test-driver.mjs';
import {
  abortOnProcessSignals,
  resolveChildProcessTimeoutMs,
  watchChildProcess,
  withProcessTreeIsolation,
} from '../lib/process-watchdog.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TEST_FILE_PATTERN = /\.test\.(?:ts|tsx|mjs|js)$/u;
const EXPLICIT_E2E_PATTERN = /\.e2e\.ts$/u;
export const DEFAULT_TEST_CONCURRENCY = 4;
// Reserved CLI status for unconfirmed child-tree teardown; ordinary test failures normalize to 1.
export const TEST_TEARDOWN_UNCONFIRMED_EXIT_CODE = 125;
const DEFAULT_TSCONFIG = 'application/hosts/vscode/tsconfig.json';
const TEST_ENVIRONMENT_PRELOAD = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-environment.mjs')).href;

function repoRelativePath(root, input) {
  const absolute = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);
  const relative = path.relative(root, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Test path must stay within the repository: ${input}`);
  }
  return { absolute, relative: relative.split(path.sep).join('/') };
}

function literalPathspec(repoRelative) {
  return `:(top,literal)${repoRelative || '.'}`;
}

/** Normalize a repository-relative selection glob for platform-independent matching. */
function normalizeSelectionGlob(input, option) {
  const glob = input.replaceAll('\\', '/');
  if (!glob || path.isAbsolute(input) || path.win32.parse(input).root !== '') {
    throw new Error(`${option} requires a repository-relative glob: ${input}`);
  }
  const normalized = path.posix.normalize(glob);
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${option} glob must stay within the repository: ${input}`);
  }
  return normalized;
}

/**
 * List test files in directories from Git's index plus nonignored untracked
 * files. This intentionally does not walk the filesystem: ignored/generated
 * and untracked-ignored files are never discovered.
 */
export function discoverTrackedTests(root, directories, { execFile = execFileSync, env = process.env } = {}) {
  if (directories.length === 0) return [];
  const normalized = directories.map((directory) => repoRelativePath(root, directory));
  for (const { absolute } of normalized) {
    if (!statSync(absolute).isDirectory()) throw new Error(`Not a test directory: ${absolute}`);
  }
  const pathspecs = normalized.map(({ relative }) => literalPathspec(relative));
  const output = execFile('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...pathspecs], {
    cwd: root,
    env: withoutGitRepositoryEnv(env),
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  const text = Buffer.isBuffer(output) ? output.toString('utf8') : String(output);
  return [...new Set(text.split('\0').filter((file) => TEST_FILE_PATTERN.test(file)))].filter((file) => {
    try {
      return statSync(path.resolve(root, file)).isFile();
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
      throw error;
    }
  }).sort();
}

/** Parse runner options before selectors and native Node test flags after `--`. */
export function parseArgs(argv) {
  const selectors = [];
  const nodeFlags = [];
  const includeGlobs = [];
  const excludeGlobs = [];
  let tsconfig;
  let sdkPath;
  let sawSelector = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      nodeFlags.push(...argv.slice(index + 1));
      break;
    }
    const option = arg === '--tsconfig' || arg.startsWith('--tsconfig=')
      ? '--tsconfig'
      : arg === '--sdk-path' || arg.startsWith('--sdk-path=') ? '--sdk-path'
        : arg === '--include' || arg.startsWith('--include=') ? '--include'
          : arg === '--exclude' || arg.startsWith('--exclude=') ? '--exclude' : undefined;
    if (option) {
      if (sawSelector) throw new Error(`${option} must be supplied before test selectors.`);
      if (option === '--include' || option === '--exclude') {
        const value = arg === option ? argv[++index] : arg.slice(option.length + 1);
        if (!value || value === '--' || (arg === option && value.startsWith('--'))) {
          throw new Error(`${option} requires a repository-relative glob.`);
        }
        (option === '--include' ? includeGlobs : excludeGlobs).push(value);
        continue;
      }
      const current = option === '--tsconfig' ? tsconfig : sdkPath;
      if (current !== undefined) throw new Error(`${option} may be specified only once.`);
      const value = arg === option ? argv[++index] : arg.slice(option.length + 1);
      if (!value || value === '--' || (arg === option && value.startsWith('--'))) {
        throw new Error(`${option} requires a path.`);
      }
      if (option === '--tsconfig') tsconfig = value;
      else sdkPath = value;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option ${arg}. Runner options must precede selectors; forward native Node flags with test:file <selector> -- <flags>. Prefix a selector beginning with - with ./ instead.`);
    }
    sawSelector = true;
    selectors.push(arg);
  }
  return {
    selectors,
    nodeFlags,
    includeGlobs,
    excludeGlobs,
    ...(tsconfig === undefined ? {} : { tsconfig }),
    ...(sdkPath === undefined ? {} : { sdkPath }),
  };
}

/** Resolve a config selector without allowing overlays to extend outside this repository. */
export function resolveTsconfigPath(root, input) {
  const { absolute } = repoRelativePath(root, input);
  let info;
  try {
    info = statSync(absolute);
  } catch {
    throw new Error(`TypeScript config not found: ${input}`);
  }
  if (!info.isFile()) throw new Error(`Not a TypeScript config file: ${input}`);
  return absolute;
}

/** Resolve an explicit SDK package, requiring a complete executable package graph without acquiring a runtime. */
export function resolveTestSdkPath(root, input) {
  const sdkPath = path.isAbsolute(input) ? path.resolve(input) : repoRelativePath(root, input).absolute;
  const resolved = resolveSdkPackages({ sdkPath });
  for (const packageInfo of [resolved.sdk, ...Object.values(resolved.packages)]) {
    if (!packageInfo.entry || !existsSync(packageInfo.entry)) {
      throw new Error(`SDK candidate is not compiled: ${packageInfo.name} entry is missing at ${packageInfo.entry ?? packageInfo.root}`);
    }
  }
  // Match verifier paths, including Windows short OS-temp directory names.
  return realpathSync.native(resolved.sdk.root);
}

/** Build the optional alias overlay; the default pure node:test path stays setup-free. */
export function createRunnerTsconfigOverlay(root, { tsconfigPath, sdkPath } = {}) {
  if (tsconfigPath === undefined && sdkPath === undefined) return undefined;
  return createTsconfigOverlay(tsconfigPath ?? path.join(root, DEFAULT_TSCONFIG), {
    includeOwnerDependencies: true,
    nativeWorkspace: resolveDevelopmentSdkWorkspaceRoot(sdkPath, { root }) !== undefined,
    ...(sdkPath === undefined ? {} : { sdkPath }),
  });
}

/** Hold native SDK readers and config aliases until test-tree teardown is confirmed. */
export async function runNodeTestsWithOverlay(files, options = {}, dependencies = {}) {
  assertCoverageQualification(files, options.nodeFlags);
  const root = path.resolve(options.repoRoot ?? repoRoot);
  if (process.platform === 'win32' && resolveDevelopmentSdkWorkspaceRoot(options.sdkPath, { root })) {
    // Delegate BEFORE acquisition/validation/overlay. Injection of a legacy run
    // or overlay callback must never silently bypass production containment.
    return (dependencies.runInKeeper ?? runInNativeTestKeeper)(files, { ...options, repoRoot: root });
  }
  return runNodeTestsWithOverlayLocal(files, options, dependencies);
}

/** Explicit local seam for non-contained callers and isolated unit tests. */
export async function runNodeTestsWithOverlayLocal(files, options = {}, dependencies = {}) {
  assertCoverageQualification(files, options.nodeFlags);
  const root = options.repoRoot ?? repoRoot;
  const createOverlay = dependencies.createOverlay ?? createRunnerTsconfigOverlay;
  const run = dependencies.run ?? runNodeTests;
  return withDevelopmentSdkReader(options.sdkPath, async () => {
    const resolvedOptions = options.sdkPath === undefined
      ? options
      : { ...options, sdkPath: resolveTestSdkPath(root, options.sdkPath) };
    const overlay = createOverlay(root, resolvedOptions);
    let teardownConfirmed = true;
    try {
      const env = {
        ...(resolvedOptions.env ?? process.env),
        ...(overlay ? { TSX_TSCONFIG_PATH: overlay.configPath } : {}),
      };
      const result = await run(files, { ...resolvedOptions, env });
      if (result?.teardownConfirmed !== true) teardownConfirmed = false;
      return result;
    } catch (error) {
      if (error?.teardownUnconfirmed === true) teardownConfirmed = false;
      throw error;
    } finally {
      if (teardownConfirmed) overlay?.dispose();
    }
  }, { root });
}

/** Resolve explicit files and Git-discovered directory tests into unique paths. */
export function resolveTestFiles(root, selectors, options = {}) {
  return resolveSelectedTestFiles(root, selectors, options, new Set());
}

/** Internal owner-selection seam; never populated from public CLI options. */
export function resolveRetainedTestFiles(root, selectors, options, approvedEntries) {
  return resolveSelectedTestFiles(root, selectors, options, new Set(
    [...approvedEntries].map(file => path.resolve(root, file)),
  ));
}

function resolveSelectedTestFiles(root, selectors, options, approvedEntries) {
  if (selectors.length === 0) throw new Error('Provide at least one test directory or file.');
  const directories = [];
  const explicitFiles = [];
  for (const selector of selectors) {
    const { absolute, relative } = repoRelativePath(root, selector);
    let info;
    try {
      info = statSync(absolute);
    } catch {
      throw new Error(`Test path not found: ${relative}`);
    }
    if (info.isDirectory()) directories.push(absolute);
    else if (info.isFile()) {
      if (!TEST_FILE_PATTERN.test(relative) && !EXPLICIT_E2E_PATTERN.test(relative) && !approvedEntries.has(absolute)) {
        throw new Error(`Explicit test file must end in .test.{ts,tsx,mjs,js} or .e2e.ts: ${relative}`);
      }
      explicitFiles.push(absolute);
    } else {
      throw new Error(`Not a test file or directory: ${relative}`);
    }
  }
  const discovered = discoverTrackedTests(root, directories, options).map((file) => path.resolve(root, file));
  const files = [...new Set([...discovered, ...explicitFiles])].sort();
  const includeGlobs = (options.includeGlobs ?? []).map((glob) => normalizeSelectionGlob(glob, '--include'));
  const excludeGlobs = (options.excludeGlobs ?? []).map((glob) => normalizeSelectionGlob(glob, '--exclude'));
  const selected = files.filter((file) => {
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (includeGlobs.length > 0 && !includeGlobs.some((glob) => path.matchesGlob(relative, glob))) return false;
    return !excludeGlobs.some((glob) => path.matchesGlob(relative, glob));
  });
  if (selected.length === 0) {
    if (includeGlobs.length > 0 || excludeGlobs.length > 0) {
      const filters = [
        ...(includeGlobs.length > 0 ? [`--include ${includeGlobs.map((glob) => JSON.stringify(glob)).join(', ')}`] : []),
        ...(excludeGlobs.length > 0 ? [`--exclude ${excludeGlobs.map((glob) => JSON.stringify(glob)).join(', ')}`] : []),
      ];
      const remedy = includeGlobs.length > 0 && excludeGlobs.length === 0 ? 'the inclusion' : 'the filters';
      throw new Error(`No test files remain after applying ${filters.join(' and ')}; adjust or remove ${remedy}.`);
    }
    throw new Error(`No tracked or nonignored test files found under: ${directories.map((item) => path.relative(root, item)).join(', ')}`);
  }
  return selected;
}

const RUNNER_MODULE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-node-runner.mjs');

/** Translate native node:test CLI options to the public node:test run() API. */
export function parseNodeTestFlags(nodeFlags = [], concurrency = DEFAULT_TEST_CONCURRENCY) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Test concurrency must be a positive integer.');
  const options = { concurrency };
  const processFlags = [];
  const reporterNames = [];
  const reporterDestinations = [];
  const addArrayValue = (key, value) => { (options[key] ??= []).push(value); };
  const numberValue = (name, value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`${name} requires a number.`);
    return parsed;
  };

  for (let index = 0; index < nodeFlags.length; index += 1) {
    const arg = nodeFlags[index];
    const equalsAt = arg.indexOf('=');
    const name = equalsAt < 0 ? arg : arg.slice(0, equalsAt);
    const hasInlineValue = equalsAt >= 0;
    const takeValue = () => {
      const value = hasInlineValue ? arg.slice(equalsAt + 1) : nodeFlags[++index];
      if (value === undefined || value === '' || value === '--') throw new Error(`${name} requires a value.`);
      return value;
    };
    const takeBoolean = () => {
      if (hasInlineValue) throw new Error(`${name} does not accept a value.`);
    };

    if (name === '--test') continue;
    if (name === '--test-concurrency') options.concurrency = numberValue(name, takeValue());
    else if (name === '--test-name-pattern') addArrayValue('testNamePatterns', takeValue());
    else if (name === '--test-skip-pattern') addArrayValue('testSkipPatterns', takeValue());
    else if (name === '--test-timeout') options.timeout = numberValue(name, takeValue());
    else if (name === '--test-reporter') reporterNames.push(takeValue());
    else if (name === '--test-reporter-destination') reporterDestinations.push(takeValue());
    else if (name === '--test-coverage-lines') options.lineCoverage = numberValue(name, takeValue());
    else if (name === '--test-coverage-branches') options.branchCoverage = numberValue(name, takeValue());
    else if (name === '--test-coverage-functions') options.functionCoverage = numberValue(name, takeValue());
    else if (name === '--test-coverage-include') addArrayValue('coverageIncludeGlobs', takeValue());
    else if (name === '--test-coverage-exclude') addArrayValue('coverageExcludeGlobs', takeValue());
    else if (name === '--test-isolation' || name === '--experimental-test-isolation') {
      const isolation = takeValue();
      if (isolation !== 'process') throw new Error('The standard node runner requires --test-isolation=process.');
    } else if (name === '--test-global-setup') options.globalSetupPath = takeValue();
    else if (name === '--test-rerun-failures') options.rerunFailuresFilePath = takeValue();
    else if (name === '--test-shard') {
      const match = /^(\d+)\/(\d+)$/u.exec(takeValue());
      if (!match) throw new Error(`${name} requires an index/total pair.`);
      options.shard = { index: Number(match[1]), total: Number(match[2]) };
    } else if (name === '--test-random-seed') options.randomSeed = numberValue(name, takeValue());
    else if (name === '--test-force-exit') { takeBoolean(); options.forceExit = true; }
    else if (name === '--test-only') { takeBoolean(); options.only = true; }
    else if (name === '--test-randomize') { takeBoolean(); options.randomize = true; }
    else if (name === '--experimental-test-coverage') { takeBoolean(); options.coverage = true; }
    else processFlags.push(arg);
  }
  const reporterCount = reporterNames.length || 1;
  if (reporterDestinations.length > 0 && reporterDestinations.length !== reporterCount) {
    throw new Error('Each --test-reporter requires a matching --test-reporter-destination.');
  }
  return { options, processFlags, reporterNames, reporterDestinations };
}

/** Reject native coverage for TypeScript entries until the adapter's source-map report is qualified. */
export function assertCoverageQualification(files, nodeFlags = []) {
  const { options } = parseNodeTestFlags(nodeFlags);
  if (options.coverage && files.some((file) => /\.(?:ts|tsx)$/u.test(file))) {
    throw new Error(
      'TypeScript native coverage unqualified; retained legacy coverage gate. ' +
      'Remove --experimental-test-coverage when selecting TypeScript test files.',
    );
  }
}

/** Build private CJS entries for TypeScript tests while leaving native JS/ESM entries untouched. */
export function createNodeTestEntries(files, directory) {
  mkdirSync(directory, { recursive: true });
  const sourceFileByEntry = {};
  const entries = files.map((file, index) => {
    const sourceFile = path.resolve(file);
    if (!/\.(?:ts|tsx)$/u.test(sourceFile)) return sourceFile;
    const entry = path.join(directory, `entry-${index}.cjs`);
    writeFileSync(entry,
      `const { createRequire } = require('node:module');\n` +
      `createRequire(${JSON.stringify(sourceFile)})(${JSON.stringify(sourceFile)});\n`);
    sourceFileByEntry[entry] = sourceFile;
    return entry;
  });
  return { files: entries, sourceFileByEntry };
}

function defaultHeapArgs(processFlags, env) {
  // Node accepts hyphens/underscores and either inline or separate values.
  // Do not mask NODE_OPTIONS: a CLI default would take precedence over it.
  const heapOption = /^--max[-_]old[-_]space[-_]size(?:=|$)/u;
  const environmentHeapOption = /(?:^|\s|")--max[-_]old[-_]space[-_]size(?:=|\s|"|$)/u;
  return processFlags.some(flag => heapOption.test(flag)) || environmentHeapOption.test(env.NODE_OPTIONS ?? '')
    ? [] : ['--max-old-space-size=1024'];
}

/** Build a bounded Node invocation; discovered test paths stay in a temp config file. */
export function buildNodeArgs(configPath, nodeFlags = [], concurrency = DEFAULT_TEST_CONCURRENCY, env = process.env) {
  const { processFlags } = parseNodeTestFlags(nodeFlags, concurrency);
  return [
    ...defaultHeapArgs(processFlags, env),
    // Inline values match Node's inherited flag representation. Split values
    // are otherwise forwarded again as unrecognized process.execArgv entries.
    `--import=${TEST_ENVIRONMENT_PRELOAD}`,
    '--import=tsx',
    ...processFlags,
    RUNNER_MODULE,
    configPath,
  ];
}

/**
 * Build a sanitized test environment with fresh, empty user/auth/data/agent
 * directories. Tests may still choose or replace their own fixture paths in
 * their process; no credentials or user files are copied into this tree.
 */
export function createTestEnvironment(source = process.env, { fixtureRoot } = {}) {
  const ownsFixtureRoot = fixtureRoot === undefined;
  const root = ownsFixtureRoot
    ? mkdtempSync(path.join(os.tmpdir(), 'pie-node-tests-'))
    : path.resolve(fixtureRoot);
  mkdirSync(root, { recursive: true });
  const env = withoutPiHarnessEnv(withoutGitRepositoryEnv(source));
  delete env.NODE_TEST_CONTEXT;
  delete env.TSX_TSCONFIG_PATH;
  env.PIE_TEST_FIXTURE_ROOT = root;
  const directories = resolveTestProcessDirectories(root, process.pid);
  initializeTestEnvironment(env, process.pid);
  let disposed = false;
  return {
    env,
    root,
    directories,
    dispose() {
      if (disposed || !ownsFixtureRoot) return;
      disposed = true;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Shared config, entries and argument generation for both lifetime drivers. */
export function prepareNodeTestInvocation(files, { nodeFlags = [], cwd = repoRoot, waitForOwnership = true,
  loaderMode = 'compatibility-cjs', isolation = 'process', startupArgs, env = process.env } = {}) {
  if (!['compatibility-cjs', 'retained-esm'].includes(loaderMode)) throw new Error(`Unknown test loader mode: ${loaderMode}`);
  if (loaderMode === 'retained-esm' && !startupArgs?.length) throw new Error('Retained ESM mode requires the owner-pinned tsx startup.');
  if (!['process', 'none'].includes(isolation) || (isolation === 'none' && loaderMode !== 'retained-esm')) {
    throw new Error('Isolation none requires internal retained ESM mode.');
  }
  assertCoverageQualification(files, nodeFlags);
  const parsedFlags = parseNodeTestFlags(nodeFlags);
  const configRoot = mkdtempSync(path.join(os.tmpdir(), 'pie-node-runner-'));
  const configPath = path.join(configRoot, 'runner.json');
  let testEntries;
  try {
    testEntries = loaderMode === 'retained-esm'
      ? { files: files.map(file => path.resolve(file)), sourceFileByEntry: {} }
      : createNodeTestEntries(files, path.join(configRoot, 'entries'));
    writeFileSync(configPath, JSON.stringify({
      files: testEntries.files,
      sourceFileByEntry: testEntries.sourceFileByEntry,
      cwd,
      options: { ...parsedFlags.options, isolation },
      reporterNames: parsedFlags.reporterNames,
      reporterDestinations: parsedFlags.reporterDestinations,
      waitForOwnership,
    }));
  } catch (error) {
    rmSync(configRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    configRoot, configPath, args: loaderMode === 'retained-esm'
      // With isolation none, Node registers tests in this process: its global
      // harness reads CLI flags (run() options alone do not apply name filters).
      ? [...defaultHeapArgs([...startupArgs, ...parsedFlags.processFlags], env), ...startupArgs, ...(isolation === 'none' ? nodeFlags.filter(flag => flag !== '--test') : parsedFlags.processFlags), RUNNER_MODULE, configPath]
      : buildNodeArgs(configPath, nodeFlags, DEFAULT_TEST_CONCURRENCY, env),
    dispose() { rmSync(configRoot, { recursive: true, force: true }); },
  };
}

/** Keeper-only local entry: same runner/scheduler, kernel containment authority. */
export function runOwnedNodeTests(files, options = {}, dependencies = {}) {
  const resolved = { cwd: repoRoot, env: process.env, timeoutMs: resolveChildProcessTimeoutMs(), ...options };
  const invocation = prepareNodeTestInvocation(files, resolved);
  return runOwnedTestDriver(invocation, resolved, dependencies);
}

/** Run one native node:test command and wait for watchdog-confirmed teardown. */
export function runNodeTests(files, {
  nodeFlags = [],
  cwd = repoRoot,
  env = process.env,
  signal,
  sdkPath,
  spawnImpl = spawn,
  watchChildProcessImpl = watchChildProcess,
  writeTeardownDiagnosticImpl = writeFileSync,
  timeoutMs = resolveChildProcessTimeoutMs(),
} = {}) {
  const { configRoot, configPath, args } = prepareNodeTestInvocation(files, { nodeFlags, cwd, env });
  return new Promise((resolve, reject) => {
    const teardownDiagnosticPath = path.join(configRoot, 'teardown.json');
    let child;
    try {
      child = spawnImpl(process.execPath, args, withProcessTreeIsolation({
        cwd,
        env,
        stdio: ['pipe', 'inherit', 'inherit'],
        windowsHide: true,
      }));
    } catch (error) {
      rmSync(configRoot, { recursive: true, force: true });
      reject(error);
      return;
    }
    let watchdog;
    try {
      watchdog = watchChildProcessImpl(child, {
        timeoutMs,
        signal,
        label: 'standard node tests',
        onTerminate: ({ reason }) => {
          const detail = reason === 'timeout' ? ` after ${timeoutMs}ms` : '';
          console.error(`\n✖ Test process ${reason === 'timeout' ? 'timed out' : `was aborted (${signal?.reason?.message ?? 'signal'})`}${detail}; terminating its process tree.`);
        },
      });
    } catch (error) {
      reject(Object.assign(new Error('Node test child watchdog setup failed; process-tree teardown is unconfirmed.'), {
        cause: error,
        teardownUnconfirmed: true,
      }));
      return;
    }
    child.on('error', (error) => { child.spawnError = error; });
    child.stdin?.on('error', (error) => { child.spawnError = error; });
    child.on('close', async (code) => {
      const cleanup = await watchdog.settle().catch((error) => ({
        gone: false,
        diagnostics: [`watchdog cleanup failed: ${error?.message ?? error}`],
      }));
      if (cleanup?.gone !== true) {
        const ownedProcesses = Array.isArray(cleanup.ownedProcesses) ? cleanup.ownedProcesses : [];
        const survivorProcesses = Array.isArray(cleanup.survivorProcesses) ? cleanup.survivorProcesses : [];
        const whyUnknown = [];
        if (Array.isArray(cleanup.survivors) && cleanup.survivors.length > 0) {
          whyUnknown.push(`watchdog still observed captured PID(s) alive after bounded teardown: ${cleanup.survivors.join(', ')}`);
        } else {
          whyUnknown.push('watchdog reported gone:false without survivor PID details');
        }
        if (!Array.isArray(cleanup.ownedProcesses)) whyUnknown.push('watchdog did not return captured process identity snapshots');
        for (const entry of ownedProcesses) {
          if (entry.identity == null) whyUnknown.push(`captured process ${entry.pid} has no creation identity`);
        }
        if ((cleanup.survivors?.length ?? 0) > 0 && survivorProcesses.length === 0) {
          whyUnknown.push('watchdog did not return captured identity snapshots for surviving PIDs');
        }
        const teardownError = Object.assign(new Error('Node test process tree teardown is unconfirmed'), {
          teardownUnconfirmed: true,
        });
        const diagnostic = {
          capturedAt: new Date().toISOString(),
          rootChildPid: child.pid ?? null,
          owner: { pid: process.pid, executable: process.execPath, cwd: path.resolve(cwd) },
          sdkSelection: { explicit: sdkPath !== undefined, path: sdkPath ?? null },
          gone: cleanup.gone === true,
          ownedPids: cleanup.ownedPids ?? [],
          survivors: cleanup.survivors ?? [],
          ownedProcesses,
          survivorProcesses,
          diagnostics: cleanup.diagnostics ?? [],
          whyUnknown,
        };
        try {
          writeTeardownDiagnosticImpl(teardownDiagnosticPath, `${JSON.stringify(diagnostic, null, 2)}\n`);
          teardownError.diagnosticPath = teardownDiagnosticPath;
        } catch (diagnosticWriteError) {
          teardownError.diagnosticWriteError = diagnosticWriteError;
        }
        reject(teardownError);
        return;
      }
      // An outer tree-empty proof cannot discharge a nested owner's uncertainty.
      if (code === TEST_TEARDOWN_UNCONFIRMED_EXIT_CODE) {
        reject(Object.assign(new Error('Nested test teardown is unconfirmed'), {
          teardownUnconfirmed: true, diagnosticPath: configRoot,
          // Diagnostic scope only, never authority to release nested readers.
          enclosingTeardownConfirmed: true,
        }));
        return;
      }
      rmSync(configRoot, { recursive: true, force: true });
      if (child.spawnError) reject(child.spawnError);
      else resolve({ code: watchdog.timedOut || watchdog.aborted ? 1 : (code ?? 1), teardownConfirmed: true });
    });
    // watchChildProcess completes its bounded live census before returning.
    // Never release a short suite on failed or aborted ownership capture.
    if (watchdog.ownershipReady === true && !watchdog.terminationStarted) {
      child.stdin.end(OWNERSHIP_STARTUP_TOKEN);
    } else {
      child.spawnError = new Error('Node test watchdog ownership startup handshake failed');
      void watchdog.settle().catch(() => {});
    }
  });
}

function printHelp() {
  console.log(
    'Usage: node scripts/verification/test-node.mjs [--tsconfig <repo config>] [--sdk-path <SDK package>] [--include <repo-relative glob>...] [--exclude <repo-relative glob>...] <repo-relative directory-or-file>... [-- <Node test flags>]\n\n' +
    'Discover tracked and nonignored .test.{ts,tsx,mjs,js} files in directories, or run explicit test files.\n' +
    'Repeat --include to select files matching any include glob; repeat --exclude to filter matching files from directory discovery and explicit selections. Excludes take precedence.\n' +
    'Explicit .e2e.ts files are supported. Tests run with native node:test process isolation and concurrency 4.\n' +
    'TypeScript files use private temporary CJS entries; .js and .mjs files keep native Node loading.\n' +
    'Optional tsconfig/SDK aliases use a temporary config overlay; --sdk-path verifies an already compiled package and never acquires a runtime.\n' +
    'Runner options precede selectors; Node test flags are forwarded after --.',
  );
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    printHelp();
    return;
  }
  let files;
  let tsconfigPath;
  let sdkPath;
  let concurrency = DEFAULT_TEST_CONCURRENCY;
  let parsed;
  try {
    parsed = parseArgs(argv);
    concurrency = parseNodeTestFlags(parsed.nodeFlags).options.concurrency;
    if (parsed.tsconfig !== undefined) tsconfigPath = resolveTsconfigPath(repoRoot, parsed.tsconfig);
    if (parsed.sdkPath !== undefined) sdkPath = parsed.sdkPath;
    files = resolveTestFiles(repoRoot, parsed.selectors, {
      includeGlobs: parsed.includeGlobs,
      excludeGlobs: parsed.excludeGlobs,
    });
    assertCoverageQualification(files, parsed.nodeFlags);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const fixture = (dependencies.createTestEnvironment ?? createTestEnvironment)();
  const processAbort = (dependencies.abortOnProcessSignals ?? abortOnProcessSignals)();
  let teardownConfirmed = true;
  try {
    console.log(`▶ node:test (${files.length} file${files.length === 1 ? '' : 's'}, concurrency ${concurrency})`);
    const runWithOverlay = dependencies.runNodeTestsWithOverlay ?? runNodeTestsWithOverlay;
    const result = await runWithOverlay(files, {
      nodeFlags: parsed.nodeFlags,
      env: fixture.env,
      signal: processAbort.signal,
      repoRoot,
      tsconfigPath,
      sdkPath,
    });
    teardownConfirmed = result.teardownConfirmed === true;
    if (result.code !== 0) process.exitCode = 1;
  } catch (error) {
    teardownConfirmed = error?.teardownUnconfirmed !== true;
    console.error(formatCliError(error));
    process.exitCode = error?.teardownUnconfirmed === true ? TEST_TEARDOWN_UNCONFIRMED_EXIT_CODE : 1;
  } finally {
    if (teardownConfirmed) {
      processAbort.dispose();
      fixture.dispose();
    }
  }
}

function formatCliError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return error?.diagnosticPath ? `${message}\nDiagnostic: ${error.diagnosticPath}` : message;
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) await main();
