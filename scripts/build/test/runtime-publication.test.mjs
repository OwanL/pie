import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertRuntimeBootstrapSupportsSchema, installRuntimeBootstrap } from '../runtime-publication.mjs';
import runtime from '../../../application/hosts/vscode/runtime/runtime-generations.cjs';

const sourcePkg = JSON.parse(await readFile(new URL('../../../application/hosts/vscode/package.json', import.meta.url), 'utf8'));
const v2Capabilities = "const RUNTIME_DIRECTORY = 'pie-runtime-v2';\nconst RUNTIME_LOCK_PROTOCOL = 'pie-windows-runtime-lock-v1';\n";
async function fixture(t, helper, { legacy = false, twoFiles = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pie-loader-capability-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // The activation entry must never be required by a capability check.
  const bootstrap = 'throw new Error("activation entry executed");';
  const hash = createHash('sha256');
  for (const [name, bytes] of [['bootstrap.cjs', bootstrap], ['runtime-generations.cjs', helper], ['windows-runtime-lock.cjs', '// lock fixture']]) {
    if (!twoFiles || name !== 'windows-runtime-lock.cjs') hash.update(name).update('\0').update(bytes).update('\0');
  }
  const directory = legacy ? 'runtime' : `pie-bootstrap/${hash.digest('hex')}`;
  await mkdir(path.join(root, directory), { recursive: true });
  await writeFile(path.join(root, directory, 'bootstrap.cjs'), bootstrap);
  await writeFile(path.join(root, directory, 'runtime-generations.cjs'), helper);
  if (!twoFiles) await writeFile(path.join(root, directory, 'windows-runtime-lock.cjs'), '// lock fixture');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ ...sourcePkg, pieRuntimeBootstrap: 1, main: `./${directory}/bootstrap.cjs` }));
  return { root, directory };
}
const check = (root, schema) => assertRuntimeBootstrapSupportsSchema({ extensionDir: root, schema });

async function stageRuntime(t, root) {
  const out = await mkdtemp(path.join(os.tmpdir(), 'pie-loader-output-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  await mkdir(path.join(out, 'webview/panel/.vite'), { recursive: true });
  for (const file of ['extension.js', 'backend.js', 'worker-entry.js', 'webview/panel/entry.js']) {
    await writeFile(path.join(out, file), '// fixture');
  }
  for (const file of ['pie-build-id.txt', 'webview/panel/pie-build-id.txt']) {
    await writeFile(path.join(out, file), 'fixture-build');
  }
  await writeFile(path.join(out, 'webview/panel/.vite/manifest.json'), JSON.stringify({ entry: { file: 'entry.js', isEntry: true } }));
  return runtime.publishRuntimeGeneration({ sourceOutDir: out, extensionDir: root, identity: sourcePkg });
}

test('concurrent same-process loader installs own their staging paths', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pie-loader-concurrent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify(sourcePkg));
  await stageRuntime(t, root);
  const generations = await Promise.all(Array.from({ length: 16 }, () =>
    installRuntimeBootstrap({ extensionDir: root, pkg: sourcePkg })));
  assert.equal(new Set(generations).size, 1);
  await check(root, 2);
  assert.deepEqual(await readdir(path.join(root, 'pie-bootstrap')), [generations[0]]);
  assert.deepEqual((await readdir(root)).sort(), ['package.json', 'pie-bootstrap', 'pie-runtime-v2']);
});

test('partial manifest staging writes remove only the exclusively owned file', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pie-loader-partial-write-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify(sourcePkg));
  await stageRuntime(t, root);
  const untouchedPath = path.join(root, '.untouched');
  await writeFile(untouchedPath, 'keep me');

  const probePath = path.join(root, '.handle-probe');
  const probe = await open(probePath, 'w');
  const handlePrototype = Object.getPrototypeOf(probe);
  await probe.close();
  await rm(probePath);
  const originalWriteFile = handlePrototype.writeFile;
  handlePrototype.writeFile = async function (data, ...args) {
    await originalWriteFile.call(this, String(data).slice(0, 8), ...args);
    throw new Error('injected partial manifest write failure');
  };
  try {
    await assert.rejects(
      installRuntimeBootstrap({ extensionDir: root, pkg: sourcePkg }),
      /injected partial manifest write failure/u,
    );
  } finally {
    handlePrototype.writeFile = originalWriteFile;
  }

  assert.equal(await readFile(untouchedPath, 'utf8'), 'keep me');
  assert.equal(await readFile(path.join(root, 'package.json'), 'utf8'), JSON.stringify(sourcePkg));
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith('.package-')), []);
});

test('activation preserves prior loader and store when staging fails, then coexists', async t => {
  const { root, directory } = await fixture(t, 'throw new Error("legacy never executed");', { twoFiles: true });
  const prior = await readFile(path.join(root, 'package.json'), 'utf8');
  const helper = await readFile(path.join(root, directory, 'runtime-generations.cjs'), 'utf8');
  await mkdir(path.join(root, 'pie-runtime'));
  await writeFile(path.join(root, 'pie-runtime', 'sentinel'), 'old selection');
  await assert.rejects(installRuntimeBootstrap({ extensionDir: root, pkg: sourcePkg, beforeSwitch: async () => {
    assert.equal(await readFile(path.join(root, 'package.json'), 'utf8'), prior);
    throw new Error('mock verification failure');
  } }), /mock verification failure/u);
  assert.equal(await readFile(path.join(root, 'package.json'), 'utf8'), prior);
  await installRuntimeBootstrap({ extensionDir: root, pkg: sourcePkg, beforeSwitch: async () => {
    assert.equal(await readFile(path.join(root, 'package.json'), 'utf8'), prior);
    await stageRuntime(t, root);
  } });
  await check(root, 2);
  assert.equal(await readFile(path.join(root, directory, 'runtime-generations.cjs'), 'utf8'), helper);
  assert.equal(await readFile(path.join(root, 'pie-runtime', 'sentinel'), 'utf8'), 'old selection');
  assert.ok((await runtime.resolveRuntimeGeneration({ extensionDir: root, identity: sourcePkg })).generation);
});

test('missing or invalid target cannot switch manifest, even with a no-op or forged hook result', async t => {
  for (const invalid of [false, true]) {
    const { root } = await fixture(t, 'module.exports = {};', { legacy: true });
    const prior = await readFile(path.join(root, 'package.json'), 'utf8');
    if (invalid) {
      const selected = await stageRuntime(t, root);
      await writeFile(path.join(selected.outDir, 'extension.js'), 'corrupted');
    }
    for (const beforeSwitch of [undefined, async () => {}, async () => ({ generation: 'a'.repeat(64) })]) {
      await assert.rejects(installRuntimeBootstrap({ extensionDir: root, pkg: sourcePkg, beforeSwitch }), /without a valid selected v2/u);
      assert.equal(await readFile(path.join(root, 'package.json'), 'utf8'), prior);
    }
  }
});

test('source loader declares immutable schema capabilities', () => {
  assert.deepEqual(runtime.SUPPORTED_MANIFEST_SCHEMAS, [1, 2]);
  assert.ok(Object.isFrozen(runtime.SUPPORTED_MANIFEST_SCHEMAS));
});

test('two-file immutable legacy identity validates but cannot publish into v2 store', async t => {
  const { root } = await fixture(t, 'module.exports = {};', { twoFiles: true });
  await assert.rejects(check(root, 1), /unsupported or ambiguous.*--activate/u);
  await assert.rejects(check(root, 2), /unsupported or ambiguous.*--activate/u);
});

test('detached upgraded loader allows v2 without source byte equivalence', async t => {
  const { root } = await fixture(t, v2Capabilities + 'module.exports = { RUNTIME_DIRECTORY, RUNTIME_LOCK_PROTOCOL, SUPPORTED_MANIFEST_SCHEMAS: Object.freeze([1, 2]) }; throw new Error("never execute");');
  assert.equal(await check(root, 2), undefined);
});

test('hashed misleading comments and strings cannot spoof actual capabilities', async t => {
  const spoof = `/*\n${v2Capabilities}SUPPORTED_MANIFEST_SCHEMAS: Object.freeze([1, 2])\n*/\n`
    + `const misleading = ${JSON.stringify(v2Capabilities)};\n`;
  const { root } = await fixture(t, spoof
    + "const RUNTIME_DIRECTORY = 'wrong';\nconst RUNTIME_LOCK_PROTOCOL = 'wrong';\n"
    + 'module.exports = { RUNTIME_DIRECTORY, RUNTIME_LOCK_PROTOCOL, SUPPORTED_MANIFEST_SCHEMAS: Object.freeze([1, 2]) };');
  await assert.rejects(check(root, 2), /directory or lock protocol.*--activate/u);
});

test('ambiguous and unsupported capability exports fail closed', async t => {
  const exports = 'module.exports = { RUNTIME_DIRECTORY, RUNTIME_LOCK_PROTOCOL, SUPPORTED_MANIFEST_SCHEMAS: Object.freeze([1, 2]) };';
  for (const helper of [
    v2Capabilities + exports + exports,
    v2Capabilities + exports + "module.exports.RUNTIME_DIRECTORY = 'wrong';",
    v2Capabilities + exports.replace('RUNTIME_DIRECTORY,', ''),
    v2Capabilities + exports.replace('[1, 2]', '[1, 2, 2]'),
    v2Capabilities + exports.replace('RUNTIME_DIRECTORY,', 'RUNTIME_DIRECTORY, RUNTIME_DIRECTORY,'),
    v2Capabilities + exports.replace('Object.freeze([1, 2])', 'getSchemas()'),
    v2Capabilities + exports + "RUNTIME_DIRECTORY = 'wrong';",
  ]) {
    const { root } = await fixture(t, helper);
    await assert.rejects(check(root, 2), /unsupported or ambiguous.*--activate/u);
  }
});

test('flat legacy loader cannot publish into v2 store and is not evaluated', async t => {
  const { root } = await fixture(t, 'throw new Error("legacy helper executed");', { legacy: true });
  await assert.rejects(check(root, 1), /directory or lock protocol/u);
  await assert.rejects(check(root, 2), /schema 2.*--activate/u);
});

test('all loader files are hash bound before helper execution', async t => {
  for (const name of ['bootstrap.cjs', 'runtime-generations.cjs', 'windows-runtime-lock.cjs']) {
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
  assert.ok(block.includes('beforeSwitch: publish'));
  assert.ok(block.indexOf('assertRuntimeBootstrapSupportsSchema(') < block.indexOf('publishRuntimeGeneration('));
  assert.ok(block.indexOf('publishRuntimeGeneration(') < block.indexOf('Startup loader installed.'));
});
