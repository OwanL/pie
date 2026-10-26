// Bounded pristine acquisition adapter, NOT a package manager or readiness check.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { MANAGED_PACKAGE_REQUIREMENTS } from './managed-package-contract.mjs';

const importer = 'lib/managed-packages/integrations';
const workspacePeers = Object.freeze({
  '@earendil-works/pi-ai': 'harness/pi/packages/ai',
  '@earendil-works/pi-agent-core': 'harness/pi/packages/agent',
  '@earendil-works/pi-coding-agent': 'harness/pi/packages/coding-agent',
  '@earendil-works/pi-tui': 'harness/pi/packages/tui',
});
const peers = new Set([...Object.keys(workspacePeers), ...Object.keys(workspacePeers).map(n => n.replace('@earendil-works/', '@mariozechner/')), 'typebox', '@sinclair/typebox']);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(`Managed closure: ${message}`); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const within = (root, value) => { const rel = path.relative(root, value); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
function relative(value) {
  if (typeof value !== 'string' || !value || /[:\x00-\x1f]/.test(value)) fail('invalid metadata path');
  const parts = value.split(/[\\/]/);
  if (parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /[<>"|?*]/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) fail('invalid path component');
  return parts.join(path.sep);
}
function packageName(name) {
  if (typeof name !== 'string' || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) fail('unsupported dependency name');
  relative(name);
}
async function ordinary(root, target, directory = false) {
  if (!within(root, target)) fail('path escapes owned root');
  let current = root;
  for (const part of ['', ...path.relative(root, target).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    const st = await fs.lstat(current);
    if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) fail(`link/special file: ${current}`);
    if (current !== target && !st.isDirectory()) fail('non-directory ancestor');
    if (current === target && directory && !st.isDirectory()) fail('expected directory');
  }
}
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

/** Creates an independent, explicitly unqualified stage; never executes package code. */
export async function materializeManagedIntegrationClosure({ acquisitionRoot, stagingParent, provenance }) {
  if (![acquisitionRoot, stagingParent].every(p => typeof p === 'string' && path.isAbsolute(p))) fail('absolute owned roots required');
  let repo = path.resolve(acquisitionRoot), parent = path.resolve(stagingParent);
  if (within(repo, parent) || within(parent, repo)) fail('staging and acquisition must be disjoint');
  await ordinary(repo, repo, true); await ordinary(parent, parent, true);
  // Reject redirected root ancestors as well as redirected descendants.
  for (const root of [repo, parent]) await ordinary(path.parse(root).root, root, true);
  repo = await fs.realpath(repo); parent = await fs.realpath(parent);
  if (within(repo, parent) || within(parent, repo)) fail('staging and acquisition must be disjoint');
  const nm = path.join(repo, 'node_modules');
  const auxiliaryHashes = new Map();
  if (!object(provenance) || !['lockSha256', 'modulesSha256'].every(k => /^[a-f0-9]{64}$/.test(provenance[k])) || !['node', 'pnpm', 'platform', 'arch'].every(k => typeof provenance[k] === 'string' && provenance[k])) fail('invalid provenance');
  const bound = Object.fromEntries(['lockSha256', 'modulesSha256', 'node', 'pnpm', 'platform', 'arch'].map(k => [k, provenance[k]]));
  if (bound.node !== process.versions.node || bound.platform !== process.platform || bound.arch !== process.arch || bound.pnpm !== '10.34.4') fail('unsupported acquisition toolchain');
  const metadata = {};
  for (const [key, file] of [['lock', 'pnpm-lock.yaml'], ['modules', 'node_modules/.modules.yaml']]) {
    const source = path.join(repo, file); await ordinary(repo, source);
    const bytes = await fs.readFile(source); if (digest(bytes) !== bound[`${key}Sha256`]) fail(`${key} hash mismatch`);
    metadata[key] = parse(bytes.toString());
  }
  const { lock, modules } = metadata;
  if (String(lock?.lockfileVersion) !== '9.0' || !object(lock.snapshots) || !object(lock.packages) || !object(lock.importers) || modules?.layoutVersion !== 5 || modules.nodeLinker !== 'hoisted' || modules.packageManager !== `pnpm@${bound.pnpm}` || !object(modules.hoistedLocations) || !Array.isArray(modules.skipped) || !Array.isArray(modules.pendingBuilds)) fail('unsupported metadata schema/layout');
  if (![...modules.skipped, ...modules.pendingBuilds].every(x => typeof x === 'string')) fail('invalid status metadata');
  const placementOwners = new Map();
  for (const [key, locations] of Object.entries(modules.hoistedLocations)) {
    if (!Array.isArray(locations) || !locations.length) fail(`invalid placements ${key}`);
    const seen = new Set();
    for (const loc of locations) {
      const value = path.join(repo, relative(loc));
      if (!within(repo, value) || !relative(loc).split(path.sep).includes('node_modules')) fail('invalid package placement');
      if (seen.has(value) || (placementOwners.has(value) && placementOwners.get(value) !== key)) fail('duplicate/colliding metadata placement');
      seen.add(value); placementOwners.set(value, key);
    }
  }
  const roots = lock.importers[importer]?.dependencies;
  if (!object(roots) || Object.keys(roots).length !== 2) fail('unexpected integration roots');
  const importerFile = path.join(repo, importer, 'package.json'); await ordinary(repo, importerFile);
  const importerBytes = await fs.readFile(importerFile);
  auxiliaryHashes.set(importerFile, digest(importerBytes));
  const importerManifest = JSON.parse(importerBytes);
  for (const { name, version } of MANAGED_PACKAGE_REQUIREMENTS) if (roots[name]?.specifier !== version || roots[name]?.version?.split('(')[0] !== version || importerManifest.dependencies?.[name] !== version) fail('root pin mismatch');
  if (Object.keys(importerManifest.dependencies ?? {}).length !== 2) fail('unexpected manifest roots');
  const nodes = new Map(), edges = [], skips = [], peerRequirements = [], queue = [];
  for (const { name } of MANAGED_PACKAGE_REQUIREMENTS) queue.push({ name, ref: roots[name].version, from: path.join(repo, importer), optional: false, manifest: importerManifest });
  while (queue.length) {
    const request = queue.shift(); const { name, ref, from, optional, manifest } = request; packageName(name);
    if (typeof ref !== 'string' || !ref) fail('invalid snapshot reference');
    const key = `${name}@${ref}`, snapshot = lock.snapshots[key];
    if (!object(snapshot)) fail(`missing exact snapshot ${key}`);
    const baseRef = ref.split('(')[0], baseKey = `${name}@${baseRef}`, pkg = lock.packages[baseKey];
    if (!object(pkg)) fail(`missing package metadata ${baseKey}`);
    if ((pkg.name !== undefined && pkg.name !== name) || (pkg.version !== undefined && !baseRef.startsWith('file:') && pkg.version !== baseRef)) fail('package metadata identity mismatch');
    let peerRequirement;
    if (peers.has(name)) {
      const kind = typeof manifest.peerDependencies?.[name] === 'string' ? 'peerDependencies' : 'dependencies';
      if (typeof manifest[kind]?.[name] !== 'string') fail(`undeclared external peer ${name}`);
      peerRequirement = { from: path.relative(repo, from), name, snapshot: key, kind, requirement: manifest[kind][name], optional: kind === 'peerDependencies' && manifest.peerDependenciesMeta?.[name]?.optional === true };
      let peerManifest;
      if (baseRef.startsWith('file:')) {
        const expected = workspacePeers[name];
        if (!expected || baseRef !== `file:${expected}` || pkg.resolution?.type !== 'directory' || pkg.resolution.directory !== expected) fail('unsupported workspace peer');
        const file = path.join(repo, expected, 'package.json'); await ordinary(repo, file);
        const bytes = await fs.readFile(file); peerManifest = JSON.parse(bytes);
        auxiliaryHashes.set(file, digest(bytes));
        if (peerManifest.name !== name || typeof peerManifest.version !== 'string') fail('workspace peer identity mismatch');
        peerRequirements.push({ ...peerRequirement, manifestSha256: digest(bytes), version: peerManifest.version });
        continue;
      }
    }
    if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(baseRef) || pkg.resolution?.type || pkg.resolution?.directory) fail(`unsupported alias/reference ${key}`);
    if (modules.skipped.includes(key) || modules.skipped.includes(baseKey)) {
      if (!optional) fail(`required skipped dependency ${key}`);
      skips.push({ from: path.relative(repo, from), snapshot: key, optional: true }); continue;
    }
    const locations = modules.hoistedLocations[key];
    if (!Array.isArray(locations) || !locations.length) fail(`missing placements ${key}`);
    const recorded = locations.map(loc => { const value = path.join(repo, relative(loc)); if (!within(repo, value) || !relative(loc).split(path.sep).includes('node_modules')) fail('invalid package placement'); return value; });
    let chosen;
    // Use a package search token even for builtin names; never resolve exports.
    for (const search of createRequire(path.join(from, 'package.json')).resolve.paths(`${name}/package.json`) ?? []) {
      const candidate = path.join(search, name);
      // Importer-local ancestors inside the acquisition are searched by Node
      // before root node_modules. Never bypass an existing unrecorded package;
      // outside the acquisition, do not probe global/ancestor directories.
      if (!within(repo, candidate)) continue;
      let exists = true; try { await fs.lstat(candidate); } catch (error) { if (error.code === 'ENOENT') exists = false; else throw error; }
      if (!exists) continue;
      if (!within(nm, candidate) || !recorded.some(p => p === candidate)) fail(`nearer conflicting placement ${key}`);
      await ordinary(repo, candidate, true); chosen = candidate; break;
    }
    if (!chosen) fail(`unreachable placement ${key}`);
    await ordinary(repo, path.join(chosen, 'package.json'));
    const manifestBytes = await fs.readFile(path.join(chosen, 'package.json'));
    auxiliaryHashes.set(path.join(chosen, 'package.json'), digest(manifestBytes));
    const actual = JSON.parse(manifestBytes);
    if (actual.name !== name || actual.version !== baseRef) fail(`identity mismatch ${key}`);
    if (peerRequirement) {
      peerRequirements.push({ ...peerRequirement, placement: path.relative(repo, chosen), manifestSha256: digest(manifestBytes), version: actual.version });
      continue;
    }
    if (actual.bundledDependencies !== undefined || actual.bundleDependencies !== undefined) fail('bundled dependencies unsupported');
    for (const type of ['dependencies', 'optionalDependencies']) for (const [dep, spec] of Object.entries(actual[type] ?? {})) { packageName(dep); if (typeof spec !== 'string' || /^(npm:|file:|link:|workspace:|https?:|git)/.test(spec)) fail('manifest alias/reference unsupported'); }
    edges.push({ from: path.relative(repo, from), snapshot: key, placement: path.relative(repo, chosen), optional });
    const prior = nodes.get(chosen);
    if (prior && prior.snapshot !== key) fail('physical snapshot collision');
    if (prior && (!prior.optional || optional)) continue;
    if (actual.peerDependencies !== undefined && (!object(actual.peerDependencies) || !Object.entries(actual.peerDependencies).every(([peer, range]) => { packageName(peer); return typeof range === 'string'; }))) fail('invalid peer declarations');
    if (actual.peerDependenciesMeta !== undefined && !object(actual.peerDependenciesMeta)) fail('invalid peer metadata');
    const node = prior ?? { name, version: baseRef, snapshot: key, placement: path.relative(repo, chosen), optional, source: chosen, peerDependencies: actual.peerDependencies ?? {}, peerDependenciesMeta: actual.peerDependenciesMeta ?? {} };
    node.optional = optional; nodes.set(chosen, node);
    for (const [type, isOptional] of [['dependencies', false], ['optionalDependencies', true]]) {
      if (snapshot[type] !== undefined && !object(snapshot[type])) fail('invalid dependency map');
      for (const [dep, resolution] of Object.entries(snapshot[type] ?? {})) queue.push({ name: dep, ref: resolution, from: chosen, optional: optional || isOptional, manifest: actual });
    }
  }
  const pendingOptionalBuilds = [];
  for (const node of nodes.values()) if (modules.pendingBuilds.includes(node.snapshot) || modules.pendingBuilds.includes(`${node.name}@${node.version}`)) {
    if (!node.optional) fail(`required pending build ${node.snapshot}`);
    if (node.name !== 'canvas' || node.version !== '3.2.3') fail(`unsupported optional pending build ${node.snapshot}`);
    pendingOptionalBuilds.push({ snapshot: node.snapshot, placement: node.placement });
  }
  // Own files only. Nested package placements are traversed independently.
  async function inventory() {
    const result = [];
    async function walk(root, current) {
      const entries = (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        relative(entry.name); if (entry.name === 'node_modules') continue;
        if (entry.name === '.DELETE' || entry.name.startsWith('.DELETE.') || /\.DELETE\..+/.test(entry.name)) fail('tombstone file');
        const file = path.join(current, entry.name); await ordinary(repo, file);
        const st = await fs.lstat(file);
        if (st.isDirectory()) await walk(root, file);
        else if (st.isFile()) { const bytes = await fs.readFile(file); result.push({ path: path.relative(repo, file), size: bytes.length, sha256: digest(bytes), mode: st.mode & 0o777 }); }
        else fail('unsupported own file');
      }
    }
    for (const node of nodes.values()) await walk(node.source, node.source);
    return result.sort((a, b) => a.path.localeCompare(b.path));
  }
  const before = await inventory();
  const stage = await fs.mkdtemp(path.join(parent, 'managed-closure-'));
  try {
    for (const item of before) {
      const source = path.join(repo, item.path), target = path.join(stage, item.path);
      await ordinary(repo, source); const bytes = await fs.readFile(source);
      if (digest(bytes) !== item.sha256) fail('source changed during copy');
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes, { flag: 'wx', mode: item.mode });
      const copied = await fs.lstat(target);
      if (copied.nlink !== 1 || digest(await fs.readFile(target)) !== item.sha256) fail('copy inventory mismatch');
    }
    if (JSON.stringify(before) !== JSON.stringify(await inventory())) fail('source inventory changed');
    for (const [key, file] of [['lock', 'pnpm-lock.yaml'], ['modules', 'node_modules/.modules.yaml']]) {
      await ordinary(repo, path.join(repo, file));
      if (digest(await fs.readFile(path.join(repo, file))) !== bound[`${key}Sha256`]) fail('source metadata changed');
    }
    for (const [file, sha256] of auxiliaryHashes) {
      await ordinary(repo, file);
      if (digest(await fs.readFile(file)) !== sha256) fail('source peer/importer manifest changed');
    }
    const receipt = { schemaVersion: 1, status: 'pristine-unqualified', ready: false, provenance: bound, nodes: [...nodes.values()].map(({ source, ...node }) => node), edges, peerRequirements, skips, pendingOptionalBuilds, inventory: before, inventorySha256: digest(JSON.stringify(before)) };
    await fs.writeFile(path.join(stage, 'closure-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
    const packages = Object.fromEntries(MANAGED_PACKAGE_REQUIREMENTS.map(({ name }) => {
      const edge = edges.find(e => e.from === path.normalize(importer) && e.snapshot.startsWith(`${name}@`));
      if (!edge) fail('missing root placement');
      return [name, path.join(stage, edge.placement)];
    }));
    return freeze({ root: stage, packages, receipt });
  } catch (error) { await fs.rm(stage, { recursive: true, force: true }); throw error; }
}
