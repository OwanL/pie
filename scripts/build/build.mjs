import { watch as fsWatch } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  findCompatibleInstalledExtensionDir,
  publishRendererGeneration,
} from './publication.mjs';
import { hasRuntimeBootstrap, installRuntimeBootstrap, publishRuntimeGeneration, resolveRuntimeGeneration } from './runtime-publication.mjs';
import { createTsconfigOverlay, resolveOwnerModule, resolvePackageRoots, resolveTypeScriptCompiler } from '../lib/package-resolution.mjs';

// The distribution root follows the planned package layout: the VS Code host
// package and its dependency owner live under application/hosts/vscode.
const { distributionRoot: rootDir } = resolvePackageRoots('planned');
const outDir = path.join(rootDir, 'out');

const watchMode = process.argv.includes('--watch');
const skipTypecheck = process.argv.includes('--skip-typecheck');
const noSync = process.argv.includes('--no-sync');
const activate = process.argv.includes('--activate');
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

async function writeSdkLocalManifest() {
  // Record the absolute path of the SDK pinned in this checkout's
  // node_modules so the running extension can load the lockfile-pinned version
  // instead of whatever `npm root -g` resolves. Written under out/ (gitignored)
  // so it is carried to the installed extension dir by syncToInstalledExtension
  // and is regenerated per-machine by `npm install && npm run build` — never
  // committed, never machine-specific in git.
  const sdkPath = path.join(rootDir, 'node_modules', '@earendil-works', 'pi-coding-agent');
  try {
    await stat(path.join(sdkPath, 'package.json'));
    await writeFile(path.join(outDir, 'sdk-local-path.json'), `${JSON.stringify({ sdkPath }, null, 2)}\n`);
  } catch {
    // SDK not installed in the source node_modules yet; skip — resolution
    // falls back to extensionPath/node_modules (dev-host) then npm root -g.
  }
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

async function publishToInstalledExtension() {
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

  await writeSdkLocalManifest();
  const staged = await publishRuntimeGeneration({ sourceOutDir: outDir, extensionDir: extDir, identity: pkg });
  console.log(`[build] Staged complete runtime ${staged.generation} → ${extDir}`);
  if (activate) {
    await installRuntimeBootstrap({ extensionDir: extDir, pkg });
    console.log('[build] Startup loader installed. Restart VS Code when convenient to load the staged runtime; active sessions were not interrupted.');
  }

  const published = await publishRendererGeneration({
    sourceDir: path.join(outDir, webviewRelativeDir),
    extensionDir: extDir,
  });
  console.log(`[build] Published renderer generation ${published.generation} → ${extDir}`);
  await reportInstalledHostStatus(extDir, pkg);
}

function scheduleRendererPublication() {
  if (syncTimer !== undefined) {
    clearTimeout(syncTimer);
  }

  syncTimer = setTimeout(() => {
    syncTimer = undefined;
    syncQueue = syncQueue
      .then(() => publishToInstalledExtension())
      .catch((error) => {
        console.error('[build] Failed to sync installed extension output', error);
      });
  }, 120);
}

const viteCli = path.join(path.dirname(resolveOwnerModule('vite/package.json', { layout: 'planned' })), 'bin', 'vite.js');
const tscCli = resolveTypeScriptCompiler({ layout: 'planned' });

function spawnLocalCli(cli, args, label) {
  console.log(`[build] ${label}...`);
  return spawn(process.execPath, [cli, ...args], {
    cwd: rootDir,
    stdio: 'inherit',
    windowsHide: true,
  });
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
  const child = spawnLocalCli(viteCli, ['build', ...args], `Running Vite build ${args.join(' ')}`.trim());
  return waitForChild(child, 'Vite build');
}

function runViteWatch(mode) {
  const args = ['build', '--watch'];
  if (mode) args.push('--mode', mode);
  if (mode === 'node') args.push('--emptyOutDir=false');
  return spawnLocalCli(viteCli, args, `Starting Vite watch (${mode ?? 'webview'})`);
}

function createBuildTypecheckOverlay() {
  return createTsconfigOverlay(path.join(rootDir, 'tsconfig.json'), {
    layout: 'planned', typescript: true, includeOwnerDependencies: true,
  });
}

async function runTypecheck(label) {
  const overlay = createBuildTypecheckOverlay();
  try {
    await waitForChild(spawnLocalCli(tscCli, ['--noEmit', '--project', overlay.configPath], label), 'TypeScript check');
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
    process.exit(1);
  }
}

async function buildOnce() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  await typecheck();

  await Promise.all([
    runViteBuild(['--mode', 'node', '--emptyOutDir=false']),
    runViteBuild(),
  ]);
  await verifyCoordinatedBuildIdentity();
  await publishToInstalledExtension();
}

if (watchMode) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await mkdir(path.join(outDir, webviewRelativeDir), { recursive: true });

  const builtOutputWatcher = createBuiltOutputWatcher();
  const nodeViteProcess = runViteWatch('node');
  const webviewViteProcess = runViteWatch();
  const typecheckProcess = skipTypecheck ? null : runTypecheckWatch();

  const shutdown = async () => {
    if (syncTimer !== undefined) {
      clearTimeout(syncTimer);
      syncTimer = undefined;
    }

    builtOutputWatcher.close();
    nodeViteProcess.kill();
    webviewViteProcess.kill();
    typecheckProcess?.kill();
  };

  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });
} else {
  await buildOnce();
}
