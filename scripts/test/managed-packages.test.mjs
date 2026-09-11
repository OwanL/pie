import assert from 'node:assert/strict';
import { mkdirSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  inspectManagedPackage,
  managedPackagePinsReady,
} from '../install/lib/managed-packages.mjs';
import { resolvePieDataPaths, resolvePieDataRoot } from '../../shared/pie-data-root-core.mjs';

function write(root, relative, value) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, value, 'utf8');
}

test('managed package pins require both exact configured sources', () => {
  assert.equal(managedPackagePinsReady({ packages: [
    'npm:pi-web-access@0.27.0',
    { source: 'npm:pi-mcp-adapter@2.20.1', extensions: ['index.ts'] },
  ] }), true);
  assert.equal(managedPackagePinsReady({ packages: ['npm:pi-web-access@0.27.0'] }), false);
  assert.equal(managedPackagePinsReady({ packages: [
    'npm:pi-web-access@0.27.0',
    'npm:pi-web-access@0.28.0',
    'npm:pi-mcp-adapter@2.20.1',
  ] }), false);
  assert.equal(managedPackagePinsReady({ packages: [
    'npm:pi-web-access@0.27.0',
    'npm:pi-web-access',
    'npm:pi-mcp-adapter@2.20.1',
  ] }), false);
  assert.equal(managedPackagePinsReady({ packages: [
    'npm:pi-web-access@0.27.0',
    'npm:pi-mcp-adapter@2.20.1',
    'npm:unrelated@9.9.9',
  ] }), true);
});

test('managed package readiness reports missing package and never searches a sibling global copy', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-managed-readiness-'));
  const staleGlobal = mkdtempSync(path.join(os.tmpdir(), 'pie-managed-global-'));
  try {
    write(staleGlobal, 'package.json', JSON.stringify({ name: 'pi-web-access', version: '0.27.0' }));
    const result = inspectManagedPackage({
      agentDir: root,
      packageName: 'pi-web-access',
      cacheDir: path.join(root, 'cache'),
    });
    assert.equal(result.status, 'missing');
    assert.ok(result.root.endsWith(path.join('npm', 'node_modules', 'pi-web-access')));
    assert.deepEqual(result.cacheTargets, [path.join(root, 'cache', 'web-search-cache')]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(staleGlobal, { recursive: true, force: true });
  }
});

test('managed package readiness rejects wrong pins and source-shape drift', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-managed-readiness-'));
  try {
    write(root, 'npm/node_modules/pi-mcp-adapter/package.json', JSON.stringify({ name: 'pi-mcp-adapter', version: '2.21.0' }));
    assert.equal(inspectManagedPackage({ agentDir: root, packageName: 'pi-mcp-adapter' }).status, 'wrong-version');

    write(root, 'npm/node_modules/pi-mcp-adapter/package.json', JSON.stringify({ name: 'pi-mcp-adapter', version: '2.20.1' }));
    write(root, 'npm/node_modules/pi-mcp-adapter/agent-dir.ts', 'export const changed = true;');
    const result = inspectManagedPackage({ agentDir: root, packageName: 'pi-mcp-adapter', cacheDir: path.join(root, 'cache') });
    assert.equal(result.status, 'unsupported-source');
    assert.deepEqual(result.cacheTargets, [path.join(root, 'cache', 'mcp-cache.json'), path.join(root, 'cache', 'mcp-npx-cache.json')]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('managed package readiness distinguishes an invalid manifest from a missing package', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-managed-readiness-'));
  try {
    write(root, 'npm/node_modules/pi-web-access/package.json', '{not json');
    const malformed = inspectManagedPackage({ agentDir: root, packageName: 'pi-web-access' });
    assert.equal(malformed.status, 'malformed-manifest');
    rmSync(path.join(root, 'npm'), { recursive: true, force: true });
    const missing = inspectManagedPackage({ agentDir: root, packageName: 'pi-web-access' });
    assert.equal(missing.status, 'missing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('doctor data-root resolver preserves default, absolute, and agent-relative cache targets', () => {
  assert.equal(resolvePieDataRoot({
    platform: 'linux',
    homeDir: '/home/alice',
    environment: {},
  }), '/home/alice/.local/share/pie/data');
  assert.equal(resolvePieDataPaths({
    platform: 'linux',
    dataDir: '/var/lib/pie-data/../pie-data',
    homeDir: '/home/alice',
    environment: {},
  }).cacheDir, '/var/lib/pie-data/cache');
  assert.equal(resolvePieDataPaths({
    platform: 'linux',
    dataDir: 'runtime-data',
    agentDir: '/opt/pi-agent',
    homeDir: '/home/alice',
    environment: {},
  }).cacheDir, '/opt/pi-agent/runtime-data/cache');
});
