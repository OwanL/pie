import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { isHotReloadAssetFileName } from '../../../src/host/webview/hot-reload';

test('isHotReloadAssetFileName matches built assets and ignores sourcemaps', () => {
  assert.equal(isHotReloadAssetFileName('panel.js'), true);
  assert.equal(isHotReloadAssetFileName('panel-abc123.js'), true);
  assert.equal(isHotReloadAssetFileName('panel.css'), true);
  assert.equal(isHotReloadAssetFileName('index.html'), true);
  assert.equal(isHotReloadAssetFileName('.vite/manifest.json'), true);
  assert.equal(isHotReloadAssetFileName('/tmp/panel.js'), true);
  assert.equal(isHotReloadAssetFileName('panel.js.map'), false);
  assert.equal(isHotReloadAssetFileName(undefined), false);
});

test('build script removes stale installed output before syncing rebuilt assets', async () => {
  const buildScript = await readFile(new URL('../../../scripts/build.mjs', import.meta.url), 'utf8');

  assert.match(buildScript, /await rm\(dest, \{ recursive: true, force: true \}\);/);
  assert.match(buildScript, /await cp\(outDir, dest, \{ recursive: true, force: true \}\);/);
  assert.ok(
    buildScript.indexOf('await rm(dest, { recursive: true, force: true });')
      < buildScript.indexOf('await cp(outDir, dest, { recursive: true, force: true });'),
    'installed out directory must be cleared before copying rebuilt output',
  );
});

test('build script builds everything with Vite', async () => {
  const buildScript = await readFile(new URL('../../../scripts/build.mjs', import.meta.url), 'utf8');

  assert.match(buildScript, /function runViteBuild\(/);
  assert.match(buildScript, /node_modules', 'vite', 'bin', 'vite\.js'/);
  assert.match(buildScript, /await Promise\.all\(\[/);
  assert.match(buildScript, /function runViteWatch\(/);
  assert.match(buildScript, /const nodeViteProcess = runViteWatch\('node'\)/);
  assert.doesNotMatch(buildScript, /import esbuild from 'esbuild'/);
  assert.doesNotMatch(buildScript, /esbuild\.build\(/);
});
