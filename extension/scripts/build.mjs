import { watch as fsWatch } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isActiveDirectoryLockError, syncActiveDestinationInPlace } from './sync-output.mjs';

const rootDir = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const outDir = path.join(rootDir, 'out');

const watchMode = process.argv.includes('--watch');
const skipTypecheck = process.argv.includes('--skip-typecheck');
const noSync = process.argv.includes('--no-sync');
const webviewViewName = 'panel';
const webviewRelativeDir = path.join('webview', webviewViewName);
const buildIdentityFile = 'pie-build-id.txt';
const buildIdentityPattern = /^[0-9a-f]{20}$/u;
const requiredBuildFiles = Object.freeze([
  'extension.js',
  'backend.js',
  'worker-entry.js',
  path.join(webviewRelativeDir, '.vite', 'manifest.json'),
]);

let syncTimer;
let syncQueue = Promise.resolve();

const LEGACY_EXTENSION_IDS = Object.freeze([
  'pi-config.pi-assistant',
]);

async function listInstalledExtensionDirs(extensionRoot) {
  try {
    const entries = await readdir(extensionRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(extensionRoot, entry.name));
  } catch {
    return [];
  }
}

async function chooseInstalledExtensionDir(pkg) {
  const extensionRoots = [
    path.join(os.homedir(), '.vscode', 'extensions'),
    path.join(os.homedir(), '.vscode-insiders', 'extensions'),
  ];
  const currentExtensionId = `${pkg.publisher}.${pkg.name}`;
  const knownExtensionIds = [currentExtensionId, ...LEGACY_EXTENSION_IDS];

  for (const extensionRoot of extensionRoots) {
    const exactCurrent = path.join(extensionRoot, `${currentExtensionId}-${pkg.version}`);
    try {
      await stat(exactCurrent);
      return exactCurrent;
    } catch {
      // fall through to prefix/package inspection
    }

    const installedDirs = await listInstalledExtensionDirs(extensionRoot);
    const prefixMatches = installedDirs.filter((dir) => {
      const baseName = path.basename(dir);
      return knownExtensionIds.some((extensionId) => baseName === extensionId || baseName.startsWith(`${extensionId}-`));
    });
    if (prefixMatches.length > 0) {
      return prefixMatches.sort((left, right) => right.localeCompare(left))[0];
    }

    for (const extDir of installedDirs) {
      try {
        const installedPkg = JSON.parse(await readFile(path.join(extDir, 'package.json'), 'utf8'));
        const installedExtensionId = `${installedPkg.publisher}.${installedPkg.name}`;
        if (knownExtensionIds.includes(installedExtensionId)) {
          return extDir;
        }
      } catch {
        // ignore directories without a readable extension manifest
      }
    }
  }

  return null;
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

async function syncToInstalledExtension() {
  if (noSync) {
    return;
  }

  // Watch mode emits the host and webview independently. Never replace a
  // healthy installation with the half-built directory visible between them.
  await verifyCoordinatedBuildIdentity();
  await writeSdkLocalManifest();

  const pkg = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8'));
  const extDir = await chooseInstalledExtensionDir(pkg);
  if (!extDir) {
    const currentExtensionId = `${pkg.publisher}.${pkg.name}`;
    console.warn(
      `[build] No installed VS Code extension directory found for ${currentExtensionId} (legacy fallback: ${LEGACY_EXTENSION_IDS.join(', ')}).`,
    );
    return;
  }

  const dest = path.join(extDir, 'out');
  const staging = `${dest}.pie-staging-${process.pid}`;
  const backup = `${dest}.pie-backup-${process.pid}`;
  await Promise.all([
    rm(staging, { recursive: true, force: true }),
    rm(backup, { recursive: true, force: true }),
  ]);
  await cp(outDir, staging, { recursive: true, force: true });
  await verifyCoordinatedBuildIdentity(staging);

  let movedExistingOutput = false;
  try {
    try {
      await rename(dest, backup);
      movedExistingOutput = true;
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }
    await rename(staging, dest);
  } catch (error) {
    if (movedExistingOutput) {
      await rename(backup, dest);
      throw error;
    }
    if (isActiveDirectoryLockError(error)) {
      await syncActiveDestinationInPlace({
        staging,
        dest,
        backup,
        verify: verifyCoordinatedBuildIdentity,
      });
    } else {
      throw error;
    }
  }
  await rm(backup, { recursive: true, force: true });
  await writeFile(path.join(extDir, 'package.json'), JSON.stringify(pkg, null, 2));
  console.log(`Synced → ${extDir}`);
}

function scheduleSyncToInstalledExtension() {
  if (syncTimer !== undefined) {
    clearTimeout(syncTimer);
  }

  syncTimer = setTimeout(() => {
    syncTimer = undefined;
    syncQueue = syncQueue
      .then(() => syncToInstalledExtension())
      .catch((error) => {
        console.error('[build] Failed to sync installed extension output', error);
      });
  }, 120);
}

const viteCli = path.join(rootDir, 'node_modules', 'vite', 'bin', 'vite.js');
const tscCli = path.join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc');

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

function runTypecheckWatch() {
  return spawnLocalCli(tscCli, ['--noEmit', '--project', 'tsconfig.json', '--watch', '--preserveWatchOutput'], 'Starting TypeScript watch');
}

function createBuiltOutputWatcher() {
  const watcher = fsWatch(outDir, { recursive: true }, (_eventType, fileName) => {
    const changedFile = typeof fileName === 'string' ? fileName : fileName?.toString();
    if (!changedFile || changedFile.endsWith('.map') || changedFile === 'sdk-local-path.json') {
      return;
    }

    scheduleSyncToInstalledExtension();
  });

  watcher.on('error', (error) => {
    console.error('[build] Built output watcher failed', error);
  });

  return watcher;
}

async function typecheck() {
  if (skipTypecheck) return;

  try {
    await waitForChild(spawnLocalCli(tscCli, ['--noEmit', '--project', 'tsconfig.json'], 'Running TypeScript check'), 'TypeScript check');
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
  await syncToInstalledExtension();
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
