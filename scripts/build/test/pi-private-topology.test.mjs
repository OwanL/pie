import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { materializePrivateWorkspace, assertPrivateWorkspaceTree } from '../pi-isolated-workspace.mjs';

const dirLink = (target, file) => fs.symlink(target, file, process.platform === 'win32' ? 'junction' : 'dir');
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pie-topology-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  return { root, source, destination: path.join(root, 'destination') };
}

test('physical diamond graph copies bounded bytes and preserves aliases and resolvable cycles', { timeout: 5000 }, async t => {
  const { root, source, destination } = await fixture(t);
  const bytes = Buffer.alloc(4096, 42);
  await fs.writeFile(path.join(root, 'installer-file'), bytes);
  for (let i = 0; i < 14; i++) {
    const directory = path.join(source, `level${i}`);
    await fs.mkdir(directory);
    await fs.link(path.join(root, 'installer-file'), path.join(directory, 'payload'));
    if (i) for (const alias of ['left', 'right']) await dirLink(path.join(source, `level${i - 1}`), path.join(directory, alias));
  }
  await dirLink(source, path.join(source, 'level0', 'cycle'));
  const started = performance.now();
  assert.deepEqual(await materializePrivateWorkspace(source, destination), { files: 14, directories: 15, links: 27, bytes: 14 * bytes.length });
  t.diagnostic(`physical graph copy/validation: ${Math.round(performance.now() - started)}ms`);
  assert.equal(await fs.realpath(path.join(destination, 'level13/left')), path.join(destination, 'level12'));
  assert.equal(await fs.realpath(path.join(destination, 'level13/right')), path.join(destination, 'level12'));
  assert.equal(await fs.realpath(path.join(destination, 'level0/cycle')), destination);
  for (let i = 0; i < 14; i++) assert.equal((await fs.lstat(path.join(destination, `level${i}/payload`))).nlink, 1);
  await fs.writeFile(path.join(root, 'installer-file'), 'changed');
  assert.deepEqual(await fs.readFile(path.join(destination, 'level0/payload')), bytes);
  await fs.rm(source, { recursive: true });
  await assertPrivateWorkspaceTree(destination);
});

for (const kind of ['store', 'dangling', 'loop']) test(`rejects ${kind} links`, { timeout: 5000 }, async t => {
  const { root, source, destination } = await fixture(t);
  if (kind === 'store') {
    await fs.mkdir(path.join(root, 'store'));
    await dirLink(path.join(root, 'store'), path.join(source, 'alias'));
  } else if (kind === 'dangling') {
    await dirLink(path.join(source, 'absent'), path.join(source, 'alias'));
  } else {
    // Junctions can represent an unresolvable link-only loop without elevation.
    await dirLink(path.join(source, 'b'), path.join(source, 'alias'));
    await dirLink(path.join(source, 'alias'), path.join(source, 'b'));
  }
  await assert.rejects(materializePrivateWorkspace(source, destination));
});

test('private validator rejects outward links and shared ordinary files', async t => {
  const { root, source } = await fixture(t);
  await fs.writeFile(path.join(root, 'file'), 'bytes');
  await fs.link(path.join(root, 'file'), path.join(source, 'shared'));
  await assert.rejects(assertPrivateWorkspaceTree(source), /Shared private/);
  await fs.unlink(path.join(source, 'shared'));
  await dirLink(root, path.join(source, 'outward'));
  await assert.rejects(assertPrivateWorkspaceTree(source), /escapes private/);
});
