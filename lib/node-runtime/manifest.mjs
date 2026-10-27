import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';

export const NODE_RUNTIME_MANIFEST = 'manifest.json';
export const NODE_RUNTIME_SCHEMA_VERSION = 1;
export const NODE_RUNTIME_TARGET = Object.freeze({ platform: 'win32', arch: 'x64', nodeAbi: '137' });

const SHA256 = /^[a-f0-9]{64}$/u;
const VERSION = /^\d+\.\d+\.\d+$/u;
const MANIFEST_MAX_BYTES = 1024 * 1024;

function fail(message) {
  throw new Error(`Node runtime payload: ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys, label) {
  if (!isRecord(value) || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    fail(`${label} has an unsupported shape.`);
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))) return value;
  fail('manifest identity input must contain only JSON values.');
}

function canonicalText(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalManifestText(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function validateManifestWithoutIdentity(manifest) {
  exactKeys(manifest, [
    'schemaVersion', 'kind', 'nodeVersion', 'target', 'executable', 'inventory', 'provenance',
  ], 'Manifest');
  if (manifest.schemaVersion !== NODE_RUNTIME_SCHEMA_VERSION || manifest.kind !== 'node-runtime') {
    fail('manifest schemaVersion or kind is unsupported.');
  }
  if (typeof manifest.nodeVersion !== 'string' || !VERSION.test(manifest.nodeVersion)) {
    fail('manifest nodeVersion must be an exact Node version.');
  }
  exactKeys(manifest.target, ['platform', 'arch', 'nodeAbi'], 'Manifest target');
  if (manifest.target.platform !== NODE_RUNTIME_TARGET.platform || manifest.target.arch !== NODE_RUNTIME_TARGET.arch
    || manifest.target.nodeAbi !== NODE_RUNTIME_TARGET.nodeAbi) {
    fail('manifest target is unsupported.');
  }
  if (manifest.executable !== 'node.exe') fail('manifest executable must be node.exe.');
  if (!Array.isArray(manifest.inventory) || manifest.inventory.length !== 2) {
    fail('manifest inventory must contain exactly LICENSE and node.exe.');
  }
  const expectedPaths = ['LICENSE', 'node.exe'];
  let previous;
  const folded = new Set();
  for (const item of manifest.inventory) {
    exactKeys(item, ['relativePath', 'sizeBytes', 'sha256'], 'Inventory entry');
    if (typeof item.relativePath !== 'string' || !expectedPaths.includes(item.relativePath)) {
      fail(`manifest inventory contains an unsupported path: ${String(item.relativePath)}.`);
    }
    if (previous !== undefined && previous >= item.relativePath) fail('manifest inventory must be uniquely sorted.');
    previous = item.relativePath;
    const foldedPath = item.relativePath.toLowerCase();
    if (folded.has(foldedPath)) fail(`manifest inventory contains a case-colliding path: ${item.relativePath}.`);
    folded.add(foldedPath);
    if (!Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 1 || !SHA256.test(item.sha256)) {
      fail(`manifest inventory entry is invalid: ${item.relativePath}.`);
    }
  }
  if (manifest.inventory.some((entry, index) => entry.relativePath !== expectedPaths[index])) {
    fail('manifest inventory must contain LICENSE followed by node.exe.');
  }
  exactKeys(manifest.provenance, ['kind', 'archiveUrl', 'archiveSha256'], 'Manifest provenance');
  const expectedArchiveUrl = `https://nodejs.org/download/release/v${manifest.nodeVersion}/node-v${manifest.nodeVersion}-win-x64.zip`;
  if (manifest.provenance.kind !== 'local-toolchain' || manifest.provenance.archiveUrl !== expectedArchiveUrl
    || !SHA256.test(manifest.provenance.archiveSha256)) {
    fail('manifest provenance must identify the pinned official Node archive URL and SHA-256 declaration.');
  }
}

function compareStat(left, right) {
  return [left.dev, left.ino, left.mode, left.size, left.mtimeMs, left.ctimeMs].join(':')
    === [right.dev, right.ino, right.mode, right.size, right.mtimeMs, right.ctimeMs].join(':');
}

async function assertNoSymlinkPath(candidate, label) {
  const absolute = path.resolve(candidate);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) fail(`${label} traverses a symbolic link: ${current}.`);
    if (current !== absolute && !info.isDirectory()) fail(`${label} has a non-directory parent: ${current}.`);
  }
  return absolute;
}

async function readManifestFile(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail('directory must be an absolute path.');
  const root = await assertNoSymlinkPath(directory, 'directory');
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail('directory must be an ordinary directory.');
  const file = path.join(root, NODE_RUNTIME_MANIFEST);
  await assertNoSymlinkPath(file, 'manifest.json');
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MANIFEST_MAX_BYTES) {
    fail('manifest.json must be a bounded regular file.');
  }
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || !compareStat(opened, before)) fail('manifest.json changed while opening.');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await lstat(file);
    if (!compareStat(after, before) || !compareStat(pathAfter, before) || bytes.length !== before.size) {
      fail('manifest.json changed while being read.');
    }
    let manifest;
    try { manifest = JSON.parse(bytes.toString('utf8')); }
    catch (error) { throw new Error('Node runtime payload: manifest.json is not valid JSON.', { cause: error }); }
    if (!isRecord(manifest)) fail('manifest.json must contain an object.');
    exactKeys(manifest, [
      'schemaVersion', 'kind', 'nodeVersion', 'target', 'executable', 'inventory', 'provenance', 'payloadIdentity',
    ], 'Manifest');
    const { payloadIdentity, ...withoutIdentity } = manifest;
    validateManifestWithoutIdentity(withoutIdentity);
    if (typeof payloadIdentity !== 'string' || !SHA256.test(payloadIdentity)
      || computeNodeRuntimePayloadIdentity(withoutIdentity) !== payloadIdentity) {
      fail('manifest payloadIdentity does not match its canonical SHA-256 identity.');
    }
    if (canonicalManifestText(manifest) !== bytes.toString('utf8')) fail('manifest.json is not in canonical serialized form.');
    return manifest;
  } finally {
    await handle?.close();
  }
}

/** SHA-256 of recursively key-sorted JSON for the manifest fields excluding payloadIdentity. */
export function computeNodeRuntimePayloadIdentity(manifestWithoutIdentity) {
  if (!isRecord(manifestWithoutIdentity) || Object.hasOwn(manifestWithoutIdentity, 'payloadIdentity')) {
    fail('computeNodeRuntimePayloadIdentity requires a manifest without payloadIdentity.');
  }
  return createHash('sha256').update(canonicalText(manifestWithoutIdentity), 'utf8').digest('hex');
}

/** Read and validate only manifest metadata; payload files are deliberately not traversed or hashed. */
export async function readNodeRuntimeManifest(directory) {
  return readManifestFile(directory);
}
