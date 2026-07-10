/**
 * temp-log-reaper — verifies orphaned pi tool-output temp logs are reaped by
 * age and by total-size cap, while non-pi files and under-limit files survive.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { reapTempLogs } from '../src/host/util/temp-log-reaper';

const NOW = Date.parse('2026-07-10T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pie-reaper-test-'));
}

async function touch(path: string, ageDays: number, sizeBytes = 100): Promise<void> {
  await writeFile(path, Buffer.alloc(sizeBytes, 0x61));
  await utimes(path, new Date(NOW - ageDays * DAY), new Date(NOW - ageDays * DAY));
}

test('deletes pi-bash/pi-output logs older than maxAgeDays', async () => {
  const dir = await makeDir();
  await touch(join(dir, 'pi-bash-old.log'), 10); // older than 7d -> delete
  await touch(join(dir, 'pi-output-old.log'), 8); // older than 7d -> delete
  await touch(join(dir, 'pi-bash-fresh.log'), 1); // keep
  await touch(join(dir, 'not-a-pi-log.log'), 30); // keep (wrong prefix)
  await touch(join(dir, 'pi-bash-noext'), 30); // keep (no .log suffix)

  const r = await reapTempLogs({ maxAgeDays: 7, maxTotalSizeMb: 500, tmpDir: dir, now: () => NOW });
  assert.equal(r.scanned, 3); // pi-bash-old, pi-output-old, pi-bash-fresh
  assert.equal(r.deleted, 2);
  const remaining = (await readdir(dir)).sort();
  assert.deepEqual(remaining, ['not-a-pi-log.log', 'pi-bash-fresh.log', 'pi-bash-noext']);
});

test('evicts oldest survivors when total size exceeds the cap', async () => {
  const dir = await makeDir();
  // All fresh (age < 7d) so the age cutoff does nothing; the size cap drives
  // eviction. 1 MB each, cap = 2 MB -> the two oldest of four are evicted.
  const MB = 1024 * 1024;
  await touch(join(dir, 'pi-bash-a.log'), 5, MB); // oldest -> evict
  await touch(join(dir, 'pi-bash-b.log'), 4, MB); // 2nd oldest -> evict
  await touch(join(dir, 'pi-bash-c.log'), 3, MB); // keep
  await touch(join(dir, 'pi-bash-d.log'), 2, MB); // keep (newest)

  const r = await reapTempLogs({ maxAgeDays: 7, maxTotalSizeMb: 2, tmpDir: dir, now: () => NOW });
  assert.equal(r.scanned, 4);
  assert.equal(r.deleted, 2);
  const remaining = (await readdir(dir)).sort();
  assert.deepEqual(remaining, ['pi-bash-c.log', 'pi-bash-d.log']);
  assert.ok(r.freedBytes >= 2 * MB);
});

test('reports zeros and does not throw when tmpdir is missing', async () => {
  const r = await reapTempLogs({
    tmpDir: join(tmpdir(), 'definitely-nonexistent-xyz-123'),
    now: () => NOW,
  });
  assert.equal(r.scanned, 0);
  assert.equal(r.deleted, 0);
  assert.equal(r.freedBytes, 0);
});

test('maxAgeDays: 0 and maxTotalSizeMb: 0 disable deletion (keep everything)', async () => {
  const dir = await makeDir();
  await touch(join(dir, 'pi-bash-old.log'), 30); // would normally be aged out
  await touch(join(dir, 'pi-output-huge.log'), 20, 5 * 1024 * 1024); // would exceed a 0 cap
  await touch(join(dir, 'pi-bash-fresh.log'), 1);

  const r = await reapTempLogs({ maxAgeDays: 0, maxTotalSizeMb: 0, tmpDir: dir, now: () => NOW });
  assert.equal(r.scanned, 3);
  assert.equal(r.deleted, 0);
  assert.equal(r.freedBytes, 0);
  const remaining = (await readdir(dir)).sort();
  assert.deepEqual(remaining, ['pi-bash-fresh.log', 'pi-bash-old.log', 'pi-output-huge.log']);
});