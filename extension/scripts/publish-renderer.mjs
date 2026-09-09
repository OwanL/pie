import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compareNodeBundles,
  findCompatibleInstalledExtensionDir,
  publishRendererGeneration,
} from './publication.mjs';
import { hasRuntimeBootstrap, resolveRuntimeGeneration } from './runtime-publication.mjs';

const rootDir = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const outDir = path.join(rootDir, 'out');
const panelDir = path.join(outDir, 'webview', 'panel');
const [pkg, hostBuildId, rendererBuildId] = await Promise.all([
  readFile(path.join(rootDir, 'package.json'), 'utf8').then(JSON.parse),
  readFile(path.join(outDir, 'pie-build-id.txt'), 'utf8').then((value) => value.trim()),
  readFile(path.join(panelDir, 'pie-build-id.txt'), 'utf8').then((value) => value.trim()),
  stat(path.join(outDir, 'extension.js')),
  stat(path.join(outDir, 'backend.js')),
  stat(path.join(outDir, 'worker-entry.js')),
  stat(path.join(panelDir, '.vite', 'manifest.json')),
]);
if (!/^[0-9a-f]{20}$/u.test(hostBuildId) || hostBuildId !== rendererBuildId) {
  throw new Error(`Build output is not coordinated (${hostBuildId} != ${rendererBuildId}); run npm run build:validate first.`);
}

const extDir = await findCompatibleInstalledExtensionDir([
  path.join(os.homedir(), '.vscode', 'extensions'),
  path.join(os.homedir(), '.vscode-insiders', 'extensions'),
], pkg);
if (!extDir) {
  throw new Error(`No exact installed ${pkg.publisher}.${pkg.name}@${pkg.version} folder/manifest match.`);
}
const published = await publishRendererGeneration({ sourceDir: panelDir, extensionDir: extDir });
console.log(`[build] Published renderer generation ${published.generation} → ${extDir}`);
if (await hasRuntimeBootstrap(extDir)) {
  const selected = await resolveRuntimeGeneration({ extensionDir: extDir, identity: pkg });
  const status = await compareNodeBundles({ builtOutDir: outDir, installedOutDir: selected.outDir });
  console.log(status.current
    ? '[build] Matching runtime is staged for the next VS Code startup; running code was not changed.'
    : '[build] Renderer-only publication. Run npm run extension:build at the repository root to stage these host/backend changes for the next VS Code startup.');
} else {
  console.warn('[build] One-time startup-loader setup required: npm run extension:activate at the repository root, then restart VS Code. Active sessions are not stopped by setup.');
}
