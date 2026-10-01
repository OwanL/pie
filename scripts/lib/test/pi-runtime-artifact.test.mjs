import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  PI_RUNTIME_PACKAGES,
  PI_RUNTIME_SDK_RELATIVE_PATH,
  writePiRuntimeManifest,
  verifyPiRuntimeArtifact,
} from '../pi-runtime-artifact.mjs';

const target = { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules };
const provenance = {
  upstreamVersion: '0.80.6',
  upstreamCommit: '2b3fda9921b5590f285165287bd442a25817f17b',
  sourceTreeSha256: 'a'.repeat(64),
  lockSha256: 'b'.repeat(64),
  target,
};
const sdkAssets = [
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
async function put(root, relative, text) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}
async function fixture(t, reverse = false) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'pie-pi-artifact-test-'));
  t.after(() => rm(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const root = path.join(parent, 'pi-runtime');
  const files = [];
  for (const name of PI_RUNTIME_PACKAGES) {
    const prefix = `node_modules/${name}/`;
    files.push([`${prefix}package.json`, JSON.stringify({
      name, version: '0.80.6', type: 'module', main: './dist/index.js',
      exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
      dependencies: { typebox: '1.1.38' },
    })]);
    files.push([`${prefix}dist/index.js`, "export { Type } from 'typebox';\n"]);
    files.push([`${prefix}LICENSE`, 'MIT License\nCopyright (c) 2025 Mario Zechner\n']);
  }
  for (const file of sdkAssets) files.push([`${PI_RUNTIME_SDK_RELATIVE_PATH}/${file}`, `fixture:${file}\n`]);
  files.push(['node_modules/typebox/package.json', JSON.stringify({ name: 'typebox', version: '1.1.38', type: 'module', exports: './index.js' })]);
  files.push(['node_modules/typebox/index.js', 'export const Type = {};\n']);
  files.push(['node_modules/typebox/LICENSE', 'MIT third-party fixture\n']);
  files.push(['node_modules/ordinary/a.txt', 'a']);
  files.push(['node_modules/ordinary/Z.txt', 'z']);
  files.push(['node_modules/ordinary/é.txt', 'unicode']);
  if (reverse) files.reverse();
  for (const [file, text] of files) await put(root, file, text);
  return root;
}
async function changeManifest(root, change) {
  const file = path.join(root, 'manifest.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  change(manifest);
  await writeFile(file, JSON.stringify(manifest));
}
async function snapshot(root) {
  const result = {};
  async function walk(dir = '') {
    for (const entry of (await readdir(path.join(root, dir))).sort()) {
      const relative = dir ? `${dir}/${entry}` : entry;
      const absolute = path.join(root, relative);
      const stat = await lstat(absolute);
      result[relative] = { mtimeMs: stat.mtimeMs, size: stat.size };
      if (stat.isDirectory()) await walk(relative);
      else result[relative].bytes = (await readFile(absolute)).toString('base64');
    }
  }
  await walk();
  return result;
}

test('manifest is deterministic across enumeration order and relocatable, with one shared TypeBox fixture', async (t) => {
  const first = await fixture(t);
  const second = await fixture(t, true);
  const a = await writePiRuntimeManifest(first, provenance);
  const b = await writePiRuntimeManifest(second, provenance);
  assert.deepEqual(a.manifest, b.manifest);
  assert.equal(a.identity, b.identity);
  assert.match(a.identity, /^[a-f0-9]{64}$/);
  assert.equal(a.sdkPath, path.join(a.artifactDir, PI_RUNTIME_SDK_RELATIVE_PATH));
  const relocated = path.join(path.dirname(first), 'elsewhere');
  await cp(first, relocated, { recursive: true });
  await rm(first, { recursive: true });
  const verified = await verifyPiRuntimeArtifact(relocated);
  assert.equal(verified.identity, a.identity);
  assert.equal(verified.sdkPath, path.join(verified.artifactDir, PI_RUNTIME_SDK_RELATIVE_PATH));
  // TypeBox is one ordinary payload package, not bundled per core package. This
  // library binds its bytes but deliberately does not implement module resolution.
  assert.equal(JSON.parse(await readFile(path.join(relocated, 'node_modules/typebox/package.json'))).version, '1.1.38');
});

test('verification is read-only; rewriting the excluded manifest is idempotent', async (t) => {
  const root = await fixture(t);
  const written = await writePiRuntimeManifest(root, provenance);
  const before = await snapshot(root);
  assert.deepEqual(await verifyPiRuntimeArtifact(root), written);
  assert.deepEqual(await snapshot(root), before);
  assert.deepEqual(await writePiRuntimeManifest(root, provenance), written);
});

test('case-aliased manifest filenames are rejected before the producer writes', async (t) => {
  const root = await fixture(t);
  await put(root, 'Manifest.json', 'existing manifest alias');
  await assert.rejects(writePiRuntimeManifest(root, provenance), /filename must be exactly manifest.json/);
  assert.equal(await readFile(path.join(root, 'Manifest.json'), 'utf8'), 'existing manifest alias');
  await assert.rejects(verifyPiRuntimeArtifact(root), /filename must be exactly manifest.json/);
});

test('package bytes, ordinary dependency bytes, additional files and removed files are bound', async (t) => {
  for (const [file, action, error] of [
    [`${PI_RUNTIME_SDK_RELATIVE_PATH}/dist/index.js`, 'edit', /package hash mismatch/],
    ['node_modules/typebox/index.js', 'edit', /payload hash mismatch/],
    ['node_modules/ordinary/new.txt', 'edit', /payload hash mismatch/],
    ['node_modules/ordinary/a.txt', 'remove', /payload hash mismatch/],
    ['node_modules/ordinary/a.txt', 'rename', /payload hash mismatch/],
  ]) {
    const root = await fixture(t);
    await writePiRuntimeManifest(root, provenance);
    if (action === 'remove') await rm(path.join(root, file));
    else if (action === 'rename') await rename(path.join(root, file), path.join(root, `${file}.renamed`));
    else await put(root, file, 'tampered');
    await assert.rejects(verifyPiRuntimeArtifact(root), error);
  }
});

test('missing SDK entry, CLI, RPC, assets and each Pi license fail even at production time', async (t) => {
  for (const file of [
    `${PI_RUNTIME_SDK_RELATIVE_PATH}/dist/index.js`,
    ...sdkAssets.map((file) => `${PI_RUNTIME_SDK_RELATIVE_PATH}/${file}`),
    ...PI_RUNTIME_PACKAGES.map((name) => `node_modules/${name}/LICENSE`),
  ]) {
    const root = await fixture(t);
    await writePiRuntimeManifest(root, provenance);
    await rm(path.join(root, file));
    await assert.rejects(verifyPiRuntimeArtifact(root), /missing required file/);
    await assert.rejects(writePiRuntimeManifest(root, provenance), /missing required file/);
  }
});

test('all target fields are checked, with explicit cross-target verification supported', async (t) => {
  const root = await fixture(t);
  await writePiRuntimeManifest(root, provenance);
  for (const field of ['platform', 'arch', 'nodeAbi']) {
    const other = { ...target, [field]: field === 'nodeAbi' ? '99999' : 'other' };
    await assert.rejects(verifyPiRuntimeArtifact(root, { target: other }), new RegExp(`target.${field} mismatch`));
  }
  const cross = { platform: 'linux', arch: 'arm64', nodeAbi: '99999' };
  await writePiRuntimeManifest(root, { ...provenance, target: cross });
  await verifyPiRuntimeArtifact(root, { target: cross });
});

test('schema, provenance, manifest package identities and hashes are validated', async (t) => {
  const root = await fixture(t);
  for (const [change, expected] of [
    [(m) => { m.schemaVersion = 2; }, /schemaVersion/],
    [(m) => { m.upstreamVersion = '0.80.5'; }, /upstreamVersion/],
    [(m) => { m.upstreamCommit = '0'.repeat(40); }, /upstreamCommit/],
    [(m) => { m.sourceTreeSha256 = 'not-hash'; }, /sourceTreeSha256/],
    [(m) => { m.lockSha256 = null; }, /lockSha256/],
    [(m) => { m.target.nodeAbi = 137; }, /target.nodeAbi/],
    [(m) => { delete m.packages[PI_RUNTIME_PACKAGES[0]]; }, /exactly the four/],
    [(m) => { m.packages[PI_RUNTIME_PACKAGES[0]].version = '0.1.0'; }, /manifest version/],
    [(m) => { m.packages[PI_RUNTIME_PACKAGES[0]].treeSha256 = 'c'.repeat(64); }, /package hash mismatch/],
    [(m) => { m.payloadSha256 = 'c'.repeat(64); }, /payload hash mismatch/],
  ]) {
    await writePiRuntimeManifest(root, provenance);
    await changeManifest(root, change);
    await assert.rejects(verifyPiRuntimeArtifact(root), expected);
  }
  await assert.rejects(writePiRuntimeManifest(root, { ...provenance, sourceTreeSha256: 'bad' }), /sourceTreeSha256/);
  await writeFile(path.join(root, 'manifest.json'), '{');
  await assert.rejects(verifyPiRuntimeArtifact(root), /cannot read manifest.json/);
  await rm(path.join(root, 'manifest.json'));
  await assert.rejects(verifyPiRuntimeArtifact(root), /cannot read manifest.json/);
});

test('root package identity and version are validated without imposing CommonJS exports', async (t) => {
  for (const changes of [{ name: 'wrong-name' }, { version: '0.80.5' }]) {
    const root = await fixture(t);
    const relative = `${PI_RUNTIME_SDK_RELATIVE_PATH}/package.json`;
    const pkg = JSON.parse(await readFile(path.join(root, relative), 'utf8'));
    await put(root, relative, JSON.stringify({ ...pkg, ...changes }));
    await assert.rejects(writePiRuntimeManifest(root, provenance), /root package identity mismatch|package version/);
  }
});

test('nested Pi copies, aliased identities and unsupported Pi packages are rejected', async (t) => {
  for (const [relative, name] of [
    [`node_modules/ordinary/node_modules/${PI_RUNTIME_PACKAGES[1]}`, PI_RUNTIME_PACKAGES[1]],
    ['node_modules/alias', PI_RUNTIME_PACKAGES[0]],
    ['node_modules/@earendil-works/pi-orchestrator', '@earendil-works/pi-orchestrator'],
  ]) {
    const root = await fixture(t);
    await writePiRuntimeManifest(root, provenance);
    await put(root, `${relative}/package.json`, JSON.stringify({ name, version: '0.80.6' }));
    await assert.rejects(verifyPiRuntimeArtifact(root), /nested, duplicate or unsupported Pi package/);
    await assert.rejects(writePiRuntimeManifest(root, provenance), /nested, duplicate or unsupported Pi package/);
  }
});

test('ordinary nested dependencies are allowed and included in their owning package hash', async (t) => {
  const root = await fixture(t);
  const relative = `${PI_RUNTIME_SDK_RELATIVE_PATH}/node_modules/ordinary/package.json`;
  await put(root, relative, JSON.stringify({ name: 'ordinary', version: '1.0.0' }));
  await writePiRuntimeManifest(root, provenance);
  await verifyPiRuntimeArtifact(root);
  await put(root, relative, JSON.stringify({ name: 'ordinary', version: '2.0.0' }));
  await assert.rejects(verifyPiRuntimeArtifact(root), /package hash mismatch/);
});

test('symlinked payload directories and artifact roots are rejected without following them', async (t) => {
  const root = await fixture(t);
  await writePiRuntimeManifest(root, provenance);
  const outside = path.join(path.dirname(root), 'outside');
  await mkdir(outside);
  const link = path.join(root, 'node_modules', 'linked');
  await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verifyPiRuntimeArtifact(root), /symlink forbidden/);
  await assert.rejects(writePiRuntimeManifest(root, provenance), /symlink forbidden/);
  await rm(link);
  const rootLink = path.join(path.dirname(root), 'root-link');
  await symlink(root, rootLink, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verifyPiRuntimeArtifact(rootLink), /artifact root must be a real directory/);
});
