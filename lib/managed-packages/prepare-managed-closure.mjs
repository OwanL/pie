// Offline preparation only. No runtime identity, package execution, or readiness authority.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { MANAGED_PACKAGE_REQUIREMENTS, adaptManagedPackageSources, classifyManagedPackageSources } from './managed-package-contract.mjs';
import { verifyPreparedManagedPackage } from './prepare-managed-packages.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(`Managed closure preparation: ${message}`); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const within = (root, target) => { const rel = path.relative(root, target); return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)); };
const importer = path.normalize('lib/managed-packages/integrations');
const seams = { 'pi-web-access': { index: 'index.ts', storage: 'storage.ts' }, 'pi-mcp-adapter': { index: 'index.ts', agentDir: 'agent-dir.ts' } };
function relative(value) {
  if (typeof value !== 'string' || !value || /[:\x00-\x1f]/.test(value) || value.split(/[\\/]/).some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /[<>"|?*]/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) fail('invalid relative path');
  return path.normalize(value);
}
async function rootDirectory(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) fail('absolute owned root required');
  let current = path.parse(root).root;
  for (const part of path.relative(current, root).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const st = await fs.lstat(current);
    if (!st.isDirectory() || st.isSymbolicLink()) fail('redirected/non-directory root');
  }
}
// Walk only the explicitly assigned closure, never any surrounding acquisition tree.
async function inventory(root) {
  const result = [], directories = [];
  async function walk(current) {
    for (const entry of (await fs.readdir(current)).sort()) {
      relative(entry);
      if (entry === '.DELETE' || entry.startsWith('.DELETE.') || /\.DELETE\..+/.test(entry)) fail('tombstone entry');
      const file = path.join(current, entry), rel = path.relative(root, file), st = await fs.lstat(file);
      if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) fail('link/special entry');
      if (st.isDirectory()) { directories.push(rel); await walk(file); }
      else if (rel !== 'closure-receipt.json') {
        const bytes = await fs.readFile(file);
        result.push({ path: rel, size: bytes.length, sha256: hash(bytes), mode: st.mode & 0o777 });
      } else if (st.nlink !== 1) fail('receipt must be independent');
    }
  }
  await walk(root);
  return { files: result.sort((a, b) => a.path.localeCompare(b.path)), directories };
}
function validateReceipt(r, status) {
  if (!object(r) || r.schemaVersion !== 1 || r.status !== status || r.ready !== false) fail('invalid receipt status');
  const p = r.provenance;
  if (!object(p) || !sha(p.lockSha256) || !sha(p.modulesSha256) || !['node', 'platform', 'arch'].every(k => typeof p[k] === 'string' && p[k]) || p.pnpm !== '10.34.4') fail('invalid acquisition provenance');
  if (!['nodes', 'edges', 'peerRequirements', 'skips', 'pendingOptionalBuilds', 'inventory'].every(k => Array.isArray(r[k])) || !r.nodes.length) fail('invalid receipt collections');
  const placements = new Set();
  for (const n of r.nodes) {
    const placement = relative(n.placement);
    if (!placement.startsWith(`node_modules${path.sep}`) || placements.has(placement) || typeof n.name !== 'string' || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(n.name) || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(n.version) || typeof n.snapshot !== 'string' || !(n.snapshot === `${n.name}@${n.version}` || n.snapshot.startsWith(`${n.name}@${n.version}(`)) || typeof n.optional !== 'boolean' || !object(n.peerDependencies) || !object(n.peerDependenciesMeta)) fail('invalid node identity/placement');
    if (!placement.endsWith(path.normalize(`node_modules/${n.name}`))) fail('node placement/name mismatch');
    placements.add(placement);
  }
  const validFrom = from => from === importer || placements.has(from);
  for (const e of r.edges) {
    relative(e.from); relative(e.placement);
    if (!validFrom(e.from) || !r.nodes.some(n => n.placement === e.placement && n.snapshot === e.snapshot) || typeof e.optional !== 'boolean') fail('invalid closure edge');
  }
  if (r.edges.filter(e => e.from === importer).length !== 2) fail('unexpected integration roots');
  const reached = new Set([importer]);
  let previous;
  do { previous = reached.size; for (const e of r.edges) if (reached.has(e.from)) reached.add(e.placement); } while (reached.size !== previous);
  for (const n of r.nodes) if (!reached.has(n.placement)) fail('unreachable node');
  for (const p of r.peerRequirements) {
    relative(p.from); if (p.placement !== undefined) relative(p.placement);
    if (!validFrom(p.from) || !sha(p.manifestSha256) || !['dependencies', 'peerDependencies'].includes(p.kind) || !['name', 'snapshot', 'requirement', 'version'].every(k => typeof p[k] === 'string' && p[k]) || typeof p.optional !== 'boolean') fail('invalid peer evidence');
  }
  for (const s of r.skips) { relative(s.from); if (!validFrom(s.from) || s.optional !== true || typeof s.snapshot !== 'string') fail('invalid skip evidence'); }
  for (const b of r.pendingOptionalBuilds) {
    relative(b.placement);
    if (!r.nodes.some(n => n.placement === b.placement && n.snapshot === b.snapshot && n.optional && n.name === 'canvas' && n.version === '3.2.3')) fail('invalid pending build evidence');
  }
  const paths = new Set();
  for (const item of r.inventory) {
    const file = relative(item.path);
    if (paths.has(file) || !sha(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 0 || !Number.isInteger(item.mode) || item.mode < 0 || item.mode > 0o777 || !r.nodes.some(n => {
      const rel = path.relative(n.placement, file);
      return rel && within(n.placement, file) && !rel.split(path.sep).includes('node_modules');
    })) fail('invalid own inventory');
    paths.add(file);
  }
  if (!sha(r.inventorySha256) || hash(JSON.stringify(r.inventory)) !== r.inventorySha256) fail('inventory evidence hash mismatch');
}
function packages(root, r) {
  return Object.fromEntries(MANAGED_PACKAGE_REQUIREMENTS.map(pin => {
    const edges = r.edges.filter(e => e.from === importer && e.snapshot.startsWith(`${pin.name}@`));
    if (edges.length !== 1) fail('missing/duplicate integration root');
    const n = r.nodes.find(n => n.placement === edges[0].placement);
    if (n.name !== pin.name || n.version !== pin.version || n.optional || edges[0].optional) fail('incorrect root pin');
    if (n.placement !== path.normalize(`node_modules/${pin.name}`)) fail('incorrect root placement');
    return [pin.name, path.join(root, n.placement)];
  }));
}
// Snapshot names may be scoped and may carry peer-context suffixes.
function snapshotName(snapshot) {
  const match = /^((@[^/@()]+\/)?[^/@()]+)@[^@]+/.exec(snapshot);
  if (!match) fail('invalid dependency snapshot');
  return match[1];
}
async function validateDeclarations(root, manifest, node, receipt) {
  const required = manifest.dependencies ?? {}, optional = manifest.optionalDependencies ?? {};
  if (!object(required) || !object(optional)) fail('invalid dependency declarations');
  const declared = new Set([...Object.keys(required), ...Object.keys(optional)]);
  const covered = new Set();
  for (const edge of receipt.edges.filter(e => e.from === node.placement)) {
    const name = snapshotName(edge.snapshot);
    if (declared.has(name)) {
      covered.add(name);
      const lookup = createRequire(path.join(root, node.placement, 'package.json')).resolve.paths(`${name}/package.json`) ?? [];
      let selected;
      for (const directory of lookup) {
        const candidate = path.join(directory, name, 'package.json');
        if (!within(root, candidate)) continue;
        try { await fs.lstat(candidate); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        selected = path.relative(root, path.dirname(candidate));
        break;
      }
      if (selected !== edge.placement) fail(`dependency placement mismatch: ${node.name} -> ${name}`);
    }
    else if (!Object.hasOwn(manifest.peerDependencies ?? {}, name)) fail(`undeclared outgoing dependency: ${name}`);
  }
  for (const peer of receipt.peerRequirements.filter(p => p.from === node.placement && p.kind === 'dependencies')) {
    if (!declared.has(peer.name) || snapshotName(peer.snapshot) !== peer.name) fail('undeclared stopped dependency');
    covered.add(peer.name);
  }
  for (const skip of receipt.skips.filter(s => s.from === node.placement)) {
    const name = snapshotName(skip.snapshot);
    if (!declared.has(name) || (!Object.hasOwn(optional, name) && !node.optional)) fail(`invalid skipped declaration: ${name}`);
    covered.add(name);
  }
  for (const name of declared) if (!covered.has(name)) fail(`missing declared dependency: ${node.name} -> ${name}`);
}
async function inspect(root, status) {
  await rootDirectory(root);
  const receiptFile = path.join(root, 'closure-receipt.json');
  const st = await fs.lstat(receiptFile);
  if (!st.isFile() || st.isSymbolicLink()) fail('invalid receipt file');
  const receiptBytes = await fs.readFile(receiptFile);
  const receipt = JSON.parse(receiptBytes);
  validateReceipt(receipt, status);
  const actual = await inventory(root);
  if (JSON.stringify(actual.files) !== JSON.stringify(receipt.inventory)) fail('inventory drift');
  // Empty/unrecorded directories also violate exact owned-tree evidence.
  for (const dir of actual.directories) if (!actual.files.some(f => within(dir, f.path))) fail('unrecorded directory');
  for (const n of receipt.nodes) {
    const manifest = JSON.parse(await fs.readFile(path.join(root, n.placement, 'package.json')));
    if (manifest.name !== n.name || manifest.version !== n.version || JSON.stringify(manifest.peerDependencies ?? {}) !== JSON.stringify(n.peerDependencies) || JSON.stringify(manifest.peerDependenciesMeta ?? {}) !== JSON.stringify(n.peerDependenciesMeta)) fail('node manifest drift');
    await validateDeclarations(root, manifest, n, receipt);
  }
  return { receipt, receiptBytes, packages: packages(root, receipt) };
}
async function sourceFiles(root, name) {
  return Object.fromEntries(await Promise.all(Object.entries(seams[name]).map(async ([key, file]) => [key, await fs.readFile(path.join(root, file), 'utf8')])));
}
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

/** Read-only qualification inspection. Unqualified stages never pass shipping verification. */
export async function verifyPreparedManagedClosure(root, { requireReady = true } = {}) {
  const result = await inspect(root, 'adapted-unqualified'), r = result.receipt;
  validateReceipt(r.sourceReceipt, 'pristine-unqualified');
  if (hash(JSON.stringify(r.sourceReceipt)) !== r.sourceReceiptSha256 || !sha(r.sourceInventorySha256) || r.sourceInventorySha256 !== r.sourceReceipt.inventorySha256) fail('invalid original source evidence');
  for (const key of ['provenance', 'nodes', 'edges', 'peerRequirements', 'skips', 'pendingOptionalBuilds']) if (JSON.stringify(r[key]) !== JSON.stringify(r.sourceReceipt[key])) fail('acquisition evidence changed');
  if (!Array.isArray(r.adaptations) || r.adaptations.length !== 4) fail('incomplete adaptation evidence');
  const expected = new Map(r.sourceReceipt.inventory.map(item => [item.path, item]));
  const seen = new Set();
  for (const [name, target] of Object.entries(result.packages)) {
    await verifyPreparedManagedPackage(target, name, { nodeModulesRoot: path.join(root, 'node_modules') });
    const current = await sourceFiles(target, name);
    for (const [key, file] of Object.entries(seams[name])) {
      const rel = path.relative(root, path.join(target, file));
      const evidence = r.adaptations.find(a => a.path === rel);
      const before = expected.get(rel), after = r.inventory.find(i => i.path === rel);
      if (!evidence || seen.has(rel) || evidence.package !== name || evidence.seam !== key || !before || !after || evidence.beforeSha256 !== before.sha256 || evidence.afterSha256 !== after.sha256 || hash(current[key]) !== after.sha256) fail('invalid adaptation evidence');
      seen.add(rel); expected.set(rel, { ...before, size: after.size, sha256: after.sha256 });
    }
  }
  if (JSON.stringify([...expected.values()]) !== JSON.stringify(r.inventory)) fail('non-adaptation inventory change');
  if (requireReady) fail(`not ready: ${r.status}; unresolved pending builds: ${r.pendingOptionalBuilds.length}; peer qualification outstanding`);
  return freeze({ root, packages: result.packages, receipt: r });
}

/** Independent full owned-closure copy; source remains pristine and untouched. */
export async function prepareManagedClosure({ sourceRoot, stagingParent }) {
  await rootDirectory(sourceRoot); await rootDirectory(stagingParent);
  sourceRoot = path.resolve(sourceRoot); stagingParent = path.resolve(stagingParent);
  if (within(sourceRoot, stagingParent) || within(stagingParent, sourceRoot)) fail('source/staging must be disjoint');
  const source = await inspect(sourceRoot, 'pristine-unqualified');
  // Reject pre-adapted or unsupported source bytes before creating any output.
  const adapted = {};
  for (const [name, target] of Object.entries(source.packages)) {
    const files = await sourceFiles(target, name);
    if (classifyManagedPackageSources(name, files) !== 'pristine') fail('source seam is not pristine');
    adapted[name] = adaptManagedPackageSources(name, files);
    for (const key of Object.keys(files)) if (files[key] === adapted[name][key]) fail('source seam is not pristine');
  }
  const root = await fs.mkdtemp(path.join(stagingParent, 'prepared-managed-closure-'));
  try {
    for (const item of source.receipt.inventory) {
      const bytes = await fs.readFile(path.join(sourceRoot, item.path));
      if (hash(bytes) !== item.sha256) fail('source changed during copy');
      const target = path.join(root, item.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes, { flag: 'wx', mode: item.mode });
      await fs.chmod(target, item.mode);
      if ((await fs.lstat(target)).nlink !== 1) fail('copy is not independent');
    }
    const targets = packages(root, source.receipt), adaptations = [];
    for (const [name, target] of Object.entries(targets)) for (const [key, file] of Object.entries(seams[name])) {
      const rel = path.relative(root, path.join(target, file));
      await fs.writeFile(path.join(target, file), adapted[name][key], 'utf8');
      adaptations.push({ package: name, seam: key, path: rel, beforeSha256: source.receipt.inventory.find(i => i.path === rel).sha256, afterSha256: hash(adapted[name][key]) });
    }
    const after = await inventory(root);
    const receipt = { ...source.receipt, status: 'adapted-unqualified', ready: false, sourceReceipt: source.receipt, sourceReceiptSha256: hash(JSON.stringify(source.receipt)), sourceInventorySha256: source.receipt.inventorySha256, adaptations, inventory: after.files, inventorySha256: hash(JSON.stringify(after.files)) };
    await fs.writeFile(path.join(root, 'closure-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
    const again = await inspect(sourceRoot, 'pristine-unqualified');
    if (!source.receiptBytes.equals(again.receiptBytes)) fail('source receipt changed');
    return await verifyPreparedManagedClosure(root, { requireReady: false });
  } catch (error) { await fs.rm(root, { recursive: true, force: true }); throw error; }
}
