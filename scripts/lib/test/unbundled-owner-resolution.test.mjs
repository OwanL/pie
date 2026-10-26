import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createOwnerRequire } from '../package-resolution.mjs';
import {
  createNativeOwnerRequire,
  resolveNativeOwnerPath,
  resolveNativeOwnerRoot,
} from '../native-owner.mjs';
import { makeFutureRoot } from './unbundled-owner-resolution-fixtures.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('copied code-only native owner refuses implicit roots before package resolution', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'pie-native-owner-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'out', 'resources', 'tool-runtimes');
  const target = path.join(root, 'scripts', 'lib', 'native-owner.mjs');
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(path.join(repositoryRoot, 'scripts', 'lib', 'native-owner.mjs'), target);
  writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ version: 1, codeOnly: true, entries: {}, files: [] }));
  const copied = await import(pathToFileURL(target).href);
  for (const markerState of ['valid', 'missing', 'malformed']) {
    if (markerState === 'missing') unlinkSync(path.join(root, 'manifest.json'));
    if (markerState === 'malformed') writeFileSync(path.join(root, 'manifest.json'), '{broken');
    for (const owner of ['computer-use', 'playwright']) {
      assert.throws(() => copied.resolveNativeOwnerRoot(owner), /preparation unavailable/);
      assert.throws(() => copied.createNativeOwnerRequire(owner), /preparation unavailable/);
      assert.equal(copied.resolveNativeOwnerRoot(owner, { repositoryRoot }), path.join(repositoryRoot, 'extensions', owner));
      assert.equal(typeof copied.createNativeOwnerRequire(owner, { repositoryRoot }), 'function');
    }
  }
});

test('native and application dependency owners resolve from an OS-temp future source root', async (t) => {
  const futureRoot = makeFutureRoot(t);
  const repoOwnerOptions = { repositoryRoot: futureRoot };
  const proofPath = path.join(futureRoot, 'harness', 'owner-proof.mjs');
  mkdirSync(path.dirname(proofPath), { recursive: true });
  writeFileSync(proofPath, `
import { requireComputerUseDependency, cuaDriverEntry } from './tools/computer-use/dependency-owner.mjs';
import { requirePlaywrightDependency } from './tools/playwright/dependency-owner.mjs';
import { createOwnerRequire } from '../scripts/lib/package-resolution.mjs';
export const resolved = {
  nut: requireComputerUseDependency.resolve('@computer-use/nut-js'),
  cuaDriverEntry: cuaDriverEntry.href,
  playwright: requirePlaywrightDependency.resolve('playwright'),
  yaml: createOwnerRequire().resolve('yaml'),
  yamlParser: createOwnerRequire()('yaml').parseDocument,
};
`);

  const { resolved } = await import(pathToFileURL(proofPath).href);
  const computerOwnerRoot = resolveNativeOwnerRoot('computer-use', repoOwnerOptions);
  const playwrightOwnerRoot = resolveNativeOwnerRoot('playwright', repoOwnerOptions);
  assert.ok(resolved.nut.startsWith(realpathSync(path.join(computerOwnerRoot, 'node_modules'))));
  assert.equal(resolved.cuaDriverEntry, pathToFileURL(resolveNativeOwnerPath('computer-use', [
    'node_modules', '@trycua', 'cua-driver', 'dist', 'index.js',
  ], repoOwnerOptions)).href);
  assert.equal(existsSync(fileURLToPath(resolved.cuaDriverEntry)), true);
  assert.ok(resolved.playwright.startsWith(realpathSync(path.join(playwrightOwnerRoot, 'node_modules'))));

  // catalog-sync uses the same owner-hoisted CommonJS yaml module, not a
  // source-depth-specific copy or a second parser identity.
  const yamlEntry = createOwnerRequire().resolve('yaml');
  assert.equal(resolved.yaml, yamlEntry);
  const yamlEsmNamespace = await import(pathToFileURL(yamlEntry).href);
  assert.equal(resolved.yamlParser, yamlEsmNamespace.parseDocument);
  const catalogSync = await import(pathToFileURL(path.join(
    repositoryRoot, 'harness/model-providers/model-discovery/catalog-sync.ts',
  )).href);
  const catalogResult = catalogSync.reconcileCatalogText(
    'providers:\n  github-copilot:\n    models: []\nprofileOrder: []\n',
    [],
  );
  assert.equal(catalogResult.changed, false);

  assert.equal(createNativeOwnerRequire('computer-use', repoOwnerOptions).resolve('@computer-use/nut-js'), resolved.nut);
  assert.equal(createNativeOwnerRequire('playwright', repoOwnerOptions).resolve('playwright'), resolved.playwright);
});

test('relocated runtime clients launch their colocated source sidecars over JSONL and clean them up', { timeout: 60_000 }, async () => {
  const runtimes = [
    { id: 'computer-use', expected: { state: { healthy: true } } },
    { id: 'playwright', expected: {} },
  ];
  for (const runtime of runtimes) {
    const runtimeClientPath = path.join(repositoryRoot, 'harness', 'tools', runtime.id, 'runtime-client.ts');
    const { RuntimeClient } = await import(pathToFileURL(runtimeClientPath).href);
    const sessionDir = await mkdtemp(path.join(os.tmpdir(), `pie-${runtime.id}-sidecar-`));
    const client = new RuntimeClient(path.join(sessionDir, 'session.jsonl'));
    try {
      assert.deepEqual(await client.request('ping', {}, { timeoutMs: 15_000 }), runtime.expected);
      assert.ok(client.pid, `${runtime.id} source sidecar should be running after ping`);
    } finally {
      await client.shutdown();
      await rm(sessionDir, { recursive: true, force: true });
    }
    assert.equal(client.state, 'stopped', `${runtime.id} sidecar should stop cleanly`);
    assert.equal(client.pid, undefined);
  }
});
