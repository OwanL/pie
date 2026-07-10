import assert from 'node:assert/strict';
import test, { describe, beforeEach, afterEach } from 'node:test';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const reaperUrl = pathToFileURL(path.resolve(__dirname, '../reaper.ts')).href;

type ReapResult = { scanned: number; deleted: number; freedBytes: number };
type ReaperModule = {
  reapPrunedRawStashes: (options?: {
    maxAgeDays?: number;
    maxTotalSizeMb?: number;
    tmpDir?: string;
    now?: () => number;
  }) => Promise<ReapResult>;
};

const DAY = 24 * 60 * 60 * 1000;

describe('reapPrunedRawStashes', () => {
  let mod: ReaperModule;
  let dir: string;
  let now: number;

  test.before(async () => {
    mod = (await import(reaperUrl)) as ReaperModule;
  });

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'trp-reaper-'));
    now = 1_700_000_000_000; // fixed epoch so age math is deterministic
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Create a pruned-raw stash file with a backdated mtime. */
  function stash(name: string, bytes: string, ageDays: number): string {
    const p = path.join(dir, name);
    writeFileSync(p, bytes);
    const t = now - ageDays * DAY;
    // Date object (not raw ms) — utimesSync throws EINVAL on Windows for a
    // bare number; mirrors extension/test/temp-log-reaper.test.ts.
    utimesSync(p, new Date(t), new Date(t));
    return p;
  }

  /** Names of pruned-raw-*.txt files still present in the dir. */
  function remaining(): string[] {
    return readdirSync(dir).filter(
      (n) => n.startsWith('pruned-raw-') && n.endsWith('.txt'),
    );
  }

  test('deletes stashes older than maxAgeDays, keeps the rest', async () => {
    const old = stash('pruned-raw-old.txt', 'x', 10);
    const fresh = stash('pruned-raw-fresh.txt', 'x', 1);
    const r = await mod.reapPrunedRawStashes({ tmpDir: dir, maxAgeDays: 7, now: () => now });
    assert.equal(r.scanned, 2);
    assert.equal(r.deleted, 1);
    assert.equal(r.freedBytes, 1);
    assert.deepEqual(remaining(), ['pruned-raw-fresh.txt']);
    assert.throws(() => statSync(old));
    assert.doesNotThrow(() => statSync(fresh));
  });

  test('evicts oldest survivors until total size is under the cap', async () => {
    const mb = 'x'.repeat(1024 * 1024);
    stash('pruned-raw-a.txt', mb, 3); // oldest
    stash('pruned-raw-b.txt', mb, 2);
    stash('pruned-raw-c.txt', mb, 1); // newest
    // 3 MB total, cap 1.5 MB: evict a (2 MB left, still over) then b (1 MB, under).
    const r = await mod.reapPrunedRawStashes({
      tmpDir: dir,
      maxAgeDays: 0,
      maxTotalSizeMb: 1.5,
      now: () => now,
    });
    assert.equal(r.scanned, 3);
    assert.equal(r.deleted, 2);
    assert.equal(r.freedBytes, 2 * 1024 * 1024);
    assert.deepEqual(remaining(), ['pruned-raw-c.txt']);
  });

  test('does not throw when the tmpdir is missing', async () => {
    const missing = path.join(dir, 'does-not-exist');
    const r = await mod.reapPrunedRawStashes({ tmpDir: missing, now: () => now });
    assert.equal(r.scanned, 0);
    assert.equal(r.deleted, 0);
    assert.equal(r.freedBytes, 0);
  });

  test('maxAgeDays: 0 disables age-based deletion', async () => {
    stash('pruned-raw-ancient.txt', 'x', 365);
    const r = await mod.reapPrunedRawStashes({
      tmpDir: dir,
      maxAgeDays: 0,
      maxTotalSizeMb: 0,
      now: () => now,
    });
    assert.equal(r.deleted, 0);
    assert.equal(remaining().length, 1);
  });

  test('defaults: deletes >7d old, keeps fresh under the size cap', async () => {
    stash('pruned-raw-stale.txt', 'x', 8); // older than default 7 days
    stash('pruned-raw-fresh.txt', 'y', 1);
    const r = await mod.reapPrunedRawStashes({ tmpDir: dir, now: () => now });
    assert.equal(r.scanned, 2);
    assert.equal(r.deleted, 1);
    assert.deepEqual(remaining(), ['pruned-raw-fresh.txt']);
  });

  test('ignores files that do not match the pruned-raw-*.txt pattern', async () => {
    stash('pruned-raw-keep.txt', 'x', 0);
    writeFileSync(path.join(dir, 'pruned-raw-noext'), 'x'); // wrong suffix
    writeFileSync(path.join(dir, 'other-raw-1.txt'), 'x'); // wrong prefix
    writeFileSync(path.join(dir, 'pi-bash-1.log'), 'x'); // SDK temp log
    const r = await mod.reapPrunedRawStashes({
      tmpDir: dir,
      maxAgeDays: 0,
      maxTotalSizeMb: 0,
      now: () => now,
    });
    assert.equal(r.scanned, 1);
    assert.equal(r.deleted, 0);
    assert.equal(remaining().length, 1);
  });

  test('returns an empty result for a dir with no matching stashes', async () => {
    writeFileSync(path.join(dir, 'unrelated.txt'), 'x');
    const r = await mod.reapPrunedRawStashes({ tmpDir: dir, now: () => now });
    assert.equal(r.scanned, 0);
    assert.equal(r.deleted, 0);
    assert.equal(r.freedBytes, 0);
  });
});
