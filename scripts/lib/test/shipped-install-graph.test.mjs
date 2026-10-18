import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';
import { fileURLToPath } from 'node:url';
import { PI_RUNTIME_PACKAGES } from '../pi-runtime-artifact.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OPTIONAL_COMPUTER_USE_PEERS = [
  '@earendil-works/pi-ai',
  '@earendil-works/pi-coding-agent',
  'typebox',
];
const PI_WORKSPACE_PATHS = {
  '@earendil-works/pi-tui': 'harness/pi/packages/tui',
  '@earendil-works/pi-ai': 'harness/pi/packages/ai',
  '@earendil-works/pi-agent-core': 'harness/pi/packages/agent',
  '@earendil-works/pi-coding-agent': 'harness/pi/packages/coding-agent',
};

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repositoryRoot, relativePath), 'utf8'));
}

test('main production deploy lock resolves all four Pi packages from the workspace', () => {
  const rootManifest = readJson('package.json');
  const rootLock = parseYaml(readFileSync(path.join(repositoryRoot, 'pnpm-lock.yaml'), 'utf8'));
  const importer = rootLock.importers?.['.'];

  assert.equal(rootManifest.packageManager, 'pnpm@10.34.4');
  assert.equal(rootLock.lockfileVersion, '9.0');
  assert.equal(rootLock.settings.injectWorkspacePackages, true);
  for (const [name, relative] of Object.entries(PI_WORKSPACE_PATHS)) {
    assert.equal(rootManifest.dependencies[name], 'workspace:*', `${name} is an explicit production dependency`);
    assert.deepEqual(importer.dependencies[name], {
      specifier: 'workspace:*',
      version: `link:${relative}`,
    }, `${name} resolves from the main locked workspace graph`);
  }
});

test('main owners use shared pnpm importers, not secondary npm locks', () => {
  const lock = parseYaml(readFileSync(path.join(repositoryRoot, 'pnpm-lock.yaml'), 'utf8'));
  for (const owner of ['.', 'application/hosts/vscode', 'extensions/computer-use', 'extensions/playwright']) {
    assert.equal(existsSync(path.join(repositoryRoot, owner, 'package-lock.json')), false, `${owner} must not have a secondary npm lock`);
    const manifest = readJson(`${owner}/package.json`);
    const importer = lock.importers?.[owner];
    assert.ok(importer, `${owner} must be in the shared pnpm graph`);
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      assert.deepEqual(Object.keys(importer[section] ?? {}).sort(), Object.keys(manifest[section] ?? {}).sort(), `${owner} ${section} match the manifest`);
      for (const [name, specifier] of Object.entries(manifest[section] ?? {})) {
        assert.equal(importer[section][name].specifier, specifier, `${owner} ${name} uses the manifest pin`);
        if (owner !== '.') assert.equal(PI_RUNTIME_PACKAGES.includes(name), false, `${owner} must not install a separate Pi graph`);
      }
    }
  }
});

test('retired query workspace leaves no DuckDB importer or lock records and all dependency edges resolve', () => {
  const lock = parseYaml(readFileSync(path.join(repositoryRoot, 'pnpm-lock.yaml'), 'utf8'));
  assert.equal(lock.importers['analytics/analysis'], undefined);
  for (const records of [lock.packages, lock.snapshots]) {
    assert.ok(Object.keys(records).every((key) => !key.startsWith('@duckdb/')));
  }
  const checkEdges = (owner, record, importer = false) => {
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, dependency] of Object.entries(record[section] ?? {})) {
        const version = importer ? dependency.version : dependency;
        if (version.startsWith('link:')) continue;
        assert.ok(lock.snapshots[`${name}@${version}`], `${owner}: ${name}@${version} has a snapshot`);
      }
    }
  };
  for (const [owner, importer] of Object.entries(lock.importers)) checkEdges(owner, importer, true);
  for (const [owner, snapshot] of Object.entries(lock.snapshots)) checkEdges(owner, snapshot);
});

test('tool extension peers stay optional and are not independently installed by their importers', () => {
  const lock = parseYaml(readFileSync(path.join(repositoryRoot, 'pnpm-lock.yaml'), 'utf8'));
  for (const owner of ['extensions/computer-use', 'extensions/playwright']) {
    const manifest = readJson(`${owner}/package.json`);
    const importer = lock.importers[owner];
    assert.deepEqual(Object.keys(manifest.peerDependencies).sort(), OPTIONAL_COMPUTER_USE_PEERS);
    for (const name of OPTIONAL_COMPUTER_USE_PEERS) {
      assert.equal(manifest.peerDependencies[name], '*', `${owner} ${name} peer range`);
      assert.equal(manifest.peerDependenciesMeta[name]?.optional, true, `${owner} ${name} must remain optional`);
      for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        assert.equal(importer[section]?.[name], undefined, `${owner} must not independently install ${name}`);
      }
    }
  }
  for (const name of PI_RUNTIME_PACKAGES) {
    const records = Object.keys(lock.packages ?? {}).filter((key) => key.startsWith(`${name}@`) && !key.startsWith(`${name}@file:harness/pi/packages/`));
    assert.deepEqual(records, [], `${name} must not resolve from the registry`);
  }
});
