import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { payloadFingerprint } from '../payload-fingerprint.mjs';

const entries = ['out/z/a', 'out/a/z', 'out/a.bin', 'out/.cache/doc', 'out/sdkTooling/docs/readme', 'package.json', 'runtime/bootstrap.cjs'];
async function fixture(t, reverse = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-payload-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of reverse ? [...entries].reverse() : entries) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), Buffer.alloc(140_000, entries.indexOf(name)));
  }
  return root;
}
test('full-byte v2 digest is deterministic and detects payload changes without exclusions', async t => {
  const root = await fixture(t), other = await fixture(t, true);
  const before = await payloadFingerprint(root);
  assert.deepEqual(await payloadFingerprint(other), before);
  assert.equal(before.files, entries.length);
  assert.equal(before.sha256, createHash('sha256').update('payload-fingerprint-v2\0' + [...entries].sort().map(name => `${name}\0${140_000}\0${createHash('sha256').update(Buffer.alloc(140_000, entries.indexOf(name))).digest('hex')}\0`).join('')).digest('hex'));
  for (const name of entries) {
    const target = path.join(root, name), bytes = await fs.readFile(target);
    await fs.writeFile(target, Buffer.alloc(bytes.length, 99));
    assert.notDeepEqual(await payloadFingerprint(root), before);
    await fs.writeFile(target, bytes);
  }
  const extra = path.join(root, 'out/extra');
  await fs.writeFile(extra, 'extra'); assert.notDeepEqual(await payloadFingerprint(root), before);
  await fs.rm(extra); await fs.rm(path.join(root, 'out/a.bin'));
  assert.notDeepEqual(await payloadFingerprint(root), before);
  await fs.mkdir(path.join(root, 'out/a.bin')); assert.notDeepEqual(await payloadFingerprint(root), before);
  await fs.rm(path.join(root, 'out/a.bin'), { recursive: true });
  await fs.symlink(path.join(root, 'out/z'), path.join(root, 'out/link'), 'junction');
  await assert.rejects(payloadFingerprint(root), /must not contain links/);
});
test('shared queue bounds file buffers and drains started IO on failure', async t => {
  const root = await fixture(t);
  for (let i = 0; i < 24; i++) await fs.writeFile(path.join(root, `out/f${i}`), Buffer.alloc(140_000));
  let active = 0, peak = 0, reads = 0, metadata = 0;
  const io = { ...fs, async lstat(...args) { metadata++; assert.ok(active + metadata <= 8); try { return await fs.lstat(...args); } finally { metadata--; } }, async open(...args) {
    const file = await fs.open(...args); active++; peak = Math.max(peak, active); assert.ok(active + metadata <= 8);
    return { async read(buffer, ...rest) {
      assert.equal(buffer.length, 64 * 1024); reads++;
      await new Promise(resolve => setTimeout(resolve, 1)); return file.read(buffer, ...rest);
    }, async close() { await file.close(); active--; } };
  } };
  await payloadFingerprint(root, io);
  assert.equal(peak, 8); assert.equal(active, 0); assert.ok(reads > 32);
  let jobs = 0, admittedAtFailure;
  await assert.rejects(payloadFingerprint(root, { ...io, async lstat(...args) {
    jobs++;
    if (args[0].endsWith(`${path.sep}f10`)) { admittedAtFailure = jobs; throw new Error('injected IO failure'); }
    return fs.lstat(...args);
  } }), /injected IO failure/);
  assert.equal(active, 0); assert.equal(jobs, admittedAtFailure);
});
