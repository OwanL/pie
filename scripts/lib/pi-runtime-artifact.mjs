// Pi runtime artifact v1. This is consistency/provenance evidence, not a signature
// or an authorization boundary. Callers own source/lock fingerprint production and
// must finish materializing the artifact before writing/verifying its manifest.
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const PI_RUNTIME_PACKAGES = Object.freeze([
  '@earendil-works/pi-tui',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-coding-agent',
]);
export const PI_RUNTIME_SDK_RELATIVE_PATH = 'node_modules/@earendil-works/pi-coding-agent';
const VERSION = '0.80.6';
const COMMIT = '2b3fda9921b5590f285165287bd442a25817f17b';
const SHA256 = /^[a-f0-9]{64}$/;
const SDK_FILES = [
  'dist/cli.js', 'dist/rpc-entry.js',
  'dist/modes/interactive/theme/dark.json',
  'dist/modes/interactive/theme/light.json',
  'dist/modes/interactive/theme/theme-schema.json',
  'dist/modes/interactive/assets/clankolas.png',
  'dist/core/export-html/template.html',
  'dist/core/export-html/template.css',
  'dist/core/export-html/template.js',
  'dist/core/export-html/vendor/marked.min.js',
  'dist/core/export-html/vendor/highlight.min.js',
];

/** @typedef {{platform: string, arch: string, nodeAbi: string}} PiRuntimeTarget */
/**
 * @typedef {object} PiRuntimeProvenance
 * @property {string} upstreamVersion Must be 0.80.6 for schema v1.
 * @property {string} upstreamCommit The exact imported upstream commit.
 * @property {string} sourceTreeSha256 Caller-supplied source fingerprint (not a Git SHA-1).
 * @property {string} lockSha256 Caller-supplied runtime dependency lock fingerprint.
 * @property {PiRuntimeTarget} target Explicit build target, including Node's modules ABI.
 */
/**
 * @typedef {PiRuntimeProvenance & {
 *   schemaVersion: 1,
 *   packages: Record<string, {version: string, treeSha256: string}>,
 *   payloadSha256: string
 * }} PiRuntimeManifest
 */
/**
 * @typedef {object} VerifiedPiRuntimeArtifact
 * @property {PiRuntimeManifest} manifest
 * @property {string} identity SHA-256 of canonical manifest JSON, including provenance.
 * @property {string} artifactDir Canonical absolute artifact directory.
 * @property {string} sdkPath Canonical absolute SDK package directory, not its entry file.
 */

function check(condition, message) {
  if (!condition) throw new Error(`Invalid Pi runtime artifact: ${message}`);
}
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}
function validateTarget(target) {
  check(object(target), 'target must be an object');
  for (const field of ['platform', 'arch']) {
    check(typeof target[field] === 'string' && /^[a-z0-9_-]+$/.test(target[field]), `target.${field} must be a nonempty identifier`);
  }
  check(typeof target.nodeAbi === 'string' && /^\d+$/.test(target.nodeAbi), 'target.nodeAbi must be a decimal string');
}
function validateProvenance(provenance) {
  check(object(provenance), 'provenance must be an object');
  check(provenance.upstreamVersion === VERSION, `upstreamVersion must be ${VERSION}`);
  check(provenance.upstreamCommit === COMMIT, `upstreamCommit must be ${COMMIT}`);
  for (const field of ['sourceTreeSha256', 'lockSha256']) {
    check(typeof provenance[field] === 'string' && SHA256.test(provenance[field]), `${field} must be a SHA-256 hex digest`);
  }
  validateTarget(provenance.target);
}
function validateManifest(manifest) {
  check(object(manifest) && manifest.schemaVersion === 1, 'unsupported manifest schemaVersion');
  validateProvenance(manifest);
  check(object(manifest.packages), 'packages must be an object');
  check(Object.keys(manifest.packages).sort().join('\n') === [...PI_RUNTIME_PACKAGES].sort().join('\n'), 'manifest must identify exactly the four core Pi packages');
  for (const name of PI_RUNTIME_PACKAGES) {
    const pkg = manifest.packages[name];
    check(object(pkg) && pkg.version === VERSION, `${name} manifest version must be ${VERSION}`);
    check(typeof pkg.treeSha256 === 'string' && SHA256.test(pkg.treeSha256), `${name} treeSha256 must be a SHA-256 hex digest`);
  }
  check(typeof manifest.payloadSha256 === 'string' && SHA256.test(manifest.payloadSha256), 'payloadSha256 must be a SHA-256 hex digest');
}
async function json(file, label) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid Pi runtime artifact: cannot read ${label}`, { cause: error });
  }
}

// A tree digest is SHA-256(JSON.stringify(sorted [relative POSIX path, file SHA-256]
// pairs)). Sorting is binary JS string ordering, never locale/enumeration order.
// Contents and paths are bound; timestamps, permissions and empty directories are
// deliberately not identity. Package hashes include nested ordinary dependencies.
function treeDigest(files, prefix = '') {
  return digest(JSON.stringify(files.filter(([name]) => name.startsWith(prefix))
    .map(([name, hash]) => [name.slice(prefix.length), hash])
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
}

async function inspect(artifactDir) {
  const input = path.resolve(artifactDir);
  const rootStat = await lstat(input);
  check(!rootStat.isSymbolicLink() && rootStat.isDirectory(), 'artifact root must be a real directory, not a symlink');
  const root = await realpath(input);
  const files = [];
  const manifests = new Map();
  const directories = new Set();
  async function walk(relative) {
    for (const entry of await readdir(path.join(root, relative))) {
      const name = relative ? `${relative}/${entry}` : entry;
      // Avoid hashing then overwriting the same file through a case-insensitive
      // alias on Windows. Canonical spelling also keeps artifacts portable.
      check(name.toLowerCase() !== 'manifest.json' || name === 'manifest.json', 'manifest filename must be exactly manifest.json');
      const absolute = path.join(root, name);
      const stat = await lstat(absolute);
      check(!stat.isSymbolicLink(), `symlink forbidden: ${name}`);
      if (stat.isDirectory()) {
        directories.add(name);
        const marker = /(?:^|\/)node_modules\/(@earendil-works\/pi-[^/]+)$/.exec(name);
        if (marker) check(PI_RUNTIME_PACKAGES.includes(marker[1]) && name === `node_modules/${marker[1]}`, `nested, duplicate or unsupported Pi package: ${name}`);
        await walk(name);
      } else {
        check(stat.isFile(), `non-regular file forbidden: ${name}`);
        if (name === 'manifest.json') continue;
        const bytes = await readFile(absolute);
        files.push([name, digest(bytes)]);
        if (entry === 'package.json') {
          let pkg;
          try { pkg = JSON.parse(bytes.toString('utf8')); } catch {
            // Example/fixture package.json files are payload, not necessarily packages.
            continue;
          }
          if (typeof pkg?.name === 'string' && pkg.name.startsWith('@earendil-works/pi-')) {
            check(PI_RUNTIME_PACKAGES.includes(pkg.name) && name === `node_modules/${pkg.name}/package.json`, `nested, duplicate or unsupported Pi package identity: ${name}`);
          }
          manifests.set(name, pkg);
        }
      }
    }
  }
  await walk('');
  check(directories.has('node_modules'), 'missing node_modules');
  const names = new Set(files.map(([name]) => name));
  const requireFile = (name) => check(names.has(name), `missing required file: ${name}`);
  const packages = {};
  for (const name of PI_RUNTIME_PACKAGES) {
    const prefix = `node_modules/${name}/`;
    const pkg = manifests.get(`${prefix}package.json`);
    check(object(pkg) && pkg.name === name, `root package identity mismatch: ${name}`);
    check(pkg.version === VERSION, `${name} package version must be ${VERSION}`);
    requireFile(`${prefix}dist/index.js`);
    // Each materialized package carries the upstream root MIT license, like npm's
    // package payload; inline third-party notices travel with their hashed files.
    requireFile(`${prefix}LICENSE`);
    packages[name] = { version: pkg.version, treeSha256: treeDigest(files, prefix) };
  }
  for (const file of SDK_FILES) requireFile(`${PI_RUNTIME_SDK_RELATIVE_PATH}/${file}`);
  return { root, packages, payloadSha256: treeDigest(files) };
}

function result(manifest, root) {
  return {
    manifest,
    identity: digest(canonicalJson(manifest)),
    artifactDir: root,
    sdkPath: path.join(root, PI_RUNTIME_SDK_RELATIVE_PATH),
  };
}

/**
 * Hash an explicitly supplied, fully materialized artifact and write manifest.json.
 * No source lookup, installs, imports or network access. Only manifest.json is
 * written; existing manifests are replaced. Caller must prevent concurrent writes.
 * @param {string} artifactDir The pi-runtime directory containing node_modules.
 * @param {PiRuntimeProvenance} provenance Explicit provenance and build target.
 * @returns {Promise<VerifiedPiRuntimeArtifact>}
 */
export async function writePiRuntimeManifest(artifactDir, provenance) {
  validateProvenance(provenance);
  const inspected = await inspect(artifactDir);
  const manifest = {
    schemaVersion: 1,
    upstreamVersion: provenance.upstreamVersion,
    upstreamCommit: provenance.upstreamCommit,
    sourceTreeSha256: provenance.sourceTreeSha256,
    lockSha256: provenance.lockSha256,
    target: { platform: provenance.target.platform, arch: provenance.target.arch, nodeAbi: provenance.target.nodeAbi },
    packages: inspected.packages,
    payloadSha256: inspected.payloadSha256,
  };
  await writeFile(path.join(inspected.root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return result(manifest, inspected.root);
}

/**
 * Read-only schema, target, package graph and complete payload verification.
 * Default target is this Node process; pass target explicitly for cross-target
 * artifact checks. No source/global SDK fallback and no module execution.
 * @param {string} artifactDir
 * @param {{target?: PiRuntimeTarget}} [options]
 * @returns {Promise<VerifiedPiRuntimeArtifact>}
 */
export async function verifyPiRuntimeArtifact(artifactDir, { target = {
  platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules,
} } = {}) {
  validateTarget(target);
  const inspected = await inspect(artifactDir);
  const manifest = await json(path.join(inspected.root, 'manifest.json'), 'manifest.json');
  validateManifest(manifest);
  for (const field of ['platform', 'arch', 'nodeAbi']) check(manifest.target[field] === target[field], `target.${field} mismatch`);
  for (const name of PI_RUNTIME_PACKAGES) check(manifest.packages[name].treeSha256 === inspected.packages[name].treeSha256, `${name} package hash mismatch`);
  check(manifest.payloadSha256 === inspected.payloadSha256, 'payload hash mismatch');
  return result(manifest, inspected.root);
}
