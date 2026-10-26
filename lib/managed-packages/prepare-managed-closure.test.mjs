import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { prepareManagedClosure, verifyPreparedManagedClosure } from './prepare-managed-closure.mjs';
import { verifyPreparedManagedPackage } from './prepare-managed-packages.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const webIndex = [
  'function resolveWorkflow(input: unknown, hasUI: boolean): WebSearchWorkflow {',
  '\tconst normalized = typeof input === "string" ? input.trim().toLowerCase() : "";',
  '\tif (normalized === "auto-summary") return "auto-summary";', '\tif (!hasUI) return "none";',
  '\tif (normalized === "none") return "none";', '\treturn "summary-review";', '}',
  'StringEnum(["none", "summary-review", "auto-summary"], {',
  '\t\t\t\t\tdescription: "Search workflow mode: none = no curator, summary-review = open curator with auto summary draft (default), auto-summary = generate summary without opening curator",',
  '\t\t\t\t}),',
  'Searches auto-open the interactive browser curator and stream results live; set workflow to "none" to skip curation or "auto-summary" for a model-generated summary without the browser curator.',
].join('\n');
const storage = 'import { join } from "node:path";\nexport function getFetchCacheDir(): string {\n\treturn join(getWebSearchConfigDir(), FETCH_CACHE_DIR);\n}';
const mcpIndex = 'import { runMcpScript } from "./mcp-code.ts";\n\n        executeOwner?.throwIfInactive();\n        return runMcpScript(state, params.code, params.timeoutMs, getPiTools, signal);\n';
const agentDir = 'import { join, resolve } from "node:path";\nexport function getAgentPath(...segments: string[]): string {\n  return join(getAgentDir(), ...segments);\n}';
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-prepare-closure-test-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sourceRoot = path.join(base, 'source'), stagingParent = path.join(base, 'stages');
  await fs.mkdir(sourceRoot); await fs.mkdir(stagingParent);
  const inventory = [], nodes = [], edges = [];
  async function write(file, data) {
    const target = path.join(sourceRoot, file);
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, data);
    const st = await fs.stat(target);
    inventory.push({ path: path.normalize(file), size: Buffer.byteLength(data), sha256: hash(data), mode: st.mode & 0o777 });
  }
  async function add(name, version, files = {}, placement = `node_modules/${name}`, optional = false, from = 'lib/managed-packages/integrations') {
    placement = path.normalize(placement);
    nodes.push({ name, version, snapshot: `${name}@${version}`, placement, optional, peerDependencies: {}, peerDependenciesMeta: {} });
    edges.push({ from: path.normalize(from), snapshot: `${name}@${version}`, placement, optional });
    const declarations = name === 'pi-web-access'
      ? { dependencies: { '@mozilla/readability': '^0.6', typebox: '^1' }, optionalDependencies: { linkedom: '^0.18', unavailable: '^1' } }
      : name === 'pi-mcp-adapter' ? { dependencies: { leaf: '^1' } } : {};
    for (const [file, content] of Object.entries({ 'package.json': JSON.stringify({ name, version, ...declarations }), LICENSE: 'fixture license', ...files })) await write(`${placement}/${file}`, content);
  }
  await add('pi-web-access', '0.27.0', { 'index.ts': webIndex, 'storage.ts': storage });
  await add('pi-mcp-adapter', '2.20.1', { 'index.ts': mcpIndex, 'agent-dir.ts': agentDir, 'mcp-code.ts': '// code', 'mcp-script-worker.mjs': '// worker' });
  await add('@mozilla/readability', '0.6.0', { 'Readability.js': '// hoisted' }, undefined, false, 'node_modules/pi-web-access');
  await add('leaf', '1.0.0', { 'asset.wasm': 'asset' }, 'node_modules/pi-mcp-adapter/node_modules/leaf', false, 'node_modules/pi-mcp-adapter');
  await add('linkedom', '0.18.14', { 'package.json': JSON.stringify({ name: 'linkedom', version: '0.18.14', peerDependencies: { canvas: '>= 2' }, peerDependenciesMeta: { canvas: { optional: true } } }) }, undefined, true, 'node_modules/pi-web-access');
  Object.assign(nodes.at(-1), { peerDependencies: { canvas: '>= 2' }, peerDependenciesMeta: { canvas: { optional: true } } });
  await add('canvas', '3.2.3', { 'binding.gyp': 'native unbuilt' }, undefined, true, 'node_modules/linkedom');
  inventory.sort((a, b) => a.path.localeCompare(b.path));
  const receipt = { schemaVersion: 1, status: 'pristine-unqualified', ready: false,
    provenance: { lockSha256: hash('lock'), modulesSha256: hash('modules'), node: process.versions.node, pnpm: '10.34.4', platform: process.platform, arch: process.arch }, nodes, edges,
    peerRequirements: [{ from: path.normalize('node_modules/pi-web-access'), name: 'typebox', snapshot: 'typebox@1.0.0', kind: 'dependencies', requirement: '^1', optional: false, version: '1.0.0', manifestSha256: hash('peer') }],
    skips: [{ from: path.normalize('node_modules/pi-web-access'), snapshot: 'unavailable@1.0.0', optional: true }],
    pendingOptionalBuilds: [{ snapshot: 'canvas@3.2.3', placement: path.normalize('node_modules/canvas') }], inventory, inventorySha256: hash(JSON.stringify(inventory)) };
  const save = () => fs.writeFile(path.join(sourceRoot, 'closure-receipt.json'), JSON.stringify(receipt));
  await save();
  async function manifest(name, changes) {
    const n = receipt.nodes.find(n => n.name === name), file = path.join(n.placement, 'package.json');
    const m = JSON.parse(await fs.readFile(path.join(sourceRoot, file), 'utf8'));
    Object.assign(m, changes);
    const text = JSON.stringify(m); await fs.writeFile(path.join(sourceRoot, file), text);
    const item = receipt.inventory.find(i => i.path === file); item.size = Buffer.byteLength(text); item.sha256 = hash(text);
    receipt.inventory.sort((a, b) => a.path.localeCompare(b.path)); receipt.inventorySha256 = hash(JSON.stringify(receipt.inventory));
  }
  return { sourceRoot, stagingParent, receipt, save, add, manifest };
}
test('copies entire closure independently, adapts all four seams, preserves NON-READY evidence', async t => {
  const f = await fixture(t), before = await fs.readFile(path.join(f.sourceRoot, 'closure-receipt.json'));
  const result = await prepareManagedClosure(f);
  assert.equal(result.receipt.status, 'adapted-unqualified'); assert.equal(result.receipt.ready, false);
  assert.equal(result.receipt.adaptations.length, 4);
  for (const key of ['provenance', 'nodes', 'edges', 'peerRequirements', 'skips', 'pendingOptionalBuilds']) assert.deepEqual(result.receipt[key], f.receipt[key]);
  assert.equal(JSON.stringify(result.receipt).includes(f.sourceRoot), false);
  assert.equal(await fs.readFile(path.join(result.root, 'node_modules/pi-mcp-adapter/node_modules/leaf/asset.wasm'), 'utf8'), 'asset');
  await assert.rejects(fs.stat(path.join(result.root, 'node_modules/pi-web-access/node_modules/@mozilla/readability')));
  const target = path.join(result.packages['pi-web-access'], 'index.ts');
  assert.equal((await fs.stat(target)).nlink, 1);
  const statBefore = await fs.stat(target), bytes = await fs.readFile(target);
  await verifyPreparedManagedClosure(result.root, { requireReady: false });
  await assert.rejects(verifyPreparedManagedClosure(result.root), /not ready.*pending builds: 1/);
  assert.deepEqual(await fs.readFile(target), bytes); assert.equal((await fs.stat(target)).mtimeMs, statBefore.mtimeMs);
  assert.deepEqual(await fs.readFile(path.join(f.sourceRoot, 'closure-receipt.json')), before);
  assert.equal(await fs.readFile(path.join(f.sourceRoot, 'node_modules/pi-web-access/index.ts'), 'utf8'), webIndex);
  await fs.writeFile(target, 'independent');
  assert.equal(await fs.readFile(path.join(f.sourceRoot, 'node_modules/pi-web-access/index.ts'), 'utf8'), webIndex);
});
for (const failure of ['status', 'ready', 'provenance', 'inventory-hash', 'drift', 'extra-file', 'empty-dir', 'wrong-pin', 'missing-file', 'source-seam', 'link']) {
  test(`rejects pristine ${failure} without output`, async t => {
    const f = await fixture(t);
    if (failure === 'status') f.receipt.status = 'adapted-unqualified';
    if (failure === 'ready') f.receipt.ready = true;
    if (failure === 'provenance') f.receipt.provenance.lockSha256 = 'bad';
    if (failure === 'inventory-hash') f.receipt.inventorySha256 = hash('bad');
    if (failure === 'wrong-pin') {
      const node = f.receipt.nodes[0]; node.version = '0.0.0'; node.snapshot = `${node.name}@0.0.0`;
      f.receipt.edges[0].snapshot = node.snapshot;
      const rel = path.join(node.placement, 'package.json'), content = JSON.stringify({ name: node.name, version: node.version });
      await fs.writeFile(path.join(f.sourceRoot, rel), content);
      const item = f.receipt.inventory.find(i => i.path === rel); item.size = Buffer.byteLength(content); item.sha256 = hash(content);
      f.receipt.inventorySha256 = hash(JSON.stringify(f.receipt.inventory));
    }
    if (failure === 'drift' || failure === 'source-seam') {
      const file = path.join(f.sourceRoot, 'node_modules/pi-web-access/index.ts');
      await fs.writeFile(file, 'unsupported');
      if (failure === 'source-seam') { const item = f.receipt.inventory.find(i => i.path === path.normalize('node_modules/pi-web-access/index.ts')); item.sha256 = hash('unsupported'); item.size = 11; f.receipt.inventorySha256 = hash(JSON.stringify(f.receipt.inventory)); }
    }
    if (failure === 'extra-file') await fs.writeFile(path.join(f.sourceRoot, 'extra'), 'bad');
    if (failure === 'empty-dir') await fs.mkdir(path.join(f.sourceRoot, 'unowned'));
    if (failure === 'missing-file') await fs.rm(path.join(f.sourceRoot, 'node_modules/pi-mcp-adapter/mcp-code.ts'));
    if (failure === 'link') await fs.symlink(f.stagingParent, path.join(f.sourceRoot, 'linked'), 'junction');
    await f.save(); await assert.rejects(prepareManagedClosure(f));
    assert.deepEqual(await fs.readdir(f.stagingParent), []);
  });
}
test('rejects a missing declared transitive package even with consistent inventory and hash', async t => {
  const f = await fixture(t);
  const placement = path.normalize('node_modules/pi-mcp-adapter/node_modules/leaf');
  f.receipt.nodes = f.receipt.nodes.filter(n => n.placement !== placement);
  f.receipt.edges = f.receipt.edges.filter(e => e.placement !== placement);
  f.receipt.inventory = f.receipt.inventory.filter(i => !i.path.startsWith(`${placement}${path.sep}`));
  f.receipt.inventorySha256 = hash(JSON.stringify(f.receipt.inventory));
  await fs.rm(path.join(f.sourceRoot, placement), { recursive: true });
  await fs.rm(path.join(f.sourceRoot, 'node_modules/pi-mcp-adapter/node_modules'), { recursive: true });
  await f.save();
  await assert.rejects(prepareManagedClosure(f), /missing declared dependency: pi-mcp-adapter -> leaf/);
  assert.deepEqual(await fs.readdir(f.stagingParent), []);
});
for (const [name, destination, pattern] of [
  ['leaf', 'node_modules/pi-web-access/node_modules/leaf', /dependency placement mismatch: pi-mcp-adapter -> leaf/],
  ['pi-mcp-adapter', 'node_modules/pi-web-access/node_modules/pi-mcp-adapter', /incorrect root placement/],
]) {
  test(`rejects forged wrong-sibling placement for ${name} with recomputed inventory`, async t => {
    const f = await fixture(t);
    const old = f.receipt.nodes.find(n => n.name === name).placement, next = path.normalize(destination);
    const relocate = value => value === old || value.startsWith(`${old}${path.sep}`) ? next + value.slice(old.length) : value;
    await fs.mkdir(path.dirname(path.join(f.sourceRoot, next)), { recursive: true });
    await fs.rename(path.join(f.sourceRoot, old), path.join(f.sourceRoot, next));
    if (name === 'leaf') await fs.rmdir(path.dirname(path.join(f.sourceRoot, old)));
    for (const node of f.receipt.nodes) node.placement = relocate(node.placement);
    for (const edge of f.receipt.edges) { edge.from = relocate(edge.from); edge.placement = relocate(edge.placement); }
    for (const item of f.receipt.inventory) item.path = relocate(item.path);
    f.receipt.inventory.sort((a, b) => a.path.localeCompare(b.path));
    f.receipt.inventorySha256 = hash(JSON.stringify(f.receipt.inventory));
    await f.save();
    await assert.rejects(prepareManagedClosure(f), pattern);
    assert.deepEqual(await fs.readdir(f.stagingParent), []);
  });
}
test('accepts inherited optional skips for required declarations of optional nodes', async t => {
  const f = await fixture(t), placement = path.normalize('node_modules/canvas');
  const file = path.join(placement, 'package.json');
  const content = JSON.stringify({ name: 'canvas', version: '3.2.3', dependencies: { '@fixture/missing': '^1' } });
  await fs.writeFile(path.join(f.sourceRoot, file), content);
  const item = f.receipt.inventory.find(i => i.path === file);
  item.size = Buffer.byteLength(content); item.sha256 = hash(content);
  f.receipt.inventorySha256 = hash(JSON.stringify(f.receipt.inventory));
  f.receipt.skips.push({ from: placement, snapshot: '@fixture/missing@1.0.0(peer@2.0.0)', optional: true });
  await f.save();
  await prepareManagedClosure(f);
  f.receipt.nodes.find(n => n.placement === placement).optional = false;
  f.receipt.pendingOptionalBuilds = [];
  await f.save();
  await assert.rejects(prepareManagedClosure(f), /invalid skipped declaration/);
});
for (const mutation of ['missing-stop', 'wrong-skip-name', 'undeclared-edge']) {
  test(`rejects dependency declaration mismatch: ${mutation}`, async t => {
    const f = await fixture(t);
    if (mutation === 'missing-stop') f.receipt.peerRequirements = [];
    if (mutation === 'wrong-skip-name') f.receipt.skips[0].snapshot = '@unavailable/other@1.0.0';
    if (mutation === 'undeclared-edge') f.receipt.edges.push({ ...f.receipt.edges.find(e => e.snapshot === 'leaf@1.0.0'), from: path.normalize('node_modules/pi-web-access') });
    await f.save();
    await assert.rejects(prepareManagedClosure(f), /declared|declaration/);
    assert.deepEqual(await fs.readdir(f.stagingParent), []);
  });
}
test('qualification verification rejects incomplete bytes, inventory drift and forged status without writing', async t => {
  const f = await fixture(t), result = await prepareManagedClosure(f);
  const receiptFile = path.join(result.root, 'closure-receipt.json');
  const originalReceipt = await fs.readFile(receiptFile);
  const target = path.join(result.packages['pi-mcp-adapter'], 'agent-dir.ts');
  await fs.writeFile(target, agentDir);
  await assert.rejects(verifyPreparedManagedClosure(result.root, { requireReady: false }), /drift/);
  assert.equal(await fs.readFile(target, 'utf8'), agentDir);
  // Even self-consistent inventory/evidence cannot qualify an incomplete adaptation.
  const r = JSON.parse(originalReceipt), item = r.inventory.find(i => i.path === path.relative(result.root, target));
  item.sha256 = hash(agentDir); item.size = Buffer.byteLength(agentDir);
  r.adaptations.find(a => a.path === item.path).afterSha256 = item.sha256;
  r.inventorySha256 = hash(JSON.stringify(r.inventory));
  await fs.writeFile(receiptFile, JSON.stringify(r));
  await assert.rejects(verifyPreparedManagedClosure(result.root, { requireReady: false }), /Incomplete/);
  r.status = 'ready'; r.ready = true;
  await fs.writeFile(receiptFile, JSON.stringify(r));
  await assert.rejects(verifyPreparedManagedClosure(result.root, { requireReady: false }), /status/);
});
const omitCanvas = 'omit-optional-canvas-3.2.3';
async function saveGraph(f) {
  f.receipt.inventory.sort((a, b) => a.path.localeCompare(b.path));
  f.receipt.inventorySha256 = hash(JSON.stringify(f.receipt.inventory));
  await f.save();
}
test('named omission removes unreachable cycles, retains shared nodes and preserves source bytes', async t => {
  const f = await fixture(t);
  // Excluded runtime peers have recorded acquisition placements but are never
  // members of the copied closure's reachable node set.
  f.receipt.peerRequirements[0].placement = path.normalize('node_modules/typebox');
  await f.manifest('canvas', { dependencies: { branch: '^1', shared: '^1' } });
  await f.manifest('pi-mcp-adapter', { dependencies: { leaf: '^1', shared: '^1' } });
  await f.add('branch', '1.0.0', { 'package.json': JSON.stringify({ name: 'branch', version: '1.0.0', dependencies: { cycle: '^1' } }) }, undefined, true, 'node_modules/canvas');
  await f.add('cycle', '1.0.0', { 'package.json': JSON.stringify({ name: 'cycle', version: '1.0.0', dependencies: { branch: '^1' } }) }, undefined, true, 'node_modules/branch');
  f.receipt.edges.push({ from: path.normalize('node_modules/cycle'), snapshot: 'branch@1.0.0', placement: path.normalize('node_modules/branch'), optional: true });
  await f.add('shared', '1.0.0', {}, undefined, false, 'node_modules/pi-mcp-adapter');
  f.receipt.edges.push({ from: path.normalize('node_modules/canvas'), snapshot: 'shared@1.0.0', placement: path.normalize('node_modules/shared'), optional: true });
  await saveGraph(f);
  const before = await fs.readFile(path.join(f.sourceRoot, 'closure-receipt.json'));
  const r = await prepareManagedClosure({ ...f, disposition: omitCanvas });
  assert.deepEqual(r.receipt.sourceReceipt, f.receipt);
  assert.deepEqual(r.receipt.peerRequirements, f.receipt.peerRequirements);
  assert.deepEqual(r.receipt.disposition.omittedNodes.map(n => n.name), ['canvas', 'branch', 'cycle']);
  assert.ok(r.receipt.nodes.some(n => n.name === 'shared'));
  const omitted = new Set(r.receipt.disposition.omittedNodes.map(n => n.placement));
  assert.deepEqual(r.receipt.disposition.omittedEdges, f.receipt.edges.filter(e => omitted.has(e.from) || omitted.has(e.placement)));
  assert.deepEqual(r.receipt.disposition.omittedFiles, f.receipt.inventory.filter(i => [...omitted].some(p => i.path.startsWith(`${p}${path.sep}`))));
  assert.equal(r.receipt.pendingOptionalBuilds.length, 0);
  assert.equal(r.receipt.ready, false);
  assert.equal(r.receipt.status, 'adapted-unqualified');
  assert.equal(r.receipt.disposition.name, omitCanvas);
  assert.equal(JSON.stringify(r.receipt.disposition).includes('AppData'), false);
  assert.deepEqual(await fs.readFile(path.join(f.sourceRoot, 'closure-receipt.json')), before);
  for (const item of f.receipt.inventory) assert.equal(hash(await fs.readFile(path.join(f.sourceRoot, item.path))), item.sha256);
  for (const n of r.receipt.disposition.omittedNodes) await assert.rejects(fs.stat(path.join(r.root, n.placement)), { code: 'ENOENT' });
  await verifyPreparedManagedClosure(r.root, { requireReady: false });
  await assert.rejects(verifyPreparedManagedClosure(r.root), /not ready/);
});
for (const mutation of ['required', 'forged-node', 'forged-edge', 'parent-version', 'canvas-version', 'parent-use', 'unknown']) {
  test(`named omission rejects ${mutation}`, async t => {
    const f = await fixture(t), canvas = f.receipt.nodes.find(n => n.name === 'canvas');
    if (mutation === 'required') {
      await f.manifest('pi-mcp-adapter', { dependencies: { leaf: '^1', canvas: '^3' } });
      f.receipt.edges.push({ from: path.normalize('node_modules/pi-mcp-adapter'), placement: canvas.placement, snapshot: canvas.snapshot, optional: false });
      canvas.optional = false; f.receipt.pendingOptionalBuilds = [];
    }
    if (mutation === 'forged-node') f.receipt.nodes.find(n => n.name === 'leaf').optional = true;
    if (mutation === 'forged-edge') f.receipt.edges.find(e => e.snapshot === 'leaf@1.0.0').optional = true;
    if (mutation === 'parent-version' || mutation === 'canvas-version') {
      const n = mutation === 'parent-version' ? f.receipt.nodes.find(n => n.name === 'linkedom') : canvas;
      n.version = '9.0.0'; n.snapshot = `${n.name}@${n.version}`;
      f.receipt.edges.find(e => e.placement === n.placement).snapshot = n.snapshot;
      await f.manifest(n.name, { version: n.version });
      if (mutation === 'canvas-version') f.receipt.pendingOptionalBuilds = [];
    }
    if (mutation === 'parent-use') await f.manifest('linkedom', { optionalDependencies: { canvas: '^3' } });
    await saveGraph(f);
    await assert.rejects(prepareManagedClosure({ ...f, disposition: mutation === 'unknown' ? 'omit-canvas' : omitCanvas }));
    assert.deepEqual(await fs.readdir(f.stagingParent), []);
  });
}
for (const mutation of ['metadata', 'source-manifest', 'extra-deletion']) {
  test(`omission verification rejects forged ${mutation}`, async t => {
    const f = await fixture(t), result = await prepareManagedClosure({ ...f, disposition: omitCanvas });
    const r = JSON.parse(JSON.stringify(result.receipt));
    if (mutation === 'metadata') r.disposition.sourceEvidence.push('forged proof');
    if (mutation === 'source-manifest') r.sourceManifests[path.normalize('node_modules/canvas')] += ' ';
    if (mutation === 'extra-deletion') {
      const file = path.normalize('node_modules/pi-mcp-adapter/node_modules/leaf/asset.wasm');
      await fs.rm(path.join(result.root, file));
      r.inventory = r.inventory.filter(i => i.path !== file);
      r.inventorySha256 = hash(JSON.stringify(r.inventory));
    }
    await fs.writeFile(path.join(result.root, 'closure-receipt.json'), JSON.stringify(r));
    await assert.rejects(verifyPreparedManagedClosure(result.root, { requireReady: false }), /omission metadata|manifest evidence|inventory change/);
  });
}
test('hoisted dependency requires explicit same closure root, never ancestor discovery', async t => {
  const f = await fixture(t), result = await prepareManagedClosure(f), web = result.packages['pi-web-access'];
  await assert.rejects(verifyPreparedManagedPackage(web, 'pi-web-access'), /ENOENT/);
  await verifyPreparedManagedPackage(web, 'pi-web-access', { nodeModulesRoot: path.join(result.root, 'node_modules') });
  await assert.rejects(verifyPreparedManagedPackage(web, 'pi-web-access', { nodeModulesRoot: path.join(f.sourceRoot, 'node_modules') }), /belong/);
});
