import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBuildIdentityPlugin } from '../../application/hosts/vscode/vite.config';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packageResolutionHelper = path.join(repositoryRoot, 'scripts', 'lib', 'package-resolution.mjs');
const BUILD_ID_SENTINEL = '__PIE_COMPILED_BUILD_ID_REPLACE__';

type EmittedAsset = { type: string; fileName?: string; source?: string | Uint8Array };

function runIdentityPlugin(plugin: ReturnType<typeof createBuildIdentityPlugin>) {
  const watched: string[] = [];
  const emitted: EmittedAsset[] = [];

  const buildStart = plugin.buildStart;
  assert.equal(typeof buildStart, 'function');
  if (typeof buildStart !== 'function') throw new Error('buildStart hook is missing');
  buildStart.call({ addWatchFile: (input: string) => watched.push(input) } as never, {} as never);

  const renderChunk = plugin.renderChunk;
  assert.equal(typeof renderChunk, 'function');
  if (typeof renderChunk !== 'function') throw new Error('renderChunk hook is missing');
  const rendered = renderChunk.call(
    {} as never,
    `const buildId = ${JSON.stringify(BUILD_ID_SENTINEL)};`,
    {} as never,
    {} as never,
    {} as never,
  );
  if (!rendered || typeof rendered === 'string' || !('code' in rendered)) {
    throw new Error('renderChunk did not return transformed code');
  }

  const generateBundle = plugin.generateBundle;
  assert.equal(typeof generateBundle, 'function');
  if (typeof generateBundle !== 'function') throw new Error('generateBundle hook is missing');
  generateBundle.call(
    { emitFile: (asset: EmittedAsset) => emitted.push(asset) } as never,
    {} as never,
    {} as never,
    false,
  );

  const identityAsset = emitted.find((asset) => asset.fileName === 'pie-build-id.txt');
  assert.equal(typeof identityAsset?.source, 'string');
  const emittedId = String(identityAsset?.source).trim();
  assert.ok(rendered.code.includes(emittedId), 'runtime sentinel and emitted identity must agree');
  return { buildId: emittedId, watched };
}

test('build identity hashes and watches package resolution for both graphs', (t) => {
  const productionNode = runIdentityPlugin(createBuildIdentityPlugin());
  const productionWebview = runIdentityPlugin(createBuildIdentityPlugin());
  assert.ok(productionNode.watched.includes(packageResolutionHelper));
  assert.ok(productionWebview.watched.includes(packageResolutionHelper));
  assert.equal(productionNode.buildId, productionWebview.buildId);

  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'pie-build-identity-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const identityRoot = path.join(fixtureRoot, 'extension');
  const helperFixture = path.join(fixtureRoot, 'scripts', 'lib', 'package-resolution.mjs');
  mkdirSync(path.join(identityRoot, 'src'), { recursive: true });
  mkdirSync(path.dirname(helperFixture), { recursive: true });
  writeFileSync(path.join(identityRoot, 'src', 'entry.ts'), 'export const entry = true;\n');
  writeFileSync(helperFixture, 'export const resolution = "before";\n');

  const node = createBuildIdentityPlugin(identityRoot);
  const webview = createBuildIdentityPlugin(identityRoot);
  const beforeNode = runIdentityPlugin(node);
  const beforeWebview = runIdentityPlugin(webview);
  assert.ok(beforeNode.watched.includes(helperFixture));
  assert.ok(beforeWebview.watched.includes(helperFixture));
  assert.equal(beforeNode.buildId, beforeWebview.buildId);

  writeFileSync(helperFixture, 'export const resolution = "after";\n');
  const afterNode = runIdentityPlugin(node);
  const afterWebview = runIdentityPlugin(webview);
  assert.notEqual(afterNode.buildId, beforeNode.buildId);
  assert.notEqual(afterWebview.buildId, beforeWebview.buildId);
  assert.equal(afterNode.buildId, afterWebview.buildId);
});
