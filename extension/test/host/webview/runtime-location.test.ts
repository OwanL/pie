import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { configureRuntimeLocation, runtimeOutputDirectory, runtimeRendererSelection } from '../../../src/host/runtime-location';
import { resolvePublishedWebviewDir } from '../../../src/host/webview/published-generations';
import { BrowserStaticAssets } from '../../../src/host/browser-server/static-assets';
import { publishRendererGeneration } from '../../../scripts/publication.mjs';
import { hasRuntimeBootstrap, installRuntimeBootstrap } from '../../../scripts/runtime-publication.mjs';

const identity = { publisher: 'pie', name: 'pie', version: '0.3.0' };

test('runtime paths are pinned per extension context; default remains packaged output', () => {
  const first = { extensionPath: '/installed/pie' };
  const second = { extensionPath: '/installed/pie' };
  configureRuntimeLocation(first, { runtimeOutDir: '/generation/one/out', generation: 'one', publishedAt: 100 });
  configureRuntimeLocation(second, { runtimeOutDir: '/generation/two/out', generation: 'two', publishedAt: 200 });
  assert.equal(runtimeOutputDirectory(first), '/generation/one/out');
  assert.equal(runtimeOutputDirectory(second), '/generation/two/out');
  assert.equal(runtimeOutputDirectory({ extensionPath: '/source/pie' }), path.join('/source/pie', 'out'));
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
    const installed = await installRuntimeBootstrap({ extensionDir: root, pkg: identity });
    assert.equal(await hasRuntimeBootstrap(root), true);
    assert.equal(await readFile(path.join(root, 'out/extension.js'), 'utf8'), 'running-old-host');
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.main, `./pie-bootstrap/${installed}/bootstrap.cjs`);
    assert.equal(await installRuntimeBootstrap({ extensionDir: root, pkg: identity }), installed);
    await assert.rejects(installRuntimeBootstrap({ extensionDir: root, pkg: { ...identity, version: '9.9.9' } }), /identity changed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
