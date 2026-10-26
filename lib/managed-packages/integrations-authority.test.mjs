import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { MANAGED_PACKAGE_REQUIREMENTS } from './managed-package-contract.mjs';

const root = new URL('../../', import.meta.url);
const text = (name) => readFile(new URL(name, root), 'utf8');

test('private integration importer binds exact managed pins in the shared lock', async () => {
  const manifest = JSON.parse(await text('lib/managed-packages/integrations/package.json'));
  const workspace = YAML.parse(await text('pnpm-workspace.yaml'));
  const lock = YAML.parse(await text('pnpm-lock.yaml'));
  const expected = Object.fromEntries(MANAGED_PACKAGE_REQUIREMENTS.map(({ name, version }) => [name, version]));
  assert.equal(manifest.private, true);
  assert.deepEqual(manifest.dependencies, expected);
  assert.ok(workspace.packages.includes('lib/managed-packages/integrations'));
  const importer = lock.importers['lib/managed-packages/integrations'];
  assert.deepEqual(Object.keys(importer.dependencies).sort(), Object.keys(expected).sort());
  for (const [name, version] of Object.entries(expected)) {
    assert.equal(importer.dependencies[name].specifier, version);
    assert.ok(importer.dependencies[name].version === version || importer.dependencies[name].version.startsWith(`${version}(`));
    assert.match(lock.packages[`${name}@${version}`].resolution.integrity, /^sha512-/);
  }
  const owner = JSON.parse(await text('package.json'));
  assert.equal(owner.devDependencies['pi-mcp-adapter'], '2.20.1');
  assert.equal(owner.dependencies['pi-web-access'], undefined);
  assert.equal(owner.dependencies['pi-mcp-adapter'], undefined);
});
