#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withoutGitRepositoryEnv } from '../lib/git-environment.mjs';
import { withoutPiHarnessEnv } from '../lib/pi-harness-env.mjs';
import { createTsconfigOverlay, resolveTypeScriptCompiler } from '../lib/package-resolution.mjs';
import { resolveDevelopmentSdkWorkspaceRoot, withDevelopmentSdkReader } from '../lib/development-sdk-reader.mjs';
import { runInNativeTrustedKeeper } from './native-test-keeper.mjs';
import { runOwnedTestDriver } from './owned-test-driver.mjs';
import {
  abortOnProcessSignals,
  resolveChildProcessTimeoutMs,
  watchChildProcess,
  withProcessTreeIsolation,
} from '../lib/process-watchdog.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const rootRequire = createRequire(path.join(repoRoot, 'package.json'));
const TOOLCHAIN_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  '.prototools',
  'harness/pi/package.json',
];

function addFileHash(hash, filename, label = filename) {
  if (!existsSync(filename) || !statSync(filename).isFile()) return;
  hash.update(label).update('\0').update(readFileSync(filename)).update('\0');
}

function resolveExtendedConfig(parentPath, specifier) {
  if (path.isAbsolute(specifier) || specifier.startsWith('.')) {
    const base = path.resolve(path.dirname(parentPath), specifier);
    const candidates = path.extname(base) ? [base] : [base, `${base}.json`, path.join(base, 'tsconfig.json')];
    return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  }
  try {
    return createRequire(parentPath).resolve(specifier);
  } catch {
    try { return createRequire(parentPath).resolve(`${specifier}/tsconfig.json`); }
    catch { return undefined; }
  }
}

function collectConfigFiles(configPath, compiler) {
  const result = [];
  const visited = new Set();
  const visit = (filePath) => {
    let absolute;
    try { absolute = realpathSync(filePath); }
    catch { absolute = path.resolve(filePath); }
    if (visited.has(absolute) || !existsSync(absolute)) return;
    visited.add(absolute);
    result.push(absolute);
    let parsed;
    try {
      const contents = readFileSync(absolute, 'utf8');
      parsed = compiler.parseConfigFileTextToJson(absolute, contents).config;
    } catch {
      return;
    }
    const extended = parsed?.extends === undefined ? [] : Array.isArray(parsed.extends) ? parsed.extends : [parsed.extends];
    for (const specifier of extended) {
      if (typeof specifier !== 'string') continue;
      const target = resolveExtendedConfig(absolute, specifier);
      if (target) visit(target);
    }
  };
  visit(configPath);
  return result;
}

/** Stable compiler-state key: changes invalidate state but never skip a check. */
export function createTypecheckCacheKey({ configPath, compilerPath, sdkPath, root = repoRoot, compiler } = {}) {
  const hash = createHash('sha256');
  hash.update('pie-typecheck-cache-v1\0');
  const absoluteRoot = path.resolve(root);
  const absoluteConfig = path.resolve(absoluteRoot, configPath);
  const absoluteCompiler = path.resolve(compilerPath);
  const typescript = compiler ?? rootRequire('typescript');
  hash.update(`node=${process.version};platform=${process.platform};arch=${process.arch}\0`);
  hash.update(`compiler=${realpathSync(absoluteCompiler)}\0`);
  addFileHash(hash, absoluteCompiler, 'compiler-entry');
  for (const config of collectConfigFiles(absoluteConfig, typescript)) addFileHash(hash, config, `config:${config}`);
  for (const filename of TOOLCHAIN_FILES) addFileHash(hash, path.join(absoluteRoot, filename), `toolchain:${filename}`);
  const typescriptManifest = path.join(path.dirname(absoluteCompiler), '..', 'package.json');
  addFileHash(hash, typescriptManifest, 'typescript-package');
  if (sdkPath !== undefined) {
    const absoluteSdkPath = path.resolve(absoluteRoot, sdkPath);
    const sdkRealPath = realpathSync(absoluteSdkPath);
    hash.update(`sdk=${sdkRealPath}\0`);
    addFileHash(hash, path.join(sdkRealPath, 'package.json'), 'sdk-package');
    const artifactRoot = path.resolve(sdkRealPath, '../../..');
    addFileHash(hash, path.join(artifactRoot, 'manifest.json'), 'sdk-runtime-manifest');
    for (const filename of ['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock']) {
      addFileHash(hash, path.join(artifactRoot, filename), `sdk-runtime-lock:${filename}`);
    }
  } else {
    hash.update('sdk=none\0');
  }
  return hash.digest('hex');
}

export function parseArgs(argv) {
  let config;
  let sdkPath;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--sdk-path' || arg.startsWith('--sdk-path=')) {
      if (sdkPath !== undefined) throw new Error('--sdk-path may be specified only once.');
      const value = arg === '--sdk-path' ? argv[++index] : arg.slice('--sdk-path='.length);
      if (!value || value.startsWith('--')) throw new Error('--sdk-path requires an SDK package directory.');
      sdkPath = value;
      continue;
    }
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg.startsWith('-')) throw new Error(`Unknown argument: ${arg}`);
    if (config !== undefined) throw new Error(`Only one TypeScript project config may be checked; unexpected argument: ${arg}`);
    config = arg;
  }
  if (config === undefined) throw new Error('Provide a TypeScript project config file.');
  return { config, ...(sdkPath === undefined ? {} : { sdkPath }), help: false };
}

export function buildTypecheckArgs(configPath, tsBuildInfoPath) {
  return ['--noEmit', '--incremental', '--project', configPath, '--tsBuildInfoFile', tsBuildInfoPath];
}

function projectCompiler(root = repoRoot) {
  return resolveTypeScriptCompiler({ dependencyOwnerRoot: path.resolve(root) });
}

/** Keeper-process typecheck entry. The lease has acquired the workspace reader
 * before this validation/cache/overlay work began; the compiler child runs
 * through the single kernel owned driver and its reader is released only on
 * that driver's verified matching tree-empty proof. Ordinary tsc children wait
 * on no ownership preload (the Job already contains their tree), so startup
 * authorization is a no-token stdin close, and the compiler output is
 * collected and returned instead of forwarded.
 */
export async function runOwnedTypecheck(invocation, options = {}, owner = {}) {
  const absoluteRoot = path.resolve(owner.baseRoot ?? repoRoot);
  const absoluteConfig = path.resolve(invocation.configPath);
  if (!existsSync(absoluteConfig) || !statSync(absoluteConfig).isFile()) {
    throw new Error(`TypeScript project config not found: ${absoluteConfig}`);
  }
  const absoluteSdk = options.sdkPath === undefined ? undefined : path.resolve(options.sdkPath);
  const absoluteCompiler = path.resolve(options.compilerPath ?? projectCompiler(absoluteRoot));
  const compiler = rootRequire('typescript');
  const key = createTypecheckCacheKey({
    configPath: absoluteConfig,
    compilerPath: absoluteCompiler,
    ...(absoluteSdk === undefined ? {} : { sdkPath: absoluteSdk }),
    root: absoluteRoot,
    compiler,
  });
  const cacheDirectory = path.join(absoluteRoot, '.cache', 'typecheck', key);
  mkdirSync(cacheDirectory, { recursive: true });
  const overlay = createTsconfigOverlay(absoluteConfig, {
    typescript: true,
    includeOwnerDependencies: true,
    nativeWorkspace: resolveDevelopmentSdkWorkspaceRoot(absoluteSdk, { root: absoluteRoot }) !== undefined,
    directory: cacheDirectory,
    ...(absoluteSdk === undefined ? {} : { sdkPath: absoluteSdk }),
  });
  owner.overlay = overlay;
  const buildInfoPath = path.join(cacheDirectory, 'project.tsbuildinfo');
  const args = buildTypecheckArgs(overlay.configPath, buildInfoPath);
  const childEnv = withoutPiHarnessEnv(withoutGitRepositoryEnv(options.env ?? process.env));
  delete childEnv.NODE_TEST_CONTEXT;
  await owner.writeLifetime?.({ overlayPath: overlay.configPath, cacheDirectory, compilerPath: absoluteCompiler });
  owner.markAdmission?.();
  let terminationNotice = '';
  const result = await runOwnedTestDriver({
    configRoot: cacheDirectory,
    args: [absoluteCompiler, ...args],
    dispose() {},
  }, {
    cwd: absoluteRoot,
    env: childEnv,
    signal: options.signal,
    timeoutMs: resolveChildProcessTimeoutMs(),
    // Ordinary tsc waits on no ownership handshake: the Job already contains
    // its whole tree at creation. Empty startup authorization closes the
    // child's stdin without writing a byte.
    authorizationText: '',
    collectOutput: true,
    onTerminate: ({ reason }) => {
      const detail = reason === 'timeout' ? ` after ${resolveChildProcessTimeoutMs()}ms` : '';
      terminationNotice = `\nTypecheck process ${reason === 'timeout' ? 'timed out' : 'was aborted'}${detail}; terminating its process tree.\n`;
    },
  }, { ...owner });
  return {
    code: result.code,
    output: (result.output ?? '') + terminationNotice,
    cacheDirectory,
    teardownConfirmed: true,
  };
}

/** Explicit local seam for non-contained callers and isolated unit tests;
 * native Windows workspace readers must be held by the keeper via the shared
 * kernel owned driver instead. */
export function runTypecheckLocal({
  configPath,
  sdkPath,
  signal,
  root = repoRoot,
  compilerPath = projectCompiler(root),
  spawnImpl = spawn,
  watchChildProcessImpl = watchChildProcess,
  writeDiagnosticImpl = writeFileSync,
}) {
  const absoluteRoot = path.resolve(root);
  const absoluteConfig = path.resolve(absoluteRoot, configPath);
  if (!existsSync(absoluteConfig) || !statSync(absoluteConfig).isFile()) {
    throw new Error(`TypeScript project config not found: ${absoluteConfig}`);
  }
  const absoluteSdk = sdkPath === undefined ? undefined : path.resolve(absoluteRoot, sdkPath);
  return withDevelopmentSdkReader(absoluteSdk, () => {
    const compiler = rootRequire('typescript');
    const key = createTypecheckCacheKey({
      configPath: absoluteConfig,
      compilerPath,
      ...(absoluteSdk === undefined ? {} : { sdkPath: absoluteSdk }),
      root: absoluteRoot,
      compiler,
    });
    const cacheDirectory = path.join(absoluteRoot, '.cache', 'typecheck', key);
    mkdirSync(cacheDirectory, { recursive: true });
    const overlay = createTsconfigOverlay(absoluteConfig, {
      typescript: true,
      includeOwnerDependencies: true,
      nativeWorkspace: resolveDevelopmentSdkWorkspaceRoot(absoluteSdk, { root: absoluteRoot }) !== undefined,
      directory: cacheDirectory,
      ...(absoluteSdk === undefined ? {} : { sdkPath: absoluteSdk }),
    });
    const buildInfoPath = path.join(cacheDirectory, 'project.tsbuildinfo');
    const args = buildTypecheckArgs(overlay.configPath, buildInfoPath);
    const childEnv = withoutPiHarnessEnv(withoutGitRepositoryEnv(process.env));
    delete childEnv.NODE_TEST_CONTEXT;
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnImpl(process.execPath, [compilerPath, ...args], withProcessTreeIsolation({
          cwd: absoluteRoot,
          env: childEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        }));
      } catch (error) {
        reject(error);
        return;
      }
      let output = '';
      const timeoutMs = resolveChildProcessTimeoutMs();
      let watchdog;
      const bounded = (value, limit = 2048) => String(value ?? '').replace(/(bearer\s+|(?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]').slice(-limit);
      const uncertain = (cause, cleanup) => {
        const error = cause instanceof Error ? cause : new Error('TypeScript typecheck process tree teardown is unconfirmed');
        const diagnosticPath = path.join(cacheDirectory, `teardown-${randomUUID()}.json`);
        Object.assign(error, { teardownUnconfirmed: true, diagnosticPath, root: absoluteRoot, cacheDirectory, overlayPath: overlay.configPath });
        const processes = entries => (Array.isArray(entries) ? entries : []).slice(0, 64).map(entry => ({
          pid: entry.pid, ppid: entry.ppid, identity: bounded(entry.identity, 128), creationDate: bounded(entry.creationDate, 128),
        }));
        const evidence = {
          root: bounded(absoluteRoot), compiler: bounded(path.resolve(compilerPath)), config: bounded(absoluteConfig),
          cacheDirectory: bounded(cacheDirectory), overlayPath: bounded(overlay.configPath), childPid: child.pid ?? null,
          gone: false, timedOut: watchdog?.timedOut === true, aborted: watchdog?.aborted === true,
          diagnostics: (cleanup?.diagnostics ?? ['Tree extinction was not confirmed; absent identities remain unknown']).slice(0, 32).map(value => bounded(value)),
          ownedProcesses: processes(cleanup?.ownedProcesses), survivorProcesses: processes(cleanup?.survivorProcesses),
          output: bounded(output, 16384), settlementCause: cause ? bounded(cause.message ?? cause) : null,
          evidenceScope: 'current invocation only; missing identity evidence is unknown',
        };
        try { writeDiagnosticImpl(diagnosticPath, `${JSON.stringify(evidence)}\n`, { flag: 'wx', mode: 0o600 }); }
        catch (diagnosticWriteError) { error.diagnosticWriteError = diagnosticWriteError; }
        reject(error);
      };
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
      child.on('error', (error) => { child.spawnError = error; });
      try {
        watchdog = watchChildProcessImpl(child, {
          timeoutMs,
          signal,
          label: 'TypeScript typecheck',
          onTerminate: ({ reason }) => {
            const detail = reason === 'timeout' ? ` after ${timeoutMs}ms` : '';
            output += `\nTypecheck process ${reason === 'timeout' ? 'timed out' : 'was aborted'}${detail}; terminating its process tree.\n`;
          },
        });
      } catch (error) {
        uncertain(error);
        return;
      }
      child.on('close', async (code) => {
        let cleanup;
        try { cleanup = await watchdog.settle(); }
        catch (error) { uncertain(error); return; }
        if (cleanup?.gone !== true) {
          uncertain(child.spawnError, cleanup);
          return;
        }
        if (child.spawnError) {
          reject(child.spawnError);
          return;
        }
        resolve({
          code: watchdog.timedOut || watchdog.aborted ? 1 : (code ?? 1),
          output,
          cacheDirectory,
          teardownConfirmed: true,
        });
      });
    });
  }, { root: absoluteRoot });
}

/** Execute a single project. The incremental state only accelerates TS itself.
 * On Windows, an explicit native-workspace SDK reader is delegated to the
 * detached keeper (which acquires before validation/overlay and releases only
 * on the shared kernel owned driver's matching tree-empty proof); materialized
 * and non-Windows selections keep the local watchdog lifetime. */
export function runTypecheck({
  configPath,
  sdkPath,
  signal,
  root = repoRoot,
  compilerPath = projectCompiler(root),
  spawnImpl = spawn,
  watchChildProcessImpl = watchChildProcess,
  runInKeeper,
}) {
  const absoluteRoot = path.resolve(root);
  const absoluteConfig = path.resolve(absoluteRoot, configPath);
  if (!existsSync(absoluteConfig) || !statSync(absoluteConfig).isFile()) {
    throw new Error(`TypeScript project config not found: ${absoluteConfig}`);
  }
  const absoluteSdk = sdkPath === undefined ? undefined : path.resolve(absoluteRoot, sdkPath);
  if (process.platform === 'win32' && absoluteSdk !== undefined
    && resolveDevelopmentSdkWorkspaceRoot(absoluteSdk, { root: absoluteRoot })) {
    // Delegate BEFORE acquisition/validation/overlay. The local runner
    // injections (spawnImpl/watchChildProcessImpl) are local-route seams and
    // must never silently bypass production containment.
    return (runInKeeper ?? runInNativeTrustedKeeper)('typecheck', { configPath: absoluteConfig }, {
      repoRoot: absoluteRoot,
      cwd: repoRoot,
      sdkPath: absoluteSdk,
      compilerPath: path.resolve(compilerPath),
      signal,
    });
  }
  return runTypecheckLocal({
    configPath: absoluteConfig,
    ...(absoluteSdk === undefined ? {} : { sdkPath: absoluteSdk }),
    signal,
    root: absoluteRoot,
    compilerPath,
    spawnImpl,
    watchChildProcessImpl,
  });
}

function printHelp() {
  console.log('Usage: node scripts/verification/typecheck-project.mjs <tsconfig.json> [--sdk-path <SDK package directory>]');
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) return printHelp();
    options.config = path.resolve(repoRoot, options.config);
    if (options.sdkPath !== undefined) options.sdkPath = path.resolve(repoRoot, options.sdkPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  const processAbort = abortOnProcessSignals();
  let teardownConfirmed = true;
  try {
    console.log(`▶ TypeScript ${path.relative(repoRoot, options.config)}`);
    const result = await runTypecheck({ configPath: options.config, sdkPath: options.sdkPath, signal: processAbort.signal });
    if (result.output.trim()) process.stdout.write(result.output);
    if (result.code === 0) console.log(`✓ Typecheck passed (compiler state: ${path.relative(repoRoot, result.cacheDirectory)})`);
    else process.exitCode = 1;
  } catch (error) {
    teardownConfirmed = error?.teardownUnconfirmed !== true;
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    if (teardownConfirmed) processAbort.dispose();
  }
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) await main();
