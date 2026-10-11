import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, link, lstat, readFile, rm, realpath, symlink, readdir, copyFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detachIsolatedDeployHardlinks } from '../pi-runtime.mjs';

async function fixture(t) {
  const work = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pie-detach-test-')));
  t.after(() => rm(work, { recursive: true, force: true }));
  const staging = path.join(work, 'deploy-staging');
  await mkdir(staging);
  return { work, staging };
}

test('replaces actual hardlinked staging bytes without modifying the source', async t => {
  const { work, staging } = await fixture(t);
  const source = path.join(work, 'source');
  const target = path.join(staging, 'payload');
  await writeFile(source, 'compiled fixture bytes', { mode: 0o640 });
  await link(source, target);
  const before = await lstat(source);
  assert.equal(before.nlink, 2);
  await detachIsolatedDeployHardlinks(staging, work);
  const after = await lstat(source);
  const detached = await lstat(target);
  assert.equal(after.ino, before.ino);
  assert.equal(after.nlink, 1);
  assert.equal(detached.nlink, 1);
  assert.notEqual(detached.ino, after.ino);
  assert.equal(detached.mode, before.mode);
  assert.deepEqual(await readFile(target), await readFile(source));
  await writeFile(target, 'changed staging');
  assert.equal(await readFile(source, 'utf8'), 'compiled fixture bytes');
  assert.deepEqual(await readdir(staging), ['payload']);
});

test('validates all links before replacement and retains failure evidence', async t => {
  const { work, staging } = await fixture(t);
  const source = path.join(work, 'source');
  await writeFile(source, 'bytes');
  await link(source, path.join(staging, 'payload'));
  const outside = path.join(work, 'outside');
  await mkdir(outside);
  await symlink(outside, path.join(staging, 'bad'), 'junction');
  await assert.rejects(detachIsolatedDeployHardlinks(staging, work), /symlink/);
  assert.equal((await lstat(source)).nlink, 2);
  assert.deepEqual(await readdir(staging), ['bad', 'payload']);
});

for (const operation of ['copyFile', 'rename']) {
  test(`${operation} failure retains exact primary error when cleanup also fails`, async t => {
    const { work, staging } = await fixture(t);
    const source = path.join(work, 'source');
    const target = path.join(staging, 'payload');
    await writeFile(source, 'original bytes');
    await link(source, target);
    const before = await lstat(source);
    const primary = new Error(`${operation} failed`);
    const cleanup = new Error('unlink failed');
    let cleanupCalls = 0;
    await assert.rejects(detachIsolatedDeployHardlinks(staging, work, undefined, {
      [operation]: async (...args) => {
        if (operation === 'copyFile') await copyFile(...args);
        throw primary;
      },
      unlink: async () => { cleanupCalls++; throw cleanup; },
    }), error => error === primary && error.cleanupError === cleanup);
    assert.equal(cleanupCalls, 1);
    assert.equal((await lstat(source)).ino, before.ino);
    assert.equal((await lstat(target)).ino, before.ino);
    assert.equal((await lstat(source)).nlink, 2);
    assert.equal(await readFile(source, 'utf8'), 'original bytes');
    assert.equal(await readFile(target, 'utf8'), 'original bytes');
  });
}

test('frozen primary errors cannot be masked by cleanup diagnostics', async t => {
  const { work, staging } = await fixture(t);
  const source = path.join(work, 'source');
  await writeFile(source, 'original bytes');
  await link(source, path.join(staging, 'payload'));
  const primary = Object.freeze(new Error('frozen primary'));
  const cleanup = new Error('cleanup failure');
  const diagnostics = [];
  const original = console.error;
  console.error = (...args) => diagnostics.push(args);
  try {
    await assert.rejects(detachIsolatedDeployHardlinks(staging, work, undefined, {
      rename: async () => { throw primary; },
      unlink: async () => { throw cleanup; },
    }), error => error === primary);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0][1], cleanup);
    console.error = () => { throw new Error('diagnostics unavailable'); };
    await assert.rejects(detachIsolatedDeployHardlinks(staging, work, undefined, {
      rename: async () => { throw primary; },
      unlink: async () => { throw cleanup; },
    }), error => error === primary);
  } finally {
    console.error = original;
  }
});

test('successful replacement still fails closed on cleanup failure', async t => {
  const { work, staging } = await fixture(t);
  const source = path.join(work, 'source');
  const target = path.join(staging, 'payload');
  await writeFile(source, 'original bytes');
  await link(source, target);
  const before = await lstat(source);
  const cleanup = new Error('cleanup failed');
  await assert.rejects(detachIsolatedDeployHardlinks(staging, work, undefined, {
    unlink: async () => { throw cleanup; },
  }), error => error === cleanup);
  assert.equal((await lstat(source)).ino, before.ino);
  assert.equal((await lstat(source)).nlink, 1);
  assert.equal((await lstat(target)).nlink, 1);
  assert.notEqual((await lstat(target)).ino, before.ino);
  assert.equal(await readFile(source, 'utf8'), 'original bytes');
  assert.equal(await readFile(target, 'utf8'), 'original bytes');
});

test('rejects a staging directory outside its canonical owned parent', async t => {
  const { work, staging } = await fixture(t);
  await assert.rejects(detachIsolatedDeployHardlinks(staging, path.dirname(work)), /invocation-owned/);
});
