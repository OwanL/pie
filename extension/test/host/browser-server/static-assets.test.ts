/**
 * Static assets tests (browser server plan §6.1): manifest allowlist serving,
 * traversal rejection, MIME mapping, and the nonce-CSP HTML shell.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
  BrowserStaticAssets,
  assetVersionFromManifest,
  contentTypeFor,
  findEntryChunk,
  loadViteManifest,
  toAssetUrl,
} from '../../../src/host/browser-server/static-assets';

async function createAssetDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-static-assets-'));
  await fs.mkdir(path.join(dir, '.vite'), { recursive: true });
  await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
  await fs.writeFile(path.join(dir, 'assets', 'panel-abc123.js'), 'console.log("pie");\n');
  await fs.writeFile(path.join(dir, 'assets', 'panel-abc123.css'), 'body {}\n');
  await fs.writeFile(path.join(dir, 'assets', 'chunk-xyz789.js'), 'export {};\n');
  await fs.writeFile(path.join(dir, 'assets', 'transcript-host-xyz789.js'), 'export {};\n');
  await fs.writeFile(path.join(dir, 'assets', 'logo-1a2b3c.svg'), '<svg/>\n');
  await fs.writeFile(path.join(dir, 'secret.txt'), 'not servable\n');
  await fs.writeFile(
    path.join(dir, '.vite', 'manifest.json'),
    JSON.stringify({
      'index.html': {
        file: 'assets/panel-abc123.js',
        isEntry: true,
        css: ['assets/panel-abc123.css'],
        imports: ['chunk-xyz789.js'],
        // Mirrors the real panel: the transcript host is lazy-loaded.
        dynamicImports: ['transcript-host.tsx'],
      },
      'chunk-xyz789.js': { file: 'assets/chunk-xyz789.js', assets: ['assets/logo-1a2b3c.svg'] },
      'transcript-host.tsx': {
        file: 'assets/transcript-host-xyz789.js',
        isDynamicEntry: true,
        imports: ['index.html'],
      },
    }),
  );
  return dir;
}

test('load(): resolves the entry, css, and transitively imported chunks into the allowlist', async () => {
  const dir = await createAssetDir();
  const assets = new BrowserStaticAssets(dir);
  await assets.load();

  assert.equal(assets.getAssetVersion(), assetVersionFromManifest(await loadViteManifest(dir)));
  assert.match(assets.getAssetVersion(), /^[0-9a-f]{16}$/);
  // URLs are `/assets/<hashed-file>` (plan §6.1) — the manifest `file` paths
  // already carry the `assets/` output prefix and must not be doubled.
  assert.equal(assets.resolveRequest('/assets/panel-abc123.js')?.contentType, 'text/javascript; charset=utf-8');
  assert.equal(assets.resolveRequest('/assets/panel-abc123.css')?.contentType, 'text/css; charset=utf-8');
  assert.equal(assets.resolveRequest('/assets/chunk-xyz789.js')?.contentType, 'text/javascript; charset=utf-8');
  assert.equal(assets.resolveRequest('/assets/logo-1a2b3c.svg')?.contentType, 'image/svg+xml');
  // Dynamic entries (lazy-loaded chunks) are allowlisted too — without this
  // the browser render crashes on the transcript-host 404.
  assert.equal(assets.resolveRequest('/assets/transcript-host-xyz789.js')?.contentType, 'text/javascript; charset=utf-8');
  await fs.rm(dir, { recursive: true, force: true });
});

test('resolveRequest(): only allowlisted files under the asset dir are served', async () => {
  const dir = await createAssetDir();
  const assets = new BrowserStaticAssets(dir);
  await assets.load();

  // Non-allowlisted files exist on disk but are never served.
  assert.equal(assets.resolveRequest('/assets/secret.txt'), null);
  // The doubled `/assets/assets/...` form is gone: URLs are single-prefix.
  assert.equal(assets.resolveRequest('/assets/assets/panel-abc123.js'), null);
  // Traversal, backslashes, absolute escapes, and null bytes are rejected.
  assert.equal(assets.resolveRequest('/assets/..%2f..%2fpackage.json'), null);
  assert.equal(assets.resolveRequest('/assets/../package.json'), null);
  assert.equal(assets.resolveRequest('/assets/..\\package.json'), null);
  assert.equal(assets.resolveRequest('/assets//etc/passwd'), null);
  assert.equal(assets.resolveRequest('/assets/%00'), null);
  // Unknown extensions have no MIME mapping → not servable.
  assert.equal(assets.resolveRequest('/assets/assets/panel-abc123.js.map'), null);
  // Non-asset paths and empty paths are rejected.
  assert.equal(assets.resolveRequest('/'), null);
  assert.equal(assets.resolveRequest('/assets/'), null);
  assert.equal(assets.resolveRequest('/nope'), null);
  await fs.rm(dir, { recursive: true, force: true });
});

test('renderHtml(): nonce CSP, stable page metadata, and manifest URLs', async () => {
  const dir = await createAssetDir();
  const assets = new BrowserStaticAssets(dir);
  await assets.load();
  const { html, csp } = assets.renderHtml({ wsRoute: '/ws', port: 1997, titleSuffix: 'Browser' });

  assert.match(html, /pie-transport" content="browser"/);
  assert.match(html, /pie-ws-route" content="\/ws"/);
  assert.match(html, /pie-asset-version" content="[0-9a-f]{16}"/);
  assert.match(html, /assets\/panel-abc123\.js/);
  assert.match(html, /assets\/panel-abc123\.css/);
  assert.match(html, /<title>pie — Browser<\/title>/);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-[0-9a-f]{32}'/);
  assert.match(csp, /style-src 'self' 'unsafe-inline'/);
  assert.match(csp, /connect-src 'self' ws:\/\/127\.0\.0\.1:1997/);
  assert.match(csp, /frame-ancestors 'none'/);
  // frame-ancestors is header-only: browsers ignore it in a <meta> element.
  assert.doesNotMatch(html, /frame-ancestors/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /form-action 'none'/);
  // The nonce in the CSP matches the script tag nonce.
  const nonce = /script-src 'nonce-([0-9a-f]{32})'/.exec(csp)?.[1];
  assert.ok(nonce);
  assert.ok(html.includes(`<script nonce="${nonce}"`));
  await fs.rm(dir, { recursive: true, force: true });
});

test('load(): a missing manifest or missing entry chunk is a terminal failure', async () => {
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-static-assets-'));
  const assets = new BrowserStaticAssets(empty);
  await assert.rejects(assets.load(), /ENOENT/);

  await fs.mkdir(path.join(empty, '.vite'), { recursive: true });
  await fs.writeFile(path.join(empty, '.vite', 'manifest.json'), JSON.stringify({ 'index.html': { file: 'assets/x.js' } }));
  await assert.rejects(assets.load(), /No Vite entry chunk/);
  await fs.rm(empty, { recursive: true, force: true });
});

test('helpers: entry discovery, MIME mapping, and asset URLs', () => {
  const manifest = {
    'index.html': { file: 'assets/panel.js', isEntry: true },
    'chunk.js': { file: 'assets/chunk.js' },
  };
  assert.equal(findEntryChunk(manifest)?.file, 'assets/panel.js');
  assert.equal(findEntryChunk({ 'x.js': { file: 'x.js' } }), null);
  assert.equal(contentTypeFor('panel.js'), 'text/javascript; charset=utf-8');
  assert.equal(contentTypeFor('panel.WOFF2'), 'font/woff2');
  assert.equal(contentTypeFor('panel.unknown'), null);
  assert.equal(toAssetUrl('C:/webview/assets/panel.js', 'C:/webview'), '/assets/panel.js');
});
