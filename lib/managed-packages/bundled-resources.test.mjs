import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pristineSources as s } from './bundled-resources-fixture.mjs';
import { adaptManagedPackageSources, MANAGED_PACKAGE_REQUIREMENTS } from './managed-package-contract.mjs';
import { createBundledManagedInventory, readBundledManagedResources, BUNDLED_MANAGED_ROOT_RELATIVE_PATH } from './bundled-resources.mjs';
const bindings = { runtimeIdentity: 'a'.repeat(64), closureInventorySha256: 'b'.repeat(64), qualificationRecipeSha256: 'c'.repeat(64), target: { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules } };
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-bundled-test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, BUNDLED_MANAGED_ROOT_RELATIVE_PATH);
  const write = (relative, value) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); return file; };
  const marker = write('manifest.json', JSON.stringify(createBundledManagedInventory(bindings)));
  for (const pin of MANAGED_PACKAGE_REQUIREMENTS) {
    const files = pin.name === 'pi-web-access' ? { index: s.webIndex, storage: s.storage } : { index: s.mcpIndex, agentDir: s.agentDir };
    const adapted = adaptManagedPackageSources(pin.name, files);
    for (const relative of pin.requiredFiles.filter(f => !f.startsWith('node_modules/'))) write(`node_modules/${pin.name}/${relative}`, '// fixture');
    write(`node_modules/${pin.name}/package.json`, JSON.stringify({ name: pin.name, version: pin.version }));
    write(`node_modules/${pin.name}/index.ts`, adapted.index);
    write(`node_modules/${pin.name}/${pin.name === 'pi-web-access' ? 'storage.ts' : 'agent-dir.ts'}`, adapted.storage ?? adapted.agentDir);
  }
  write('node_modules/@mozilla/readability/Readability.js', '// explicit hoist');
  return { base, root, marker, write };
}
test('pure serializer validates bindings without claiming qualification', () => {
  const m = createBundledManagedInventory(bindings);
  assert.equal(m.schemaVersion, 1); assert.equal(m.ready, undefined);
  assert.deepEqual(m.packages.map(p => p.name), MANAGED_PACKAGE_REQUIREMENTS.map(p => p.name));
  for (const key of ['runtimeIdentity', 'closureInventorySha256', 'qualificationRecipeSha256']) assert.throws(() => createBundledManagedInventory({ ...bindings, [key]: 'bad' }));
  assert.throws(() => createBundledManagedInventory({ ...bindings, target: { ...bindings.target, nodeAbi: 137 } }));
});
test('relocated complete bundle, explicit hoist and read-only synchronous result', t => {
  const f = fixture(t), relocated = `${f.base}-moved`;
  fs.renameSync(f.base, relocated); t.after(() => fs.rmSync(relocated, { recursive: true, force: true }));
  const marker = path.join(relocated, BUNDLED_MANAGED_ROOT_RELATIVE_PATH, 'manifest.json');
  const before = fs.statSync(marker), bytes = fs.readFileSync(marker), env = { ...process.env };
  const result = readBundledManagedResources(relocated, { expectedRuntimeIdentity: bindings.runtimeIdentity });
  assert.equal(result.packages.length, 2); assert.equal(result.root, path.dirname(marker));
  assert.ok(result.packages.every(p => p.extensionPath.startsWith(result.nodeModulesRoot)));
  assert.deepEqual(fs.readFileSync(marker), bytes); assert.equal(fs.statSync(marker).mtimeMs, before.mtimeMs); assert.ok(JSON.stringify({ ...process.env }) === JSON.stringify(env), 'reader must not mutate environment');
});
test('absent marker preserves source route', t => { const f = fixture(t); fs.unlinkSync(f.marker); assert.equal(readBundledManagedResources(f.base), undefined); });
for (const mutation of ['malformed', 'schema', 'missing-binding', 'hash', 'target', 'entry', 'pin', 'extra', 'manifest-pin', 'missing-file', 'pristine-web', 'mixed-storage', 'pristine-mcp', 'mixed-agent', 'edited', 'hardlink', 'directory-link']) {
  test(`rejects present invalid bundle: ${mutation}`, t => {
    const f = fixture(t), m = JSON.parse(fs.readFileSync(f.marker, 'utf8'));
    if (mutation === 'schema') m.schemaVersion = 2;
    if (mutation === 'missing-binding') delete m.runtimeIdentity;
    if (mutation === 'hash') m.qualificationRecipeSha256 = 'A'.repeat(64);
    if (mutation === 'target') m.target.arch = 'other';
    if (mutation === 'entry') m.packages[0].entry = '../index.ts';
    if (mutation === 'pin') m.packages[0].version = '0.0.0';
    if (mutation === 'extra') m.ready = true;
    fs.writeFileSync(f.marker, mutation === 'malformed' ? '{' : JSON.stringify(m));
    if (mutation === 'manifest-pin') f.write('node_modules/pi-web-access/package.json', '{"name":"pi-web-access","version":"0.0.0"}');
    if (mutation === 'missing-file') fs.unlinkSync(path.join(f.root, 'node_modules/pi-mcp-adapter/mcp-code.ts'));
    if (mutation === 'pristine-web') f.write('node_modules/pi-web-access/index.ts', s.webIndex);
    if (mutation === 'mixed-storage') f.write('node_modules/pi-web-access/storage.ts', s.storage);
    if (mutation === 'pristine-mcp') f.write('node_modules/pi-mcp-adapter/index.ts', s.mcpIndex);
    if (mutation === 'mixed-agent') f.write('node_modules/pi-mcp-adapter/agent-dir.ts', s.agentDir);
    if (mutation === 'edited') f.write('node_modules/pi-mcp-adapter/index.ts', 'unsupported');
    if (mutation === 'hardlink') fs.linkSync(f.marker, path.join(f.root, 'alias'));
    if (mutation === 'directory-link') {
      const dir = path.join(f.root, 'node_modules/pi-mcp-adapter'), moved = path.join(f.base, 'outside');
      fs.renameSync(dir, moved); fs.symlinkSync(moved, dir, 'junction');
    }
    assert.throws(() => readBundledManagedResources(f.base));
  });
}
test('optional expected binding rejects mismatch and malformed identity', t => {
  const f = fixture(t);
  for (const expectedRuntimeIdentity of ['d'.repeat(64), 'bad']) assert.throws(() => readBundledManagedResources(f.base, { expectedRuntimeIdentity }));
});
