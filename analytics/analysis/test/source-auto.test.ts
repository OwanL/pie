import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_DUCKDB_PATH, DEFAULT_STAGING_EXPORTS_DIR } from '../scripts/source.ts';
import {
  buildLocalDefaultRebuildInputs,
  listStorageDirCandidates,
  readLatestLocalAnalyticsInputMs,
  shouldRebuildLocalDefaultDuckDb,
} from '../scripts/source-auto.ts';
import { withTempDir } from './helpers.ts';

test('relocating tracked source keeps the established ignored data root', () => {
  assert.equal(
    path.resolve(DEFAULT_DUCKDB_PATH),
    path.resolve(fileURLToPath(new URL('../../../analysis/data/usage.duckdb', import.meta.url))),
  );
  assert.equal(
    path.resolve(DEFAULT_STAGING_EXPORTS_DIR),
    path.resolve(fileURLToPath(new URL('../../../analysis/data/exports', import.meta.url))),
  );
});

test('local-default rebuild inputs watch the relocated pricing catalog, not the retired analysis path', () => {
  const configRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  const inputs = buildLocalDefaultRebuildInputs(configRoot);
  // The generated historical pricing catalog moved with the tracked analysis
  // workspace (B6); the retired top-level analysis catalog must not be watched.
  assert.ok(inputs.includes(path.join(configRoot, 'models.json')));
  assert.ok(inputs.includes(path.join(configRoot, 'analytics', 'analysis', 'model-pricing-history.json')));
  assert.ok(!inputs.includes(path.join(configRoot, 'analysis', 'model-pricing-history.json')));
  assert.ok(inputs.includes(path.join(configRoot, 'data', 'pruning.jsonl')));
  assert.ok(inputs.includes(path.join(configRoot, 'data', 'tool-result-pruning.jsonl')));
  assert.ok(inputs.includes(path.join(configRoot, 'data', 'warm-bash.jsonl')));
});

async function writeArtifact(storageDir: string, fileName: string, mtimeMs: number): Promise<void> {
  await fs.mkdir(storageDir, { recursive: true });
  const filePath = path.join(storageDir, fileName);
  await fs.writeFile(filePath, '{}\n', 'utf8');
  const timestamp = new Date(mtimeMs);
  await fs.utimes(filePath, timestamp, timestamp);
}

test('listStorageDirCandidates ignores directories without analytics artifacts', async () => {
  await withTempDir(async (outcomesRoot) => {
    const ignoredDir = path.join(outcomesRoot, 'aaaaaaaaaaaaaaaa');
    const includedDir = path.join(outcomesRoot, 'bbbbbbbbbbbbbbbb');
    const olderDir = path.join(outcomesRoot, 'cccccccccccccccc');

    await fs.mkdir(ignoredDir, { recursive: true });
    await writeArtifact(includedDir, 'open-runs.a.json', 7_000);
    await writeArtifact(olderDir, 'open-runs.b.json', 5_000);

    const candidates = await listStorageDirCandidates(outcomesRoot);
    assert.deepEqual(candidates, [
      { storageDir: includedDir, latestActivityMs: 7_000 },
      { storageDir: olderDir, latestActivityMs: 5_000 },
    ]);
  });
});

test('outcomes discovery tolerates missing directories', async () => {
  await withTempDir(async (root) => {
    const missingOutcomesRoot = path.join(root, 'missing-outcomes');
    assert.deepEqual(await listStorageDirCandidates(missingOutcomesRoot), []);
  });
});

test('local-default freshness includes run stores, catalogs, and side-channel logs', async () => {
  await withTempDir(async (root) => {
    const outcomesRoot = path.join(root, 'outcomes');
    const storageDir = path.join(outcomesRoot, 'aaaaaaaaaaaaaaaa');
    const dbPath = path.join(root, 'usage.duckdb');
    const modelsPath = path.join(root, 'models.json');
    const pruningPath = path.join(root, 'pruning.jsonl');
    const additionalInputs = [modelsPath, pruningPath];

    await writeArtifact(storageDir, 'run-snapshots.jsonl', 10_000);
    await writeArtifact(root, path.basename(modelsPath), 25_000);
    await writeArtifact(root, path.basename(pruningPath), 22_000);
    await writeArtifact(root, path.basename(dbPath), 15_000);

    assert.equal(await readLatestLocalAnalyticsInputMs(outcomesRoot, additionalInputs), 25_000);
    assert.equal(await shouldRebuildLocalDefaultDuckDb(dbPath, outcomesRoot, additionalInputs), true);

    const newerDbTime = new Date(30_000);
    await fs.utimes(dbPath, newerDbTime, newerDbTime);
    assert.equal(await shouldRebuildLocalDefaultDuckDb(dbPath, outcomesRoot, additionalInputs), false);
    assert.equal(await shouldRebuildLocalDefaultDuckDb(path.join(root, 'missing.duckdb'), outcomesRoot, additionalInputs), true);
  });
});

test('listStorageDirCandidates sorts tied directories alphabetically and rethrows invalid roots', async () => {
  await withTempDir(async (root) => {
    const outcomesRoot = path.join(root, 'outcomes');
    await fs.mkdir(outcomesRoot, { recursive: true });

    await writeArtifact(path.join(outcomesRoot, 'bbbbbbbbbbbbbbbb'), 'run-snapshots.jsonl', 12_000);
    await writeArtifact(path.join(outcomesRoot, 'aaaaaaaaaaaaaaaa'), 'open-runs.gen', 12_000);
    await fs.writeFile(path.join(outcomesRoot, 'notes.txt'), 'ignore me', 'utf8');

    const candidates = await listStorageDirCandidates(outcomesRoot);
    assert.deepEqual(
      candidates.map((candidate) => path.basename(candidate.storageDir)),
      ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'],
    );

    const fileBackedRoot = path.join(root, 'outcomes-file');
    await fs.writeFile(fileBackedRoot, 'not a directory', 'utf8');
    await assert.rejects(async () => await listStorageDirCandidates(fileBackedRoot));
  });
});
