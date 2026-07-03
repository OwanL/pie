import { watch as fsWatch } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const outDir = path.join(rootDir, 'out');

const watchMode = process.argv.includes('--watch');
const skipTypecheck = process.argv.includes('--skip-typecheck');
const noSync = process.argv.includes('--no-sync');
const webviewViewName = 'panel';
const webviewRelativeDir = path.join('webview', webviewViewName);

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

async function syncToInstalledExtension() {
  if (noSync) {
    return;
  }

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
  await rm(dest, { recursive: true, force: true });
  await mkdir(path.dirname(dest), { recursive: true });
  await cp(outDir, dest, { recursive: true, force: true });
  await writeFile(path.join(extDir, 'package.json'), JSON.stringify(pkg, null, 2));
  console.log(`Synced → ${extDir}`);
}

function scheduleSyncToInstalledExtension() {
  if (syncTimer !== undefined) {
    return;
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

function runViteBuild(args = '') {
  console.log(`[build] Running Vite build ${args}...`.trim());
  execSync(`npx vite build ${args}`.trim(), { cwd: rootDir, stdio: 'inherit' });
}

function runViteWatch(mode) {
  console.log(`[build] Starting Vite watch (${mode})...`);
  const child = spawn(`npx vite build --watch --mode ${mode}`, {
    cwd: rootDir,
    stdio: 'inherit',
    shell: true,
  });

  child.on('error', (error) => {
    console.error('[build] Vite watch process failed to start', error);
  });

  return child;
}

function createBuiltWebviewWatcher() {
  const builtDir = path.join(outDir, webviewRelativeDir);
  const watcher = fsWatch(builtDir, { recursive: true }, (_eventType, fileName) => {
    const changedFile = typeof fileName === 'string' ? fileName : fileName?.toString();
    if (!changedFile || changedFile.endsWith('.map')) {
      return;
    }

    scheduleSyncToInstalledExtension();
  });

  watcher.on('error', (error) => {
    console.error('[build] Built webview watcher failed', error);
  });

  return watcher;
}

async function typecheck() {
  if (skipTypecheck) {
    return;
  }

  try {
    execSync('npx tsc --noEmit -p tsconfig.json', { cwd: rootDir, stdio: 'pipe' });
  } catch (err) {
    const output = err.stdout?.toString() || err.stderr?.toString() || '';
    console.error('[build] TypeScript errors detected — fix before building:\n');
    console.error(output);
    console.error('\n[build] Use --skip-typecheck to bypass (not recommended).');
    process.exit(1);
  }
}

async function buildOnce() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  await typecheck();

  runViteBuild('--mode node');
  runViteBuild();
  await writeSdkLocalManifest();
  await syncToInstalledExtension();
}

if (watchMode) {
  await mkdir(outDir, { recursive: true });
  await mkdir(path.join(outDir, webviewRelativeDir), { recursive: true });

  const nodeViteProcess = runViteWatch('node');
  const webviewViteProcess = runViteWatch();
  const builtWebviewWatcher = createBuiltWebviewWatcher();

  // Sync once after initial Node build; the webview watcher will handle subsequent changes.
  await writeSdkLocalManifest();
  await syncToInstalledExtension();

  const shutdown = async () => {
    if (syncTimer !== undefined) {
      clearTimeout(syncTimer);
      syncTimer = undefined;
    }

    builtWebviewWatcher.close();
    nodeViteProcess.kill();
    webviewViteProcess.kill();
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
