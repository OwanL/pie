import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { materializeManagedIntegrationClosure as materialize } from './materialize-closure.mjs';
const hash = b => createHash('sha256').update(b).digest('hex');
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-closure-test-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo'), stagingParent = path.join(base, 'stages');
  await fs.mkdir(stagingParent); await fs.mkdir(repo);
  const lock = { lockfileVersion: '9.0', importers: { 'lib/managed-packages/integrations': { dependencies: {} } }, packages: {}, snapshots: {} };
  const modules = { layoutVersion: 5, nodeLinker: 'hoisted', packageManager: 'pnpm@10.34.4', hoistedLocations: {}, skipped: [], pendingBuilds: [] };
  async function write(file, value) { const p = path.join(repo, file); await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, typeof value === 'string' ? value : JSON.stringify(value)); }
  async function add(name, version, snapshot = {}, placement = `node_modules/${name}`, extra = {}) {
    const key = `${name}@${version}`; lock.snapshots[key] = snapshot; lock.packages[key] = { resolution: { integrity: 'sha512-fixture' } }; modules.hoistedLocations[key] = [placement];
    await write(`${placement}/package.json`, { name, version, ...extra }); await write(`${placement}/asset.wasm`, 'asset');
  }
  const roots = { 'pi-web-access': '0.27.0', 'pi-mcp-adapter': '2.20.1' };
  for (const [name, version] of Object.entries(roots)) { await add(name, version); lock.importers['lib/managed-packages/integrations'].dependencies[name] = { specifier: version, version }; }
  await write('lib/managed-packages/integrations/package.json', { dependencies: roots });
  async function options() {
    await write('pnpm-lock.yaml', lock); await write('node_modules/.modules.yaml', modules);
    return { acquisitionRoot: repo, stagingParent, provenance: { lockSha256: hash(await fs.readFile(path.join(repo, 'pnpm-lock.yaml'))), modulesSha256: hash(await fs.readFile(path.join(repo, 'node_modules/.modules.yaml'))), node: process.versions.node, pnpm: '10.34.4', platform: process.platform, arch: process.arch } };
  }
  return { repo, lock, modules, add, write, options };
}
test('independent pristine copy, assets, nested placement, builtin-name token, no unrelated subtree', async t => {
  const f = await fixture(t);
  f.lock.snapshots['pi-web-access@0.27.0'].dependencies = { fs: '1.0.0' };
  await f.add('fs', '1.0.0', {}, 'node_modules/pi-web-access/node_modules/fs');
  await f.write('node_modules/unreachable/bad.txt', 'not selected');
  const options = await f.options(), result = await materialize(options);
  assert.equal(result.receipt.ready, false); assert.equal(result.receipt.status, 'pristine-unqualified');
  assert.equal(result.receipt.nodes.length, 3);
  assert.equal(await fs.readFile(path.join(result.packages['pi-web-access'], 'node_modules/fs/asset.wasm'), 'utf8'), 'asset');
  await assert.rejects(fs.stat(path.join(result.root, 'node_modules/unreachable')));
  const target = path.join(result.packages['pi-web-access'], 'asset.wasm');
  assert.equal((await fs.stat(target)).nlink, 1); await fs.writeFile(target, 'changed');
  assert.equal(await fs.readFile(path.join(f.repo, 'node_modules/pi-web-access/asset.wasm'), 'utf8'), 'asset');
  assert(Object.isFrozen(result.receipt));
});
test('optional pending canvas retained; required fixed-point promotion fails', async t => {
  const f = await fixture(t);
  await f.add('canvas', '3.2.3', { dependencies: { leaf: '1.0.0' } }); await f.add('leaf', '1.0.0');
  f.lock.snapshots['pi-web-access@0.27.0'].optionalDependencies = { canvas: '3.2.3' };
  f.modules.pendingBuilds = ['canvas@3.2.3'];
  const result = await materialize(await f.options());
  assert.equal(result.receipt.pendingOptionalBuilds.length, 1); assert.equal(result.receipt.nodes.length, 4);
  f.lock.snapshots['pi-mcp-adapter@2.20.1'].dependencies = { canvas: '3.2.3' };
  await assert.rejects(materialize(await f.options()), /required pending build/);
});
test('requiredness promotion revisits descendants and cycles terminate', async t => {
  const f = await fixture(t);
  await f.add('a', '1.0.0', { dependencies: { b: '1.0.0' } });
  await f.add('b', '1.0.0', { dependencies: { a: '1.0.0' } });
  await f.add('long', '1.0.0', { dependencies: { a: '1.0.0' } });
  f.lock.snapshots['pi-web-access@0.27.0'].optionalDependencies = { a: '1.0.0' };
  f.lock.snapshots['pi-mcp-adapter@2.20.1'].dependencies = { long: '1.0.0' };
  const result = await materialize(await f.options());
  assert.equal(result.receipt.nodes.find(n => n.name === 'b').optional, false);
  f.modules.pendingBuilds = ['b@1.0.0'];
  await assert.rejects(materialize(await f.options()), /required pending/);
});
test('exact peer-context snapshot and placements, not base-version fallback', async t => {
  const f = await fixture(t), base = 'pi-web-access@0.27.0', exact = `${base}(context@1.0.0)`;
  f.lock.importers['lib/managed-packages/integrations'].dependencies['pi-web-access'].version = '0.27.0(context@1.0.0)';
  f.lock.snapshots[exact] = f.lock.snapshots[base]; delete f.lock.snapshots[base];
  f.modules.hoistedLocations[exact] = f.modules.hoistedLocations[base]; delete f.modules.hoistedLocations[base];
  assert.equal((await materialize(await f.options())).receipt.nodes.find(n => n.name === 'pi-web-access').snapshot, exact);
  delete f.lock.snapshots[exact]; f.lock.snapshots[base] = {};
  await assert.rejects(materialize(await f.options()), /missing exact snapshot/);
});
test('optional skipped accepted, required skipped and absent exact snapshot fail', async t => {
  const f = await fixture(t); await f.add('absent', '1.0.0');
  f.modules.skipped = ['absent@1.0.0']; f.lock.snapshots['pi-web-access@0.27.0'].optionalDependencies = { absent: '1.0.0' };
  assert.equal((await materialize(await f.options())).receipt.skips.length, 1);
  f.lock.snapshots['pi-mcp-adapter@2.20.1'].dependencies = { absent: '1.0.0' };
  await assert.rejects(materialize(await f.options()), /required skipped/);
  delete f.lock.snapshots['absent@1.0.0']; await assert.rejects(materialize(await f.options()), /missing exact snapshot/);
});
test('nearer conflict never falls through', async t => {
  const f = await fixture(t); await f.add('dep', '1.0.0');
  f.lock.snapshots['pi-web-access@0.27.0'].dependencies = { dep: '1.0.0' };
  await f.write('node_modules/pi-web-access/node_modules/dep/package.json', { name: 'dep', version: '9.0.0' });
  await assert.rejects(materialize(await f.options()), /nearer conflicting/);
});
test('importer-local unrecorded roots cannot be bypassed', async t => {
  const f = await fixture(t);
  await f.write('lib/managed-packages/integrations/node_modules/pi-web-access/package.json', { name: 'pi-web-access', version: '0.26.0' });
  await assert.rejects(materialize(await f.options()), /nearer conflicting placement/);
});
test('peer evidence is narrow and workspace manifest is hashed, not copied', async t => {
  const f = await fixture(t), name = '@earendil-works/pi-ai', ref = 'file:harness/pi/packages/ai';
  f.lock.snapshots['pi-web-access@0.27.0'].dependencies = { [name]: ref };
  f.lock.snapshots[`${name}@${ref}`] = {}; f.lock.packages[`${name}@${ref}`] = { resolution: { type: 'directory', directory: 'harness/pi/packages/ai' } };
  await f.write('harness/pi/packages/ai/package.json', { name, version: '1.0.0' });
  await f.write('node_modules/pi-web-access/package.json', { name: 'pi-web-access', version: '0.27.0', peerDependencies: { [name]: '^1' } });
  const result = await materialize(await f.options()); assert.equal(result.receipt.peerRequirements[0].requirement, '^1'); assert.match(result.receipt.peerRequirements[0].manifestSha256, /^[a-f0-9]{64}$/); assert.equal(result.receipt.nodes.length, 2);
  f.lock.snapshots['pi-web-access@0.27.0'].dependencies[name] = 'file:elsewhere';
  await assert.rejects(materialize(await f.options()));
});
test('registry exclusions verify direct TypeBox and current/legacy peers', async t => {
  for (const name of ['typebox', '@sinclair/typebox', '@earendil-works/pi-ai', '@mariozechner/pi-ai']) {
    const f = await fixture(t), kind = name === 'typebox' ? 'dependencies' : 'peerDependencies';
    await f.add(name, '1.0.0');
    f.lock.snapshots['pi-web-access@0.27.0'].dependencies = { [name]: '1.0.0' };
    await f.write('node_modules/pi-web-access/package.json', { name: 'pi-web-access', version: '0.27.0', [kind]: { [name]: '^1' } });
    const result = await materialize(await f.options()), peer = result.receipt.peerRequirements[0];
    assert.equal(peer.kind, kind); assert.equal(peer.placement, path.normalize(`node_modules/${name}`));
    assert.match(peer.manifestSha256, /^[a-f0-9]{64}$/); assert.equal(result.receipt.nodes.length, 2);
    await assert.rejects(fs.stat(path.join(result.root, `node_modules/${name}`)));
    for (const identity of [{ name: 'wrong', version: '1.0.0' }, { name, version: '2.0.0' }]) {
      await f.write(`node_modules/${name}/package.json`, identity);
      await assert.rejects(materialize(await f.options()), /identity mismatch/);
    }
    await f.write(`node_modules/${name}/package.json`, { name, version: '1.0.0' });
    delete f.modules.hoistedLocations[`${name}@1.0.0`];
    await assert.rejects(materialize(await f.options()), /missing placements/);
    f.modules.hoistedLocations[`${name}@1.0.0`] = [`node_modules/${name}`];
    await f.write(`node_modules/pi-web-access/node_modules/${name}/package.json`, { name, version: '1.0.0' });
    await assert.rejects(materialize(await f.options()), /nearer conflicting/);
  }
});
test('rejects normal and prefix deletion tombstones', async t => {
  for (const file of ['Readability.js.DELETE.hash', '.DELETE.hash', '.DELETE']) {
    const f = await fixture(t);
    await f.write(`node_modules/pi-web-access/${file}`, 'stale');
    await assert.rejects(materialize(await f.options()), /tombstone/);
  }
});
test('rejects duplicate and cross-key physical metadata placements', async t => {
  const f = await fixture(t), key = 'pi-web-access@0.27.0', placement = 'node_modules/pi-web-access';
  f.modules.hoistedLocations[key] = [placement, placement];
  await assert.rejects(materialize(await f.options()), /duplicate\/colliding/);
  f.modules.hoistedLocations[key] = [placement];
  f.modules.hoistedLocations['other@1.0.0'] = [placement];
  await assert.rejects(materialize(await f.options()), /duplicate\/colliding/);
});
test('rejects hashes, metadata paths, identities, bundles, aliases and links', async t => {
  const f = await fixture(t); const opts = await f.options(); opts.provenance.lockSha256 = '0'.repeat(64);
  await assert.rejects(materialize(opts), /hash mismatch/);
  f.modules.hoistedLocations['pi-web-access@0.27.0'] = ['../escape']; await assert.rejects(materialize(await f.options()), /path component/);
  f.modules.hoistedLocations['pi-web-access@0.27.0'] = ['node_modules/pi-web-access'];
  for (const [extra, pattern] of [[{ name: 'wrong' }, /identity/], [{ bundledDependencies: [] }, /bundled/], [{ dependencies: { alias: 'npm:other@1' } }, /alias/]]) {
    await f.write('node_modules/pi-web-access/package.json', { name: 'pi-web-access', version: '0.27.0', ...extra }); await assert.rejects(materialize(await f.options()), pattern);
  }
  await f.write('node_modules/pi-web-access/package.json', { name: 'pi-web-access', version: '0.27.0' });
  const asset = path.join(f.repo, 'node_modules/pi-web-access/asset.wasm'); await fs.unlink(asset);
  try { await fs.symlink(path.join(f.repo, 'pnpm-lock.yaml'), asset); } catch (e) { if (e.code === 'EPERM') return; throw e; }
  await assert.rejects(materialize(await f.options()), /link\/special/);
});
