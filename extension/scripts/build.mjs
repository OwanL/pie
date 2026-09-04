import { watch as fsWatch } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  activateInstalledOutput,
  findCompatibleInstalledExtensionDir,
  publishRendererGeneration,
  writeFileIfChanged,
} from './publication.mjs';

const rootDir = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
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
  console.warn(
    `[build] No exact installed ${id}@${pkg.version} folder/manifest match. Renderer publication and activation were skipped; install the matching VSIX first.`,
  );
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

async function publishToInstalledExtension() {
  if (noSync) return;

  // Watch mode emits host and renderer bundles independently. The host bundle
  // is validation evidence only: ordinary publication installs one complete,
  // immutable renderer generation and never replaces active host/backend code.
  await verifyCoordinatedBuildIdentity();
  const pkg = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8'));
  const extDir = await resolveCompatibleInstalledExtension(pkg);
  if (!extDir) return;

  if (activate) {
    await writeSdkLocalManifest();
    await activateInstalledOutput({
      sourceOutDir: outDir,
      extensionDir: extDir,
      verify: verifyCoordinatedBuildIdentity,
    });
    await writeFileIfChanged(path.join(extDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
    console.log(`[build] Activated host/backend output → ${extDir}`);
    return;
  }

  const published = await publishRendererGeneration({
    sourceDir: path.join(outDir, webviewRelativeDir),
    extensionDir: extDir,
  });
  console.log(`[build] Published renderer generation ${published.generation} → ${extDir}`);
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
