#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { withDevelopmentWriter } from '../../lib/development-runtime/lifetime.mjs';
import { resolveOwnerModule } from '../lib/package-resolution.mjs';
import { buildPiWorkspace } from './pi-workspace.mjs';
import { runTypecheck } from '../verification/typecheck-project.mjs';
import { abortOnProcessSignals } from '../lib/process-watchdog.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const developmentOutput = path.join(root, 'application/hosts/vscode/out-dev');
const piWorkspace = path.join(root, 'harness/pi');
const sdkPath = path.join(piWorkspace, 'packages/coding-agent');

/** Mutable output is never a production artifact and never published. */
export async function buildDevelopment(args = [], {
  loadBuild = async () => (await import(pathToFileURL(resolveOwnerModule('vite')).href)).build,
  readMarker = readFile,
  createCancellation = abortOnProcessSignals,
} = {}) {
  const watch = args.includes('--watch');
  const rendererOnly = args.includes('--renderer-only');
  const allowed = new Set(['--watch', '--renderer-only', '--skip-typecheck', '--no-sync']);
  for (const arg of args) if (!allowed.has(arg)) throw new Error(`Unknown development build argument: ${arg}`);
  if (!rendererOnly) await buildPiWorkspace();
  process.env.PIE_BUILD_OUTPUT_DIR = developmentOutput;
  process.env.PIE_BUILD_PI_RUNTIME_SDK_PATH = sdkPath;
  // Diagnostic identity only. There is intentionally no artifact manifest.
  process.env.PIE_BUILD_PI_RUNTIME_IDENTITY = 'workspace-development';
  process.env.PIE_BUILD_DEVELOPMENT = '1';
  const cancellation = createCancellation();
  const watchers = [];
  try {
    if (!args.includes('--skip-typecheck') && !rendererOnly) {
      const result = await runTypecheck({ configPath: 'application/hosts/vscode/tsconfig.json', sdkPath, signal: cancellation.signal });
      if (result.code !== 0) throw new Error(result.output || 'Development typecheck failed.');
    }
    const build = await loadBuild();
    const base = { configFile: path.join(root, 'application/hosts/vscode/vite.config.ts'), configLoader: 'runner', build: { emptyOutDir: false } };
    if (!rendererOnly) await withDevelopmentWriter(piWorkspace, () => build({ ...base, mode: 'node' }));
    await build({ ...base });
    const marker = await readMarker(path.join(developmentOutput, 'webview/panel/pie-build-id.txt'), 'utf8');
    console.log(`[development] Renderer ${marker.trim()}; incremental output ${developmentOutput}. Nothing was published.`);
    if (watch && !cancellation.signal.aborted) {
      // Renderer assets are independent of backend/Pi readers. Backend and Pi
      // changes use stop -> build -> relaunch, never mutate a live reader tree.
      watchers.push(await build({ ...base, build: { emptyOutDir: false, watch: {} } }));
      console.log('[development] Watching renderer imports. Stop the isolated host before rebuilding backend or Pi output.');
      // Cancellation can arrive while Vite asynchronously creates the watcher.
      // AbortSignal does not replay an abort to listeners registered afterwards.
      if (!cancellation.signal.aborted) {
        await new Promise(resolve => cancellation.signal.addEventListener('abort', resolve, { once: true }));
      }
    }
  } finally {
    const results = await Promise.allSettled(watchers.map(watcher => watcher.close()));
    cancellation.dispose();
    if (results.some(result => result.status === 'rejected')) throw Object.assign(new Error('Development build watcher teardown unconfirmed.'), { teardownUnconfirmed: true });
  }
}
