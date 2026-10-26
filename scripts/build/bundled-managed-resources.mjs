// Delivery-only copy boundary: consumes proof, never executes staged packages.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { verifyManagedIntegrationQualification } from '../verification/managed-qualification-receipt.mjs';
import { BUNDLED_MANAGED_ROOT_RELATIVE_PATH, createBundledManagedInventory, readBundledManagedResources } from '../../lib/managed-packages/bundled-resources.mjs';

const fail = message => { throw new Error(`Bundled managed output: ${message}`); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function checked(file, directory = false, missing = false) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) fail('absolute path required');
  let current = path.parse(file).root;
  const parts = path.relative(current, file).split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let st;
    try { st = fs.lstatSync(current); } catch (error) { if (missing && error.code === 'ENOENT') return; throw error; }
    if (st.isSymbolicLink() || (i < parts.length - 1 || directory ? !st.isDirectory() : !st.isFile() || st.nlink !== 1)) fail('linked/special path');
  }
}
function inventory(q) {
  const seen = new Set();
  return q.stage.receipt.inventory.map(item => {
    if (typeof item.path !== 'string' || /[:\x00-\x1f<>"|?*]/.test(item.path)) fail('invalid inventory path');
    const parts = item.path.split(/[\\/]/);
    if (parts[0] !== 'node_modules' || parts.length < 3 || parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) fail('non-payload inventory path');
    const relative = parts.join(path.sep);
    if (seen.has(relative)) fail('duplicate inventory path');
    seen.add(relative);
    return { ...item, path: relative };
  });
}
function bindings(q) {
  return { runtimeIdentity: q.runtime.identity, closureInventorySha256: q.stage.receipt.inventorySha256, qualificationRecipeSha256: q.qualificationRecipeSha256, target: q.runtime.manifest.target };
}
function payload(root, q, marker = false) {
  checked(root, true);
  const expected = new Map(inventory(q).map(item => [item.path, item]));
  const dirs = new Set();
  for (const name of expected.keys()) for (let dir = path.dirname(name); dir !== '.'; dir = path.dirname(dir)) dirs.add(dir);
  function walk(dir) {
    for (const name of fs.readdirSync(path.join(root, dir))) {
      const rel = path.join(dir, name), file = path.join(root, rel), st = fs.lstatSync(file);
      if (st.isSymbolicLink()) fail('linked payload');
      if (st.isDirectory()) { if (!dirs.has(rel)) fail('extra directory'); walk(rel); continue; }
      checked(file);
      if (marker && rel === 'manifest.json') continue;
      const item = expected.get(rel);
      if (!item) fail('extra payload file');
      const bytes = fs.readFileSync(file);
      if (bytes.length !== item.size || hash(bytes) !== item.sha256 || (st.mode & 0o777) !== item.mode) fail('payload bytes/mode mismatch');
      expected.delete(rel);
    }
  }
  walk('');
  if (expected.size) fail('missing payload file');
}
export function verifyBundledManagedOutput(outDir, qualification) {
  const root = path.resolve(outDir, BUNDLED_MANAGED_ROOT_RELATIVE_PATH);
  checked(outDir, true);
  payload(root, qualification, true);
  const expected = createBundledManagedInventory(bindings(qualification));
  const result = readBundledManagedResources(outDir, { expectedRuntimeIdentity: qualification.runtime.identity, target: qualification.runtime.manifest.target });
  if (!result || !isDeepStrictEqual(result.manifest, expected)) fail('missing or mismatched marker');
  return result;
}
export async function emitBundledManagedResources(options, deps = {}) {
  const { outDir, stageRoot, artifactDir, receiptPath } = options;
  if (typeof outDir !== 'string' || !path.isAbsolute(outDir)) fail('absolute outDir required');
  const root = path.join(outDir, BUNDLED_MANAGED_ROOT_RELATIVE_PATH);
  checked(root, true, true);
  try { fs.lstatSync(root); fail('destination already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const verify = deps.verifyManagedIntegrationQualification ?? verifyManagedIntegrationQualification;
  const args = { stageRoot, artifactDir, receiptPath };
  checked(stageRoot, true);
  const q = await verify(args);
  // Snapshot by value: injected verifiers may reuse mutable objects.
  const snapshot = structuredClone(q);
  createBundledManagedInventory(bindings(snapshot));
  checked(snapshot.stage.root, true);
  for (const item of inventory(snapshot)) checked(path.join(snapshot.stage.root, item.path));
  fs.mkdirSync(path.dirname(root), { recursive: true });
  checked(path.dirname(root), true);
  fs.mkdirSync(root); // exclusive ownership, never remove caller data
  const marker = path.join(root, 'manifest.json');
  let wroteMarker = false;
  try {
    for (const item of inventory(snapshot)) {
      const source = path.join(snapshot.stage.root, item.path), target = path.join(root, item.path);
      checked(source);
      const st = fs.lstatSync(source), bytes = fs.readFileSync(source);
      if (bytes.length !== item.size || hash(bytes) !== item.sha256 || (st.mode & 0o777) !== item.mode) fail('source drift');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      checked(path.dirname(target), true);
      fs.writeFileSync(target, bytes, { flag: 'wx', mode: item.mode });
      fs.chmodSync(target, item.mode);
    }
    payload(root, snapshot);
    const after = await verify(args);
    if (!isDeepStrictEqual(snapshot, after)) fail('qualification drift');
    // Recheck source bytes independently, even when a test verifier is injected.
    for (const item of inventory(snapshot)) {
      const file = path.join(snapshot.stage.root, item.path);
      checked(file);
      const st = fs.lstatSync(file), bytes = fs.readFileSync(file);
      if (hash(bytes) !== item.sha256 || bytes.length !== item.size || (st.mode & 0o777) !== item.mode) fail('source drift');
    }
    payload(root, snapshot);
    const fd = fs.openSync(marker, 'wx');
    wroteMarker = true;
    try { fs.writeFileSync(fd, JSON.stringify(createBundledManagedInventory(bindings(snapshot)))); }
    finally { fs.closeSync(fd); }
    verifyBundledManagedOutput(outDir, snapshot);
    return q;
  } catch (error) {
    if (wroteMarker) fs.unlinkSync(marker);
    throw error;
  }
}
