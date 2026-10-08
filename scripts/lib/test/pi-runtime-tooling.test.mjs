import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  PI_RUNTIME_PACKAGES, PI_RUNTIME_SDK_RELATIVE_PATH,
  preparePiRuntimeManifest, verifyPiRuntimeArtifact, verifyPiRuntimeToolingArtifact,
} from '../../../lib/pi-runtime/artifact.mjs';

const target = { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules };
const provenance = {
  upstreamVersion: '0.80.6', upstreamCommit: '2b3fda9921b5590f285165287bd442a25817f17b',
  sourceTreeSha256: 'a'.repeat(64), lockSha256: 'b'.repeat(64), target,
};
const assets = [
  'dist/cli.js', 'dist/rpc-entry.js',
  'dist/modes/interactive/theme/dark.json', 'dist/modes/interactive/theme/light.json',
  'dist/modes/interactive/theme/theme-schema.json', 'dist/modes/interactive/assets/clankolas.png',
  'dist/core/export-html/template.html', 'dist/core/export-html/template.css',
  'dist/core/export-html/template.js', 'dist/core/export-html/vendor/marked.min.js',
  'dist/core/export-html/vendor/highlight.min.js',
];
async function put(root, file, text) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text);
}
async function seal(root, source = provenance) {
  const verified = await preparePiRuntimeManifest(root, source);
  await put(root, 'manifest.json', JSON.stringify(verified.manifest));
  return verified;
}
async function fixture(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'pie-tooling-test-'));
  t.after(() => rm(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const runtime = path.join(parent, 'pi-runtime');
  const tooling = path.join(parent, 'pi-tooling');
  for (const root of [runtime, tooling]) {
    for (const name of PI_RUNTIME_PACKAGES) {
      const prefix = `node_modules/${name}`;
      await put(root, `${prefix}/package.json`, JSON.stringify({ name, version: '0.80.6' }));
      await put(root, `${prefix}/dist/index.js`, 'export const fixture = true;');
      await put(root, `${prefix}/LICENSE`, 'MIT License fixture');
    }
    for (const file of assets) await put(root, `${PI_RUNTIME_SDK_RELATIVE_PATH}/${file}`, `fixture:${file}`);
    await put(root, 'node_modules/ordinary/package.json', JSON.stringify({ name: 'ordinary', version: '1.0.0' }));
    await put(root, 'node_modules/ordinary/index.js', 'ordinary fixture');
    await seal(root);
  }
  return { runtime, tooling };
}
const reference = (identity) => ({ schemaVersion: 1, artifactDirectory: '../pi-tooling', identity });
async function link(runtime, tooling, source = provenance) {
  const verified = await seal(tooling, source);
  await put(runtime, 'tooling-reference.json', JSON.stringify(reference(verified.identity)));
  await seal(runtime);
  return verified;
}

test('safe sibling reference independently verifies tooling without expanding the public runtime result', async (t) => {
  const { runtime, tooling } = await fixture(t);
  const legacy = await verifyPiRuntimeArtifact(runtime);
  const expected = await link(runtime, tooling);
  const sdk = await verifyPiRuntimeArtifact(runtime);
  assert.notEqual(sdk.identity, legacy.identity);
  assert.notEqual(sdk.manifest.payloadSha256, legacy.manifest.payloadSha256);
  assert.equal(sdk.manifest.schemaVersion, 1);
  assert.deepEqual(Object.keys(sdk).sort(), ['artifactDir', 'identity', 'manifest', 'sdkPath']);
  assert.deepEqual(await verifyPiRuntimeToolingArtifact(runtime), expected);
});

test('legacy tooling API returns the same fully verified SDK without consulting a sibling', async (t) => {
  const { runtime, tooling } = await fixture(t);
  await rm(tooling, { recursive: true });
  assert.deepEqual(await verifyPiRuntimeToolingArtifact(runtime), await verifyPiRuntimeArtifact(runtime));
});

test('ordinary startup ignores damaged or absent unused tooling; tooling verification fails before use', async (t) => {
  const { runtime, tooling } = await fixture(t);
  await link(runtime, tooling);
  const expected = await verifyPiRuntimeArtifact(runtime);
  await put(tooling, 'node_modules/ordinary/index.js', 'damaged');
  assert.deepEqual(await verifyPiRuntimeArtifact(runtime), expected);
  await assert.rejects(verifyPiRuntimeToolingArtifact(runtime), /payload hash mismatch/);
  await rm(tooling, { recursive: true });
  assert.deepEqual(await verifyPiRuntimeArtifact(runtime), expected);
  await assert.rejects(verifyPiRuntimeToolingArtifact(runtime), /ENOENT/);
});

test('root role metadata has an exact schema, fixed sibling path and lowercase digest', async (t) => {
  const { runtime } = await fixture(t);
  for (const value of [
    null, [], {}, { ...reference('a'.repeat(64)), role: 'runtime' },
    { ...reference('a'.repeat(64)), schemaVersion: 2 },
    ...['pi-tooling', '../other', '../../pi-tooling', '/pi-tooling', '..\\pi-tooling'].map((artifactDirectory) => ({ ...reference('a'.repeat(64)), artifactDirectory })),
    ...['A'.repeat(64), 'a'.repeat(63), 'not-a-hash', 42].map((identity) => reference(identity)),
  ]) {
    await put(runtime, 'tooling-reference.json', JSON.stringify(value));
    await assert.rejects(preparePiRuntimeManifest(runtime, provenance), /tooling reference/);
    await assert.rejects(verifyPiRuntimeArtifact(runtime), /tooling reference/);
    await assert.rejects(verifyPiRuntimeToolingArtifact(runtime), /tooling reference/);
  }
  await put(runtime, 'tooling-reference.json', '{');
  await assert.rejects(verifyPiRuntimeArtifact(runtime), /cannot read tooling-reference.json/);
});

test('reference bytes and all runtime payload remain hash bound', async (t) => {
  const { runtime, tooling } = await fixture(t);
  await link(runtime, tooling);
  await put(runtime, 'tooling-reference.json', JSON.stringify(reference('c'.repeat(64))));
  await assert.rejects(verifyPiRuntimeArtifact(runtime), /payload hash mismatch/);
  await assert.rejects(verifyPiRuntimeToolingArtifact(runtime), /payload hash mismatch/);
  await link(runtime, tooling);
  await put(runtime, `${PI_RUNTIME_SDK_RELATIVE_PATH}/dist/index.js`, 'tampered SDK');
  await assert.rejects(verifyPiRuntimeToolingArtifact(runtime), /package hash mismatch/);
});

test('tooling identity, provenance and every target field must agree', async (t) => {
  const { runtime, tooling } = await fixture(t);
  await link(runtime, tooling);
  await put(runtime, 'tooling-reference.json', JSON.stringify(reference('c'.repeat(64))));
  await seal(runtime);
  await assert.rejects(verifyPiRuntimeToolingArtifact(runtime), /tooling identity mismatch/);
  for (const field of ['sourceTreeSha256', 'lockSha256']) {
    await link(runtime, tooling, { ...provenance, [field]: 'c'.repeat(64) });
    await assert.rejects(verifyPiRuntimeToolingArtifact(runtime), new RegExp(`tooling ${field} mismatch`));
  }
  for (const field of ['platform', 'arch', 'nodeAbi']) {
    const other = { ...target, [field]: field === 'nodeAbi' ? '99999' : 'other' };
    await link(runtime, tooling, { ...provenance, target: other });
    await assert.rejects(verifyPiRuntimeToolingArtifact(runtime), new RegExp(`target.${field} mismatch`));
  }
  const cross = { platform: 'linux', arch: 'arm64', nodeAbi: '99999' };
  await link(runtime, tooling, { ...provenance, target: cross });
  await seal(runtime, { ...provenance, target: cross });
  await verifyPiRuntimeToolingArtifact(runtime, { target: cross });
});

test('tooling retains canonical upstream and required-asset checks', async (t) => {
  const { runtime, tooling } = await fixture(t);
  for (const [field, value] of [['upstreamVersion', '0.80.5'], ['upstreamCommit', '0'.repeat(40)]]) {
    await link(runtime, tooling);
    const file = path.join(tooling, 'manifest.json');
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...manifest, [field]: value }));
    await assert.rejects(verifyPiRuntimeToolingArtifact(runtime), new RegExp(field));
  }
  await link(runtime, tooling);
  await rm(path.join(tooling, PI_RUNTIME_SDK_RELATIVE_PATH, assets[0]));
  await assert.rejects(verifyPiRuntimeToolingArtifact(runtime), /missing required file/);
});

test('fully verified tooling cannot chain another tooling reference', async (t) => {
  const { runtime, tooling } = await fixture(t);
  await put(tooling, 'tooling-reference.json', JSON.stringify(reference('a'.repeat(64))));
  await link(runtime, tooling);
  await verifyPiRuntimeArtifact(runtime);
  await assert.rejects(verifyPiRuntimeToolingArtifact(runtime), /chaining forbidden/);
});

test('reserved metadata is root-only; ordinary nested and unrelated root metadata remain valid v1 payload', async (t) => {
  const { runtime } = await fixture(t);
  await put(runtime, 'node_modules/ordinary/tooling-reference.json', '{not role metadata');
  await put(runtime, 'role.json', '{ordinary payload');
  await seal(runtime);
  await verifyPiRuntimeToolingArtifact(runtime);
  await put(runtime, 'Tooling-reference.json', '{}');
  await assert.rejects(preparePiRuntimeManifest(runtime, provenance), /filename must be exactly tooling-reference.json/);
});

test('tooling reference is captured once from the fresh hash pass, never reread for routing', async (t) => {
  const { runtime, tooling } = await fixture(t);
  const expected = await link(runtime, tooling);
  const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const fsUrl = moduleUrl(`let fs; export function setFs(value) { fs = value; }
    export const lstat = (...args) => fs.lstat(...args);
    export const readdir = (...args) => fs.readdir(...args);
    export const realpath = (...args) => fs.realpath(...args);
    export const readFile = (...args) => fs.readFile(...args);`);
  const injectedFs = await import(fsUrl);
  let reads = 0;
  injectedFs.setFs({ ...fs, async readFile(file, ...args) {
    if (path.basename(file) === 'tooling-reference.json' && ++reads > 1) throw new Error('unverified reread');
    return fs.readFile(file, ...args);
  } });
  const source = await readFile(new URL('../../../lib/pi-runtime/artifact.mjs', import.meta.url), 'utf8');
  const api = await import(moduleUrl(source.replace("'node:fs/promises'", JSON.stringify(fsUrl))));
  assert.deepEqual(await api.verifyPiRuntimeToolingArtifact(runtime), expected);
  assert.equal(reads, 1);
});
