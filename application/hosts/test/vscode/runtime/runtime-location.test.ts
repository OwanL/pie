import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { configureRuntimeLocation, runtimeOutputDirectory, runtimeRendererSelection, runtimeWebviewAssetDirectory } from '../../../vscode/runtime/runtime-location';
import { resolvePublishedWebviewDir } from '../../../lib/asset-manifests/published-generations';
import { BrowserStaticAssets } from '../../../browser/static-assets/static-assets';
import { publishRendererGeneration } from '../../../../../scripts/build/publication.mjs';
import { hasRuntimeBootstrap, installRuntimeBootstrap } from '../../../../../scripts/build/runtime-publication.mjs';

const require = createRequire(import.meta.url);
const runtime = require('../../../vscode/runtime/runtime-generations.cjs');
const identity = { publisher: 'pie', name: 'pie', version: '0.3.0' };

test('VS Code browser server takes assets from the context-selected runtime output', async () => {
  const source = await readFile(new URL('../../../vscode/runtime/host-runtime-platform.ts', import.meta.url), 'utf8');
  assert.match(source, /assetDir: getWebviewAssetDir\(context\)/);
  assert.match(source, /import \{ getWebviewAssetDir \} from '\.\/hot-reload'/);
});

test('runtime paths are pinned per extension context; default remains packaged output', () => {
  const first = { extensionPath: '/installed/pie' };
  const second = { extensionPath: '/installed/pie' };
  configureRuntimeLocation(first, { runtimeOutDir: '/generation/one/out', generation: 'one', publishedAt: 100 });
  configureRuntimeLocation(second, { runtimeOutDir: '/generation/two/out', generation: 'two', publishedAt: 200 });
  assert.equal(runtimeOutputDirectory(first), '/generation/one/out');
  assert.equal(runtimeOutputDirectory(second), '/generation/two/out');
  assert.equal(runtimeOutputDirectory({ extensionPath: '/source/pie' }), path.join('/source/pie', 'out'));
  assert.equal(runtimeWebviewAssetDirectory(first), path.join('/installed/pie', 'out', 'webview', 'panel'),
    'production keeps watching and serving shared extension renderer publications');
  const previousWorkspace = process.env.PIE_DEVELOPMENT_PI_WORKSPACE;
  process.env.PIE_DEVELOPMENT_PI_WORKSPACE = '/pi/workspace';
  try {
    assert.equal(runtimeWebviewAssetDirectory(first), path.join('/generation/one/out', 'webview', 'panel'),
      'development assets follow this extension context selected output');
  } finally {
    if (previousWorkspace === undefined) delete process.env.PIE_DEVELOPMENT_PI_WORKSPACE;
    else process.env.PIE_DEVELOPMENT_PI_WORKSPACE = previousWorkspace;
  }
  assert.deepEqual(runtimeRendererSelection(first), { fallbackDir: path.join('/generation/one/out', 'webview', 'panel'), notBefore: 100 });
});

test('new host uses its own renderer before newer live publications, including browser URLs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pie-runtime-assets-'));
  try {
    const extensionDir = path.join(root, 'extension');
    const panel = path.join(extensionDir, 'out/webview/panel');
    const fallbackDir = path.join(root, 'leased-runtime/webview/panel');
    const createRenderer = async (dir: string, id: string) => {
      await mkdir(path.join(dir, '.vite'), { recursive: true });
      await mkdir(path.join(dir, 'assets'), { recursive: true });
      await writeFile(path.join(dir, 'pie-build-id.txt'), id);
      await writeFile(path.join(dir, 'assets/panel.js'), `/* ${id} */`);
      await writeFile(path.join(dir, '.vite/manifest.json'), JSON.stringify({ panel: { file: 'assets/panel.js', isEntry: true } }));
    };
    await mkdir(extensionDir, { recursive: true });
    await createRenderer(fallbackDir, '11111111111111111111');
    const source = path.join(root, 'renderer');
    await createRenderer(source, '22222222222222222222');
    await publishRendererGeneration({ sourceDir: source, extensionDir, now: 10 });
    const selection = { fallbackDir, notBefore: 20 };
    assert.equal(await resolvePublishedWebviewDir(panel, selection), fallbackDir);
    const browser = new BrowserStaticAssets(panel, selection);
    await browser.load();
    assert.match(browser.renderHtml({ wsRoute: '/ws', port: 1997 }).html, /src="\/assets\/panel.js"/);
    assert.equal(browser.resolveRequest('/assets/panel.js')?.absolutePath, path.join(fallbackDir, 'assets/panel.js'));
    assert.equal(browser.resolveRequest('/assets/../package.json'), null);
    const live = await publishRendererGeneration({ sourceDir: source, extensionDir, now: 30 });
    assert.equal(await resolvePublishedWebviewDir(panel, selection), live.generationDir);
    await browser.load();
    assert.equal(browser.resolveRequest('/assets/panel.js')?.absolutePath, path.join(live.generationDir, 'assets/panel.js'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('one-time loader migration selects immutable bootstrap without replacing the running flat host', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pie-bootstrap-install-'));
  try {
    await mkdir(path.join(root, 'out'));
    await writeFile(path.join(root, 'out/extension.js'), 'running-old-host');
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ ...identity, main: './out/extension.js' }));
    assert.equal(await hasRuntimeBootstrap(root), false);
    const sourceOutDir = await mkdtemp(path.join(os.tmpdir(), 'pie-bootstrap-runtime-'));
    try {
      await mkdir(path.join(sourceOutDir, 'webview/panel/.vite'), { recursive: true });
      for (const file of ['extension.js', 'backend.js', 'worker-entry.js', 'webview/panel/entry.js']) {
        await writeFile(path.join(sourceOutDir, file), '// fixture');
      }
      for (const file of ['pie-build-id.txt', 'webview/panel/pie-build-id.txt']) {
        await writeFile(path.join(sourceOutDir, file), 'fixture-build');
      }
      await writeFile(path.join(sourceOutDir, 'webview/panel/.vite/manifest.json'), JSON.stringify({ entry: { file: 'entry.js', isEntry: true } }));
      await runtime.publishRuntimeGeneration({ sourceOutDir, extensionDir: root, identity });
      const installed = await installRuntimeBootstrap({ extensionDir: root, pkg: identity });
      assert.equal(await hasRuntimeBootstrap(root), true);
      assert.equal(await readFile(path.join(root, 'out/extension.js'), 'utf8'), 'running-old-host');
      const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
      assert.equal(pkg.main, `./pie-bootstrap/${installed}/bootstrap.cjs`);
      assert.equal(await installRuntimeBootstrap({ extensionDir: root, pkg: identity }), installed);
      const mismatched = { ...identity, version: '9.9.9' };
      await writeFile(path.join(sourceOutDir, 'extension.js'), '// mismatched fixture');
      await runtime.publishRuntimeGeneration({ sourceOutDir, extensionDir: root, identity: mismatched });
      await assert.rejects(installRuntimeBootstrap({ extensionDir: root, pkg: mismatched }), /identity changed/);
    } finally {
      await rm(sourceOutDir, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
