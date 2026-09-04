import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  findCompatibleInstalledExtensionDir,
  publishRendererGeneration,
} from './publication.mjs';

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
