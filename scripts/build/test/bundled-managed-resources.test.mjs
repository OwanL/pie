import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { emitBundledManagedResources, verifyBundledManagedOutput } from '../bundled-managed-resources.mjs';
import { pristineSources as s } from '../../../lib/managed-packages/bundled-resources-fixture.mjs';
import { adaptManagedPackageSources, MANAGED_PACKAGE_REQUIREMENTS } from '../../../lib/managed-packages/managed-package-contract.mjs';
const hash = b => createHash('sha256').update(b).digest('hex');
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-emitter-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const stageRoot = path.join(base, 'stage'), outDir = path.join(base, 'out');
  const write = (rel, bytes) => { const file = path.join(stageRoot, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; };
  for (const pin of MANAGED_PACKAGE_REQUIREMENTS) {
    const adapted = adaptManagedPackageSources(pin.name, pin.name === 'pi-web-access' ? { index: s.webIndex, storage: s.storage } : { index: s.mcpIndex, agentDir: s.agentDir });
    for (const rel of pin.requiredFiles.filter(x => !x.startsWith('node_modules/'))) write(`node_modules/${pin.name}/${rel}`, '// fixture');
    write(`node_modules/${pin.name}/package.json`, JSON.stringify({ name: pin.name, version: pin.version }));
    write(`node_modules/${pin.name}/index.ts`, adapted.index);
    write(`node_modules/${pin.name}/${pin.name === 'pi-web-access' ? 'storage.ts' : 'agent-dir.ts'}`, adapted.storage ?? adapted.agentDir);
  }
  write('node_modules/@mozilla/readability/Readability.js', '// hoist');
  const nested = write('node_modules/example/node_modules/inner/bin/tool', 'nested executable');
  if (process.platform !== 'win32') fs.chmodSync(nested, 0o751);
  const inventory = [];
  function walk(dir) { for (const name of fs.readdirSync(dir)) { const file = path.join(dir, name), st = fs.statSync(file); if (st.isDirectory()) walk(file); else { const b = fs.readFileSync(file); inventory.push({ path: path.relative(stageRoot, file), size: b.length, mode: st.mode & 0o777, sha256: hash(b) }); } } }
  walk(stageRoot);
  write('closure-receipt.json', 'private');
  const q = { stage: { root: stageRoot, receipt: { inventory, inventorySha256: hash(JSON.stringify(inventory)) }, packages: {} }, runtime: { identity: 'a'.repeat(64), manifest: { target: { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules } } }, receipt: { passed: true }, qualificationRecipeSha256: 'b'.repeat(64) };
  const options = { outDir, stageRoot, artifactDir: path.join(base, 'artifact'), receiptPath: path.join(base, 'proof.json') };
  const deps = { verifyManagedIntegrationQualification: async () => q };
  const root = path.join(outDir, 'resources/managed-integrations'), marker = path.join(root, 'manifest.json');
  return { q, options, deps, root, marker, nested };
}
test('exact independent nested copy, modes, private exclusion and existing output refusal', async t => {
  const f = fixture(t);
  assert.equal(await emitBundledManagedResources(f.options, f.deps), f.q);
  verifyBundledManagedOutput(f.options.outDir, f.q);
  assert.equal(fs.existsSync(path.join(f.root, 'closure-receipt.json')), false);
  for (const item of f.q.stage.receipt.inventory) { const dest = path.join(f.root, item.path); assert.equal(fs.statSync(dest).nlink, 1); assert.deepEqual(fs.readFileSync(dest), fs.readFileSync(path.join(f.options.stageRoot, item.path))); assert.equal(fs.statSync(dest).mode & 0o777, item.mode); }
  const before = fs.readFileSync(f.marker);
  await assert.rejects(emitBundledManagedResources(f.options, f.deps), /already exists/);
  assert.deepEqual(fs.readFileSync(f.marker), before);
});
for (const mutation of ['absent', 'corrupt', 'binding', 'missing', 'extra', 'changed', 'directory', 'mode']) test(`read-only verifier rejects ${mutation}`, async t => {
  const f = fixture(t); await emitBundledManagedResources(f.options, f.deps);
  const file = path.join(f.root, f.q.stage.receipt.inventory[0].path);
  if (mutation === 'absent') fs.unlinkSync(f.marker);
  if (mutation === 'corrupt') fs.writeFileSync(f.marker, '{');
  if (mutation === 'binding') { const m = JSON.parse(fs.readFileSync(f.marker)); m.qualificationRecipeSha256 = 'c'.repeat(64); fs.writeFileSync(f.marker, JSON.stringify(m)); }
  if (mutation === 'missing') fs.unlinkSync(file);
  if (mutation === 'extra') fs.writeFileSync(path.join(f.root, 'extra'), 'extra');
  if (mutation === 'changed') fs.appendFileSync(file, 'changed');
  if (mutation === 'directory') fs.mkdirSync(path.join(f.root, 'empty'));
  if (mutation === 'mode') { if (process.platform === 'win32') return t.skip('POSIX modes'); fs.chmodSync(file, 0o700); }
  assert.throws(() => verifyBundledManagedOutput(f.options.outDir, f.q));
});
for (const drift of ['source-before', 'source-after', 'proof']) test(`rejects ${drift} and retains diagnostic output without marker`, async t => {
  const f = fixture(t); let calls = 0;
  if (drift === 'source-before') fs.appendFileSync(f.nested, 'drift');
  f.deps.verifyManagedIntegrationQualification = async () => { calls++; if (calls === 2) { if (drift === 'source-after') fs.appendFileSync(f.nested, 'drift'); if (drift === 'proof') f.q.receipt.passed = false; } return f.q; };
  await assert.rejects(emitBundledManagedResources(f.options, f.deps), /drift/);
  assert.equal(fs.existsSync(f.root), true); assert.equal(fs.existsSync(f.marker), false);
});
test('default verifier is used, fails without proof and does not delete existing data', async t => {
  const f = fixture(t);
  await assert.rejects(emitBundledManagedResources(f.options));
  assert.equal(fs.existsSync(f.root), false);
});
test('rejects shared hardlinks and source/target ancestor links', async t => {
  const f = fixture(t); fs.linkSync(f.nested, `${f.nested}-shared`);
  await assert.rejects(emitBundledManagedResources(f.options, f.deps), /linked/);
  fs.unlinkSync(`${f.nested}-shared`);
  const link = path.join(path.dirname(f.options.outDir), 'redirect');
  try { fs.symlinkSync(f.options.stageRoot, link, process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) { if (error.code === 'EPERM') return t.skip('symlink privilege'); throw error; }
  await assert.rejects(emitBundledManagedResources({ ...f.options, outDir: path.join(link, 'nested') }, f.deps), /linked/);
  f.q.stage.root = link;
  await assert.rejects(emitBundledManagedResources(f.options, f.deps), /linked/);
});
