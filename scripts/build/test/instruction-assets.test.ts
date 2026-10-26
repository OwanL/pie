import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createInstructionAssetsPlugin, readInstructionAssets } from '../instruction-assets';

type Entry = { source: string; destination: string };
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-instruction-assets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entries: Entry[] = [
    { source: 'defaults/APPEND_SYSTEM.md', destination: 'APPEND_SYSTEM.md' },
    { source: 'skills/example/SKILL.md', destination: 'skills/example/SKILL.md' },
    { source: 'skills/example/helper.py', destination: 'skills/example/helper.py' },
  ];
  for (const [index, entry] of entries.entries()) {
    fs.mkdirSync(path.dirname(path.join(root, entry.source)), { recursive: true });
    fs.writeFileSync(path.join(root, entry.source), Buffer.from(`selected ${index}\r\nUnicode: Zoë\n`));
  }
  const writeManifest = (files: unknown = entries, version: unknown = 1) =>
    fs.writeFileSync(path.join(root, 'bundled-resources.json'), JSON.stringify({ version, files }));
  writeManifest();
  return { root, entries, writeManifest };
}

function emit(root: string) {
  const plugin = createInstructionAssetsPlugin(root);
  const hook = plugin.generateBundle;
  assert.equal(typeof hook, 'function');
  if (typeof hook !== 'function') throw new Error('missing emission hook');
  const assets: Array<{ fileName: string; source: Uint8Array }> = [];
  hook.call({ emitFile: (asset: { fileName: string; source: Uint8Array }) => assets.push(asset) } as never, {} as never, {} as never, false);
  return assets;
}

test('relocated fixtures emit only exact manifest bytes, leaving input untouched', (t) => {
  const { root, entries } = fixture(t);
  fs.writeFileSync(path.join(root, 'APPEND_SYSTEM.md'), 'personal pending changes');
  fs.writeFileSync(path.join(root, 'settings.json'), 'personal settings');
  fs.writeFileSync(path.join(root, 'skills/example/extra.txt'), 'untracked');
  fs.mkdirSync(path.join(root, 'skills/example/__pycache__'));
  fs.writeFileSync(path.join(root, 'skills/example/__pycache__/helper.pyc'), 'cache');
  const before = entries.map((entry) => fs.readFileSync(path.join(root, entry.source)));
  const assets = emit(root);
  assert.deepEqual(assets.map((asset) => asset.fileName), entries.map((entry) => `resources/agent-instructions/${entry.destination}`));
  assets.forEach((asset, index) => assert.deepEqual(asset.source, before[index]));
  entries.forEach((entry, index) => assert.deepEqual(fs.readFileSync(path.join(root, entry.source)), before[index]));
  const relocated = path.join(root, 'relocated');
  fs.mkdirSync(relocated);
  fs.cpSync(path.join(root, 'defaults'), path.join(relocated, 'defaults'), { recursive: true });
  fs.cpSync(path.join(root, 'skills'), path.join(relocated, 'skills'), { recursive: true });
  fs.copyFileSync(path.join(root, 'bundled-resources.json'), path.join(relocated, 'bundled-resources.json'));
  assert.deepEqual(emit(relocated), assets);
});

test('invalid manifests, paths and destination collisions fail before emission', (t) => {
  const { root, entries, writeManifest } = fixture(t);
  for (const version of [0, 2, '1', null]) {
    writeManifest(entries, version);
    assert.throws(() => emit(root), /version 1/);
  }
  for (const files of [null, [], [{}], [{ source: 'defaults/APPEND_SYSTEM.md' }]]) {
    writeManifest(files);
    assert.throws(() => emit(root));
  }
  for (const invalid of ['../escape', '/absolute', 'C:/absolute', 'skills\\bad', 'a//b', './file', 'a/../file', '.. /escape', 'name.', 'name ', 'NUL.md', 'bad?name', 'bad\u0000name']) {
    for (const field of ['source', 'destination'] as const) {
      writeManifest([{ ...entries[0], [field]: invalid }]);
      assert.throws(() => emit(root), /Invalid instruction asset path/);
    }
  }
  for (const destination of ['APPEND_SYSTEM.md', 'append_system.md', 'APPEND_SYSTEM.md/child']) {
    writeManifest([...entries, { source: entries[0].source, destination }]);
    assert.throws(() => emit(root), /Duplicate or conflicting/);
  }
});

test('missing/non-regular assets and omitted existing skills fail closed', (t) => {
  const { root, entries, writeManifest } = fixture(t);
  writeManifest([...entries, { source: 'missing.md', destination: 'missing.md' }]);
  assert.throws(() => emit(root), /ENOENT/);
  writeManifest([...entries, { source: 'defaults', destination: 'directory' }]);
  assert.throws(() => emit(root), /regular file/);
  writeManifest(entries.filter((entry) => !entry.source.endsWith('SKILL.md')));
  assert.throws(() => emit(root), /omits existing skill/);
  writeManifest(entries.map((entry) => entry.source.endsWith('SKILL.md') ? { ...entry, destination: 'renamed.md' } : entry));
  assert.throws(() => emit(root), /omits existing skill/);
});

test('selected linked files or intermediate directories cannot escape the resource root', (t) => {
  const { root, entries, writeManifest } = fixture(t);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.md'), 'not shipped');
  // Junctions work without Windows symlink privileges and cover intermediate escape.
  fs.symlinkSync(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  writeManifest([...entries, { source: 'linked/secret.md', destination: 'secret.md' }]);
  assert.throws(() => readInstructionAssets(root), /without links/);
  assert.throws(() => readInstructionAssets(path.join(root, 'linked')), /root must be a directory without links/);
});

test('reviewed repository manifest emits all 26 selected resources and no personal root append', () => {
  const root = fileURLToPath(new URL('../../../harness/agent-instructions/', import.meta.url));
  const { assets, inputs } = readInstructionAssets(root);
  assert.equal(assets.length, 26);
  assert.equal(inputs.length, 27);
  assert.ok(!inputs.includes(path.join(root, 'APPEND_SYSTEM.md')));
  assert.deepEqual(assets.find((asset) => asset.fileName === 'resources/agent-instructions/APPEND_SYSTEM.md')?.source,
    fs.readFileSync(path.join(root, 'defaults/APPEND_SYSTEM.md')));
  assert.deepEqual(emit(root), assets.map(({ fileName, source }) => ({ type: 'asset', fileName, source })));
});
