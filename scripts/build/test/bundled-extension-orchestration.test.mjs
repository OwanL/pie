import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { verifyBundledExtensionOutput, verifyToolRuntimeOutput } from '../bundled-extension-verification.mjs';
import { TOOL_RUNTIME_DIRECTORY, TOOL_RUNTIME_FILES, TOOL_RUNTIME_MANIFEST, toolRuntimeManifest } from '../tool-runtime-assets.mjs';

const identity = '0123456789abcdef0123';
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pie-bundled-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'resources'));
  await Promise.all(TOOL_RUNTIME_FILES.map(async file => {
    const asset = path.join(root, TOOL_RUNTIME_DIRECTORY, file);
    await mkdir(path.dirname(asset), { recursive: true });
    await writeFile(asset, 'fixture');
  }));
  await writeFile(path.join(root, TOOL_RUNTIME_MANIFEST), JSON.stringify(toolRuntimeManifest()));
  const inventory = { version: 1, extensions: Array.from({ length: 12 }, (_, i) => ({ id: `extension-${i}`, entry: `extension-${i}.js` })) };
  await writeFile(path.join(root, 'resources/bundled-extensions-build-id.txt'), identity);
  await Promise.all(inventory.extensions.map(item => writeFile(path.join(root, item.entry), 'module.exports = {};')));
  const save = () => writeFile(path.join(root, 'resources/bundled-extensions.json'), JSON.stringify(inventory));
  await save();
  return { root, inventory, save };
}

test('bundled output requires matching identity, complete inventory and every file', async t => {
  const { root, inventory, save } = await fixture(t);
  await verifyBundledExtensionOutput(root, identity);
  await assert.rejects(verifyBundledExtensionOutput(root, 'ffffffffffffffffffff'), /identity mismatch/);
  inventory.extensions[0].entry = '../escape.js';
  await save();
  await assert.rejects(verifyBundledExtensionOutput(root, identity), /inventory entry/);
  inventory.extensions[0].entry = 'extension-0.js';
  inventory.extensions[1] = inventory.extensions[0];
  await save();
  await assert.rejects(verifyBundledExtensionOutput(root, identity), /inventory entry/);
  inventory.extensions.pop();
  await save();
  await assert.rejects(verifyBundledExtensionOutput(root, identity), /count/);
});

test('bundled verifier accepts only the selected composite runtime identity', async t => {
  const { root } = await fixture(t);
  const payloadIdentity = 'a'.repeat(64);
  await writeFile(path.join(root, TOOL_RUNTIME_MANIFEST), JSON.stringify(toolRuntimeManifest({ playwrightRuntimeIdentity: payloadIdentity })));
  await verifyToolRuntimeOutput(root, { playwrightRuntimeIdentity: payloadIdentity });
  await verifyBundledExtensionOutput(root, identity, { playwrightRuntimeIdentity: payloadIdentity });
  await assert.rejects(verifyToolRuntimeOutput(root), /Invalid code-only/);
  await assert.rejects(verifyToolRuntimeOutput(root, { playwrightRuntimeIdentity: 'b'.repeat(64) }), /Invalid prepared/);
});

test('missing bundled output rejects coordination', async t => {
  const { root } = await fixture(t);
  await rm(path.join(root, 'extension-11.js'));
  await assert.rejects(verifyBundledExtensionOutput(root, identity), /ENOENT/);
});

test('dedicated one-shot pass follows both graphs and precedes verification/publication', () => {
  const source = readFileSync(new URL('../build.mjs', import.meta.url), 'utf8');
  const once = source.slice(source.indexOf('async function buildOnce()'), source.indexOf('function pausePublication()'));
  assert.ok(once.indexOf('if (failed) throw failed.reason') < once.indexOf("'bundled-extensions'"));
  assert.ok(once.indexOf("'bundled-extensions'") < once.indexOf('copyPreparedPlaywrightHeadlessPayload'));
  assert.ok(once.indexOf('copyPreparedPlaywrightHeadlessPayload') < once.indexOf('verifyCoordinatedBuildIdentity()'));
  assert.ok(once.indexOf('copyPreparedPlaywrightRuntimePayload') < once.indexOf('verifyCoordinatedBuildIdentity()'));
  assert.ok(once.indexOf('verifyCoordinatedBuildIdentity()') < once.indexOf('publishToInstalledExtension()'));
  const watch = source.slice(source.indexOf('async function watchSelection()'));
  assert.ok(watch.indexOf('await buildOnce()') < watch.indexOf("runViteWatch('bundled-extensions')"));
  assert.match(source, /PIE_BUILD_PI_RUNTIME_IDENTITY: selectedPiRuntime\?\.identity/);
  assert.match(source, /PIE_BUILD_PLAYWRIGHT_PAYLOAD_IDENTITY: selectedPlaywrightRuntime\?\.identity \?\? selectedPlaywrightPayload\?\.identity \?\? ''/);
  assert.match(source, /PIE_BUILD_PLAYWRIGHT_RUNTIME: selectedPlaywrightRuntime \? '1' : ''/);
});
