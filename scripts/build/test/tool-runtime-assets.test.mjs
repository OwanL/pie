import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createToolRuntimeAssetsPlugin, readToolRuntimeAssets, TOOL_RUNTIME_FILES, TOOL_RUNTIME_DIRECTORY, TOOL_RUNTIME_MANIFEST, toolRuntimeManifest } from '../tool-runtime-assets.mjs';
import { verifyToolRuntimeOutput } from '../bundled-extension-verification.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-tool-assets-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  return temp;
}
function copySources(target) {
  for (const file of TOOL_RUNTIME_FILES) {
    fs.mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(target, file));
  }
}

test('raw code-only closure emits byte-identically and verifies after relocation', async t => {
  const temp = fixture(t);
  const output = path.join(temp, 'output');
  const watched = [];
  const plugin = createToolRuntimeAssetsPlugin(root);
  plugin.buildStart.call({ addWatchFile: file => watched.push(file) });
  for (const file of TOOL_RUNTIME_FILES) assert.ok(watched.includes(path.join(root, file)));
  plugin.generateBundle.call({ emitFile({ fileName, source }) {
    const target = path.join(output, fileName);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  } });
  const relocated = path.join(temp, 'relocated');
  fs.renameSync(output, relocated);
  await verifyToolRuntimeOutput(relocated);
  for (const file of TOOL_RUNTIME_FILES) assert.deepEqual(fs.readFileSync(path.join(relocated, TOOL_RUNTIME_DIRECTORY, file)), fs.readFileSync(path.join(root, file)));
  fs.unlinkSync(path.join(relocated, TOOL_RUNTIME_DIRECTORY, TOOL_RUNTIME_FILES[0]));
  await assert.rejects(verifyToolRuntimeOutput(relocated), /ENOENT/);
});

test('curated source closure includes literal dynamic imports and rejects missing/escaping imports', t => {
  const temp = fixture(t);
  copySources(temp);
  assert.equal(readToolRuntimeAssets(temp).length, TOOL_RUNTIME_FILES.length);
  const entry = path.join(temp, TOOL_RUNTIME_FILES[0]);
  fs.appendFileSync(entry, '\nimport("./uncurated.mjs");');
  assert.throws(() => readToolRuntimeAssets(temp), /outside curated closure/);
  fs.copyFileSync(path.join(root, TOOL_RUNTIME_FILES[0]), entry);
  fs.unlinkSync(entry);
  assert.throws(() => readToolRuntimeAssets(temp), /ENOENT/);
});

test('verifier rejects marker traversal, extras and missing marker', async t => {
  const temp = fixture(t);
  await assert.rejects(verifyToolRuntimeOutput(temp), /ENOENT/);
  fs.mkdirSync(path.dirname(path.join(temp, TOOL_RUNTIME_MANIFEST)), { recursive: true });
  for (const files of [['../../escape.mjs'], [...TOOL_RUNTIME_FILES, 'node_modules/native.node']]) {
    fs.writeFileSync(path.join(temp, TOOL_RUNTIME_MANIFEST), JSON.stringify({ ...toolRuntimeManifest(), files }));
    await assert.rejects(verifyToolRuntimeOutput(temp), /Invalid code-only/);
  }
});
