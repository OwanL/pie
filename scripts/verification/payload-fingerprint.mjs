import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

// Fixture-only v2 digest: sorted path/observed-byte-count/content-SHA256 records.
// No SDK exclusions, provenance shortcuts or cache: every actual payload byte is read.
export async function payloadFingerprint(root, io = fs) {
  const queue = ['out', 'package.json', 'runtime'];
  const records = [];
  let cursor = 0;
  let active = 0;
  let failure;
  async function visit(relative) {
    const absolute = path.join(root, relative);
    const info = await io.lstat(absolute);
    assert.ok(!info.isSymbolicLink(), `immutable payload must not contain links: ${relative}`);
    if (info.isDirectory()) {
      const names = await io.readdir(absolute);
      if (!failure) for (const name of names) {
        if (relative !== 'runtime' || name.endsWith('.cjs')) queue.push(path.join(relative, name));
      }
      return;
    }
    assert.ok(info.isFile() && relative !== 'runtime', `unexpected payload type: ${relative}`);
    if (failure) return;
    const file = await io.open(absolute, 'r');
    try {
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let size = 0;
      for (;;) {
        const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        hash.update(buffer.subarray(0, bytesRead));
        size += bytesRead;
      }
      assert.equal(size, info.size, `payload size changed during snapshot: ${relative}`);
      records.push([relative.replaceAll('\\', '/'), size, hash.digest('hex')]);
    } finally {
      await file.close();
    }
  }
  // One rolling queue: metadata and complete file reads share eight slots.
  // Stop admission on failure, but drain every admitted job before rejecting.
  await new Promise((resolve, reject) => {
    function pump() {
      while (!failure && active < 8 && cursor < queue.length) {
        const relative = queue[cursor++];
        active += 1;
        visit(relative).catch(error => { failure ??= error; }).finally(() => {
          active -= 1;
          pump();
        });
      }
      if (active === 0 && (failure || cursor === queue.length)) {
        if (failure) reject(failure);
        else resolve();
      }
    }
    pump();
  });
  records.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const hash = createHash('sha256').update('payload-fingerprint-v2\0');
  for (const [relative, size, content] of records) hash.update(`${relative}\0${size}\0${content}\0`);
  return { sha256: hash.digest('hex'), files: records.length };
}
