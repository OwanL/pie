import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertRuntimeBootstrapSupportsSchema } from '../runtime-publication.mjs';
import runtime from '../../../application/hosts/vscode/runtime/runtime-generations.cjs';

const sourcePkg = JSON.parse(await readFile(new URL('../../../application/hosts/vscode/package.json', import.meta.url), 'utf8'));
async function fixture(t, helper, { legacy = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pie-loader-capability-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // The activation entry must never be required by a capability check.
  const bootstrap = 'throw new Error("activation entry executed");';
  const hash = createHash('sha256');
  for (const [name, bytes] of [['bootstrap.cjs', bootstrap], ['runtime-generations.cjs', helper]]) {
    hash.update(name).update('\0').update(bytes).update('\0');
  }
  const directory = legacy ? 'runtime' : `pie-bootstrap/${hash.digest('hex')}`;
  await mkdir(path.join(root, directory), { recursive: true });
  await writeFile(path.join(root, directory, 'bootstrap.cjs'), bootstrap);
  await writeFile(path.join(root, directory, 'runtime-generations.cjs'), helper);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ ...sourcePkg, pieRuntimeBootstrap: 1, main: `./${directory}/bootstrap.cjs` }));
  return { root, directory };
}
const check = (root, schema) => assertRuntimeBootstrapSupportsSchema({ extensionDir: root, schema });

test('source loader declares immutable schema capabilities', () => {
  assert.deepEqual(runtime.SUPPORTED_MANIFEST_SCHEMAS, [1, 2]);
  assert.ok(Object.isFrozen(runtime.SUPPORTED_MANIFEST_SCHEMAS));
});

test('old immutable loader allows v1 but rejects v2 before publication', async t => {
  const { root } = await fixture(t, 'module.exports = {};');
  assert.equal(await check(root, 1), undefined);
  await assert.rejects(check(root, 2), /schema 2.*--activate/u);
});

test('detached upgraded loader allows v2 without source byte equivalence', async t => {
  const { root } = await fixture(t, 'module.exports = { SUPPORTED_MANIFEST_SCHEMAS: Object.freeze([1, 2]) };');
  assert.equal(await check(root, 2), undefined);
});

test('flat legacy loader is schema 1 only and is not evaluated', async t => {
  const { root } = await fixture(t, 'throw new Error("legacy helper executed");', { legacy: true });
  assert.equal(await check(root, 1), undefined);
  await assert.rejects(check(root, 2), /schema 2.*--activate/u);
});

test('both loader files are hash bound before helper execution', async t => {
  for (const name of ['bootstrap.cjs', 'runtime-generations.cjs']) {
    const { root, directory } = await fixture(t, 'throw new Error("helper executed");');
    await writeFile(path.join(root, directory, name), 'throw new Error("tampered helper executed");');
    await assert.rejects(check(root, 2), /hash mismatch.*--activate/u);
  }
});

test('noncanonical main and mismatched package identity are refused', async t => {
  const { root } = await fixture(t, 'throw new Error("helper executed");');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ ...sourcePkg, pieRuntimeBootstrap: 1, main: './pie-bootstrap/../runtime/bootstrap.cjs' }));
  await assert.rejects(check(root, 2), /not canonical/u);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ ...sourcePkg, name: 'other', pieRuntimeBootstrap: 1, main: './runtime/bootstrap.cjs' }));
  await assert.rejects(check(root, 2), /identity/u);
});

test('source publication upgrades and checks capabilities before selecting a generation', async () => {
  const build = await readFile(new URL('../build.mjs', import.meta.url), 'utf8');
  const block = build.slice(build.indexOf('async function publishToInstalledExtension()'), build.indexOf('function scheduleRendererPublication()'));
  assert.ok(block.indexOf('if (noSync) return') < block.indexOf('installRuntimeBootstrap('));
  assert.ok(block.indexOf('installRuntimeBootstrap(') < block.indexOf('publishRuntimeGeneration('));
  assert.ok(block.indexOf('assertRuntimeBootstrapSupportsSchema(') < block.indexOf('publishRuntimeGeneration('));
  assert.ok(block.indexOf('publishRuntimeGeneration(') < block.indexOf('Startup loader installed.'));
});
