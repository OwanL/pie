import { watch as fsWatch, mkdirSync } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import {
  findCompatibleInstalledExtensionDir,
  publishRendererGeneration,
} from './publication.mjs';
import { hasRuntimeBootstrap, installRuntimeBootstrap, publishRuntimeGeneration, resolveRuntimeGeneration } from './runtime-publication.mjs';
import { createTsconfigOverlay, resolveOwnerModule, resolvePackageRoots, resolveTypeScriptCompiler } from '../lib/package-resolution.mjs';
import { withPiRuntime } from '../lib/pi-runtime-context.mjs';
import { verifyPiRuntimeArtifact } from '../lib/pi-runtime-artifact.mjs';

// The distribution root follows the planned package layout: the VS Code host
// package and its dependency owner live under application/hosts/vscode.
const { distributionRoot: rootDir, repositoryRoot } = resolvePackageRoots('planned');

// An isolated validation owns a NEW external directory. Never clean an existing
// caller directory, the checkout, dependencies, or an installed extension.
// This is a one-shot CLI boundary, not an ambient environment override.
const cliArgs = process.argv.slice(2);
const outputOptions = cliArgs.filter((arg) => arg === '--output-dir' || arg.startsWith('--output-dir='));
if (outputOptions.length > 1) throw new Error('--output-dir may only be supplied once.');
const outputOption = outputOptions[0];
const requestedOutput = outputOption === '--output-dir'
  ? cliArgs[cliArgs.indexOf(outputOption) + 1]
  : outputOption?.slice('--output-dir='.length);
const isolatedOutput = outputOption !== undefined;
const piRuntimeOptions = cliArgs.filter((arg) => arg === '--pi-runtime' || arg.startsWith('--pi-runtime='));
if (piRuntimeOptions.length > 1) throw new Error('--pi-runtime may only be supplied once.');
const piRuntimeOption = piRuntimeOptions[0];
const requestedPiRuntime = piRuntimeOption === '--pi-runtime'
  ? cliArgs[cliArgs.indexOf(piRuntimeOption) + 1]
  : piRuntimeOption?.slice('--pi-runtime='.length);
const watchMode = cliArgs.includes('--watch');
const skipTypecheck = cliArgs.includes('--skip-typecheck');
const noSync = isolatedOutput || cliArgs.includes('--no-sync');
const activate = cliArgs.includes('--activate');
if (isolatedOutput && (activate || watchMode)) throw new Error('--output-dir cannot be combined with --activate or --watch.');
if (piRuntimeOption !== undefined && (!requestedPiRuntime || requestedPiRuntime.startsWith('--'))) {
  throw new Error('--pi-runtime requires an artifact root.');
}
if (piRuntimeOption !== undefined && !path.isAbsolute(requestedPiRuntime)) {
  throw new Error('--pi-runtime requires an absolute artifact root.');
}
const outDir = isolatedOutput ? await validateOutputDirectory(requestedOutput) : path.join(rootDir, 'out');
if (activate && noSync) throw new Error('--activate and --no-sync are mutually exclusive.');
if (activate && watchMode) throw new Error('--activate is a one-shot explicit boundary and cannot run in watch mode.');
const webviewViewName = 'panel';
const webviewRelativeDir = path.join('webview', webviewViewName);
const buildIdentityFile = 'pie-build-id.txt';
const buildIdentityPattern = /^[0-9a-f]{20}$/u;
const requiredBuildFiles = Object.freeze([
  'extension.js',
  'backend.js',
  'worker-entry.js',
  'analytics-recorder-worker.js',
  'analytics-query-worker.js',
  path.join(webviewRelativeDir, '.vite', 'manifest.json'),
]);

let syncTimer;
let syncQueue = Promise.resolve();

function installedExtensionRoots() {
  return [
    path.join(os.homedir(), '.vscode', 'extensions'),
    path.join(os.homedir(), '.vscode-insiders', 'extensions'),
  ];
}

function containsPath(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function canonicalPath(candidate) {
  try {
    return await realpath(candidate);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(candidate);
    if (parent === candidate) throw error;
    return path.join(await canonicalPath(parent), path.basename(candidate));
  }
}

async function validateOutputDirectory(requested) {
  if (!requested || !path.isAbsolute(requested) || (process.platform === 'win32' && path.parse(path.normalize(requested)).root.length <= 1)) {
    throw new Error('--output-dir requires an absolute path (including a drive or UNC share on Windows).');
  }
  const output = path.resolve(requested);
  const canonical = await canonicalPath(output);
  const checkout = await canonicalPath(repositoryRoot);
  const installedRoots = await Promise.all(installedExtensionRoots().map(canonicalPath));
  if (containsPath(checkout, canonical) || containsPath(canonical, checkout)
    || installedRoots.some((root) => containsPath(root, canonical) || containsPath(canonical, root))
    || canonical.split(path.sep).some((part) => part.toLowerCase() === 'node_modules')) {
    throw new Error('--output-dir must be outside the checkout, node_modules, and installed extension trees.');
  }
  try {
    await lstat(output);
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (!(await stat(path.dirname(canonical))).isDirectory()) throw new Error('--output-dir requires an existing parent directory.');
      return canonical;
    }
    throw error;
  }
  throw new Error('--output-dir must name a new directory that does not already exist.');
}

let selectedPiRuntime;
let selectedInputFingerprint;
let publicationPaused = false;
let children = [];
const cancellation = new AbortController();
// Explicit reuse is verified before any output writes, including ordinary out.
if (requestedPiRuntime) {
  const verified = await verifyPiRuntimeArtifact(requestedPiRuntime);
  const canonicalOutput = await canonicalPath(outDir);
  if (containsPath(verified.artifactDir, canonicalOutput) || containsPath(canonicalOutput, verified.artifactDir)) {
    throw new Error('--output-dir must not overlap the verified --pi-runtime artifact.');
  }
}
let fingerprint;
let SourceInstability;
if (!requestedPiRuntime) {
  // Loaded only for source-default selection; explicit artifacts are pinned.
  ({ computePiRuntimeInputFingerprint: fingerprint, PiRuntimeSourceInstabilityError: SourceInstability } = await import('./pi-runtime.mjs'));
}
// Publication and polling share one read lane. Never inventory the source tree
// concurrently, including while a retiring watch selection drains.
let fingerprintQueue = Promise.resolve();
let fingerprintFailure;
function readFingerprint() {
  const check = fingerprintQueue.then(() => {
    // Publication can observe instability before the poll. Preserve that
    // failure for the poll so it retires this selection rather than leaving
    // publication paused forever. Real input failures remain terminal too.
    if (fingerprintFailure) throw fingerprintFailure;
    return fingerprint();
  }).catch((error) => {
    fingerprintFailure = error;
    if (SourceInstability && error instanceof SourceInstability) pausePublication();
    throw error;
  });
  fingerprintQueue = check.catch(() => {});
  return check;
}
async function assertFreshSelection() {
  cancellation.signal.throwIfAborted();
  const changed = fingerprint && await readFingerprint() !== selectedInputFingerprint;
  cancellation.signal.throwIfAborted();
  if (publicationPaused || changed) {
    throw new Error('Pi source/build-lock/runtime-lock/target changed; publication paused pending a fresh artifact.');
  }
}

async function resolveCompatibleInstalledExtension(pkg) {
  const extDir = await findCompatibleInstalledExtensionDir(installedExtensionRoots(), pkg);
  if (extDir) return extDir;
  const id = `${pkg.publisher}.${pkg.name}`;
  const message = `No exact installed ${id}@${pkg.version} folder/manifest match.`;
  if (activate) {
    throw new Error(`[build] ${message} --activate requires an exact compatible installation; install the matching VSIX first.`);
  }
  console.warn(
    `[build] ${message} Renderer publication and activation were skipped; install the matching VSIX first.`,
  );
  return null;
}

async function reportInstalledHostStatus(extDir, pkg) {
  if (await hasRuntimeBootstrap(extDir)) {
    const selected = await resolveRuntimeGeneration({ extensionDir: extDir, identity: pkg });
    console.log(`[build] Runtime ${selected.generation ?? 'packaged'} is selected for the next VS Code startup. Running sessions keep their existing build; no restart was forced.`);
    return;
  }
  console.warn('[build] One-time startup-loader setup required: npm run extension:activate. It does not stop active sessions. Restart VS Code afterward; subsequent builds load automatically on restart.');
}

async function verifyCoordinatedBuildIdentity(buildDir = outDir) {
  const [hostBuildIdRaw, webviewBuildIdRaw] = await Promise.all([
    readFile(path.join(buildDir, buildIdentityFile), 'utf8'),
    readFile(path.join(buildDir, webviewRelativeDir, buildIdentityFile), 'utf8'),
  ]);
  await Promise.all(requiredBuildFiles.map((relativePath) => stat(path.join(buildDir, relativePath))));
  const hostBuildId = hostBuildIdRaw.trim();
  const webviewBuildId = webviewBuildIdRaw.trim();
  if (!buildIdentityPattern.test(hostBuildId) || !buildIdentityPattern.test(webviewBuildId)) {
    throw new Error('Vite emitted an invalid Pie build identity.');
  }
  if (hostBuildId !== webviewBuildId) {
    throw new Error(`Host/webview build identity mismatch (${hostBuildId} != ${webviewBuildId}).`);
  }
  console.log(`[build] Coordinated host/webview identity ${hostBuildId}`);
}

async function copyArtifactEntries(source, destination) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    const info = await lstat(from);
    if (info.isSymbolicLink()) throw new Error(`Refusing to copy Pi runtime symlink: ${from}`);
    if (info.isDirectory()) {
      await mkdir(to);
      await copyArtifactEntries(from, to);
    } else if (info.isFile()) {
      await copyFile(from, to);
    } else {
      throw new Error(`Refusing to copy non-regular Pi runtime entry: ${from}`);
    }
  }
}

async function materializeSelectedPiRuntime() {
  if (!selectedPiRuntime) return;
  const sourceBeforeCopy = await verifyPiRuntimeArtifact(selectedPiRuntime.artifactDir);
  if (sourceBeforeCopy.identity !== selectedPiRuntime.identity) {
    throw new Error('Verified --pi-runtime source identity changed during the build.');
  }

  const copiedDirectory = path.join(outDir, 'pi-runtime');
  // Watch app-only emissions reuse the immutable copy. Never replace it while
  // dependent children are alive; rotation cleans output after their close.
  try {
    const existing = await verifyPiRuntimeArtifact(copiedDirectory);
    if (existing.identity !== selectedPiRuntime.identity) throw new Error('Output Pi runtime belongs to another selection.');
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(copiedDirectory);
  await copyArtifactEntries(sourceBeforeCopy.artifactDir, copiedDirectory);

  const [sourceAfterCopy, copied] = await Promise.all([
    verifyPiRuntimeArtifact(selectedPiRuntime.artifactDir),
    verifyPiRuntimeArtifact(copiedDirectory),
  ]);
  if (sourceAfterCopy.identity !== selectedPiRuntime.identity) {
    throw new Error('Verified --pi-runtime source identity changed while it was copied.');
  }
  if (copied.identity !== selectedPiRuntime.identity) {
    throw new Error(`Copied Pi runtime identity mismatch (${copied.identity} != ${selectedPiRuntime.identity}).`);
  }
  console.log(`[build] Materialized verified Pi runtime ${copied.identity} → ${copiedDirectory}`);
}

async function publishToInstalledExtension() {
  await assertFreshSelection();
  await verifyCoordinatedBuildIdentity();
  await materializeSelectedPiRuntime();
  await assertFreshSelection();
  if (noSync) return;

  // Never mutate a loaded runtime: publish complete immutable output, then
  // let the startup loader select it on the next natural extension activation.
  await verifyCoordinatedBuildIdentity();
  if (watchMode && !skipTypecheck) {
    await runTypecheck('Validating runtime publication');
  }
  const pkg = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8'));
  const extDir = await resolveCompatibleInstalledExtension(pkg);
  if (!extDir) return;

  // Source-default generations carry their verified runtime, not a machine's
  // legacy packaged SDK path.
  await assertFreshSelection();
  const staged = await publishRuntimeGeneration({ sourceOutDir: outDir, extensionDir: extDir, identity: pkg });
  console.log(`[build] Staged complete runtime ${staged.generation} → ${extDir}`);
  if (activate) {
    await installRuntimeBootstrap({ extensionDir: extDir, pkg });
    console.log('[build] Startup loader installed. Restart VS Code when convenient to load the staged runtime; active sessions were not interrupted.');
  }

  await assertFreshSelection();
  const published = await publishRendererGeneration({
    sourceDir: path.join(outDir, webviewRelativeDir),
    extensionDir: extDir,
  });
  console.log(`[build] Published renderer generation ${published.generation} → ${extDir}`);
  await reportInstalledHostStatus(extDir, pkg);
}

function scheduleRendererPublication() {
  if (publicationPaused || cancellation.signal.aborted) return;
  if (syncTimer !== undefined) {
    clearTimeout(syncTimer);
  }

  syncTimer = setTimeout(() => {
    syncTimer = undefined;
    syncQueue = syncQueue
      .then(() => publicationPaused || cancellation.signal.aborted ? undefined : publishToInstalledExtension())
      .catch((error) => {
        console.error('[build] Failed to sync installed extension output', error);
      });
  }, 120);
}

const viteCli = path.join(path.dirname(resolveOwnerModule('vite/package.json', { layout: 'planned' })), 'bin', 'vite.js');
const tscCli = resolveTypeScriptCompiler({ layout: 'planned' });

function spawnLocalCli(cli, args, label) {
  console.log(`[build] ${label}...`);
  cancellation.signal.throwIfAborted();
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: rootDir,
    // Only this validated invocation can select isolated config output. Clear
    // inherited values so ordinary builds retain their established behavior.
    env: {
      ...process.env,
      PIE_BUILD_OUTPUT_DIR: isolatedOutput ? outDir : '',
      PIE_BUILD_PI_RUNTIME_SDK_PATH: selectedPiRuntime?.sdkPath ?? '',
      PIE_BUILD_PI_RUNTIME_IDENTITY: selectedPiRuntime?.identity ?? '',
    },
    stdio: 'inherit',
    windowsHide: true,
  });
  // Register close at spawn time, including children whose error rejects the
  // operation before close. Cleanup is never inferred from promise rejection.
  const record = { child, closed: false, completion: undefined };
  record.completion = new Promise((resolve) => child.once('close', () => {
    record.closed = true;
    resolve();
  }));
  child.on('error', () => {});
  children.push(record);
  return child;
}

function waitForChild(child, label) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed${signal ? ` with signal ${signal}` : ` with exit code ${code ?? 1}`}`));
    });
  });
}

function runViteBuild(args = []) {
  // The default bundled config loader writes node_modules/.vite-temp before
  // evaluating config. Runner evaluates it in memory instead.
  const child = spawnLocalCli(viteCli, ['build', ...(isolatedOutput ? ['--configLoader', 'runner'] : []), ...args], `Running Vite build ${args.join(' ')}`.trim());
  return waitForChild(child, 'Vite build');
}

function runViteWatch(mode) {
  const args = ['build', '--watch'];
  if (mode) args.push('--mode', mode);
  if (mode === 'node') args.push('--emptyOutDir=false');
  return spawnLocalCli(viteCli, args, `Starting Vite watch (${mode ?? 'webview'})`);
}

function createBuildTypecheckOverlay() {
  const directory = isolatedOutput ? path.join(outDir, '.cache', 'typecheck') : undefined;
  if (directory) mkdirSync(directory, { recursive: true });
  return createTsconfigOverlay(path.join(rootDir, 'tsconfig.json'), {
    layout: 'planned', typescript: true, includeOwnerDependencies: true,
    ...(directory ? { directory } : {}),
    ...(selectedPiRuntime ? { sdkPath: selectedPiRuntime.sdkPath } : {}),
  });
}

async function runTypecheck(label) {
  const overlay = createBuildTypecheckOverlay();
  try {
    const buildInfoArgs = isolatedOutput
      ? ['--tsBuildInfoFile', path.join(outDir, '.cache', 'typecheck', 'extension.tsbuildinfo')]
      : [];
    await waitForChild(spawnLocalCli(tscCli, ['--noEmit', '--project', overlay.configPath, ...buildInfoArgs], label), 'TypeScript check');
  } finally {
    overlay.dispose();
  }
}

function runTypecheckWatch() {
  const overlay = createBuildTypecheckOverlay();
  try {
    const child = spawnLocalCli(tscCli, ['--noEmit', '--project', overlay.configPath, '--watch', '--preserveWatchOutput'], 'Starting TypeScript watch');
    child.once('close', () => overlay.dispose());
    child.once('error', () => overlay.dispose());
    return child;
  } catch (error) {
    overlay.dispose();
    throw error;
  }
}

function createBuiltOutputWatcher() {
  const watcher = fsWatch(outDir, { recursive: true }, (_eventType, fileName) => {
    const changedFile = typeof fileName === 'string' ? fileName : fileName?.toString();
    if (!changedFile || changedFile.endsWith('.map') || changedFile === 'sdk-local-path.json') {
      return;
    }

    scheduleRendererPublication();
  });

  watcher.on('error', (error) => {
    console.error('[build] Built output watcher failed', error);
  });

  return watcher;
}

async function typecheck() {
  if (skipTypecheck) return;

  try {
    await runTypecheck('Running TypeScript check');
  } catch (error) {
    console.error(`\n[build] TypeScript errors detected — fix before building.\n${error instanceof Error ? error.message : String(error)}`);
    console.error('[build] Use --skip-typecheck to bypass (not recommended).');
    throw error;
  }
}

async function buildOnce() {
  if (isolatedOutput) {
    // Claim the leaf exclusively before any build writes. No recursive cleanup
    // in isolated mode, even if another process creates it after validation.
    await mkdir(outDir);
  } else {
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
  }

  await typecheck();

  const bundles = await Promise.allSettled([
    runViteBuild(['--mode', 'node', '--emptyOutDir=false']),
    runViteBuild(),
  ]);
  const failed = bundles.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  await materializeSelectedPiRuntime();
  await verifyCoordinatedBuildIdentity();
  await publishToInstalledExtension();
}

function pausePublication() {
  publicationPaused = true;
  if (syncTimer !== undefined) clearTimeout(syncTimer);
  syncTimer = undefined;
}

async function drainChildren({ stop = false } = {}) {
  if (stop) {
    for (const { child, closed } of children) if (!closed) child.kill();
  }
  let timer;
  try {
    // No forced cleanup when a child fails to report close. The private
    // artifact is retained, even if the process eventually exits later.
    await Promise.race([
      Promise.all(children.map(({ completion }) => completion)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Child teardown uncertain; retaining Pi artifact.')), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function watchSelection() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(path.join(outDir, webviewRelativeDir), { recursive: true });
  const builtOutputWatcher = createBuiltOutputWatcher();
  let pollTimer;
  let polling;
  let watching = true;
  let onAbort;
  try {
    // Acquisition may have overlapped a source edit. Start no dependent children
    // and publish nothing until a complete stable selection is available.
    if (fingerprint && await readFingerprint() !== selectedInputFingerprint) return;
    cancellation.signal.throwIfAborted();
    publicationPaused = false;
    const node = runViteWatch('node');
    const webview = runViteWatch();
    const tsc = skipTypecheck ? null : runTypecheckWatch();
    await new Promise((resolve, reject) => {
      onAbort = () => { pausePublication(); resolve(); };
      cancellation.signal.addEventListener('abort', onAbort, { once: true });
      for (const child of [node, webview, tsc].filter(Boolean)) {
        child.once('error', reject);
        child.once('close', (code, signal) => {
          if (!cancellation.signal.aborted) reject(new Error(`Build watcher stopped (${signal ?? code}).`));
        });
      }
      // One Git-aware fingerprint check at a time, at most once per second.
      // Successive changes coalesce into the next complete private acquisition.
      const poll = async () => {
        try {
          if (!watching) return;
          if (cancellation.signal.aborted) return onAbort();
          const changed = fingerprint && await readFingerprint() !== selectedInputFingerprint;
          if (!watching) return;
          if (changed) {
            pausePublication();
            resolve();
            return;
          }
          pollTimer = setTimeout(startPoll, 1000);
        } catch (error) {
          pausePublication();
          reject(error);
        }
      };
      const startPoll = () => { polling = poll(); };
      pollTimer = setTimeout(startPoll, 1000);
      // Handle output emitted before fsWatch became ready as well.
      scheduleRendererPublication();
    });
  } finally {
    pausePublication();
    watching = false;
    clearTimeout(pollTimer);
    if (onAbort) cancellation.signal.removeEventListener('abort', onAbort);
    builtOutputWatcher.close();
    // Drain publication/typecheck before terminating this selection's children.
    await syncQueue;
    await polling;
    await drainChildren({ stop: true });
  }
}

const cancel = () => {
  cancellation.abort(new Error('Build cancelled; retaining private Pi artifact.'));
  pausePublication();
  for (const { child, closed } of children) if (!closed) child.kill();
};
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
try {
  if (watchMode && requestedPiRuntime) console.log('[build] Watch Pi runtime is explicitly pinned; it does not follow mutable Pi sources.');
  do {
    try {
      selectedInputFingerprint = fingerprint ? await readFingerprint() : undefined;
      await withPiRuntime({ artifactDir: requestedPiRuntime, signal: cancellation.signal }, async (context) => {
        selectedPiRuntime = context;
        children = [];
        publicationPaused = false;
        try {
          if (watchMode) await watchSelection();
          else {
            await assertFreshSelection();
            await buildOnce();
          }
        } finally {
          pausePublication();
          await syncQueue;
          await drainChildren({ stop: true });
          context.confirmChildCompletion();
        }
      });
    } catch (error) {
      if (!watchMode || !SourceInstability || !(error instanceof SourceInstability)) throw error;
      // The selection callback has already paused publication and drained ALL
      // siblings before withPiRuntime can clean up. Failed acquisition scratch
      // remains retained by that helper. Coalesce edits without a hot retry loop.
      pausePublication();
      if (!cancellation.signal.aborted) {
        try { await delay(1000, undefined, { signal: cancellation.signal }); }
        catch (waitError) { if (!cancellation.signal.aborted) throw waitError; }
      }
      fingerprintFailure = undefined;
    }
  } while (watchMode && !cancellation.signal.aborted);
} finally {
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
}
