// Focused unit tests for scripts/lib/sdk-version.mjs: version-coercion and
// in-tree Pi source-version authority.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readPinnedPiSourceVersion,
  coerceVersion,
  compareVersions,
  gte,
  inferRepoRoot,
} from '../sdk-version.mjs';

const repoRoot = inferRepoRoot();

test('coerceVersion strips ranges, v prefix, and prerelease/build metadata', () => {
  assert.deepEqual(coerceVersion('^0.80.6'), [0, 80, 6]);
  assert.deepEqual(coerceVersion('~0.80.0'), [0, 80, 0]);
  assert.deepEqual(coerceVersion('>=1.2.3'), [1, 2, 3]);
  assert.deepEqual(coerceVersion('v24.16.0'), [24, 16, 0]);
  assert.deepEqual(coerceVersion('0.80.6-next.1+sha'), [0, 80, 6]);
  assert.deepEqual(coerceVersion('1'), [1, 0, 0]);
  assert.deepEqual(coerceVersion('not-a-version'), [0, 0, 0]);
  assert.deepEqual(coerceVersion(undefined), [0, 0, 0]);
});

test('compareVersions orders by major.minor.patch and ignores ranges', () => {
  assert.equal(compareVersions('0.80.6', '0.80.6'), 0);
  assert.equal(compareVersions('^0.80.6', '0.80.6'), 0);
  assert.equal(compareVersions('0.80.7', '0.80.6'), 1);
  assert.equal(compareVersions('0.80.5', '0.80.6'), -1);
  assert.equal(compareVersions('0.81.0', '0.80.99'), 1);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
});

test('gte matches the documented boundary behavior', () => {
  assert.equal(gte('24.16.0', '24.16.0'), true);
  assert.equal(gte('24.16.1', '24.16.0'), true);
  assert.equal(gte('24.17.0', '24.16.0'), true);
  assert.equal(gte('24.15.0', '24.16.0'), false);
  assert.equal(gte('23.0.0', '24.16.0'), false);
  // ranges are stripped so a declared ^24.16.0 still satisfies a 24.16.0 floor
  assert.equal(gte('^24.16.0', '24.16.0'), true);
});

test('readPinnedPiSourceVersion reads the matched in-tree Pi package versions', () => {
  const v = readPinnedPiSourceVersion(repoRoot);
  assert.match(v, /^\d+\.\d+\.\d+$/);
  assert.equal(v, '0.80.6');
});

function createPiSourceFixture(t, { missing = null, mismatch = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-pi-source-version-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ['tui', 'ai', 'agent', 'coding-agent']) {
    if (directory === missing) continue;
    const manifestPath = path.join(root, 'harness', 'pi', 'packages', directory, 'package.json');
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    const version = mismatch && directory === 'coding-agent' ? '0.80.7' : '0.80.6';
    writeFileSync(manifestPath, JSON.stringify({ name: `fixture-${directory}`, version }));
  }
  return root;
}

test('readPinnedPiSourceVersion rejects a missing source package manifest', (t) => {
  const root = createPiSourceFixture(t, { missing: 'agent' });
  assert.throws(() => readPinnedPiSourceVersion(root), /Could not read Pi source package manifest.*agent.*package\.json/);
});

test('readPinnedPiSourceVersion rejects package versions that do not match', (t) => {
  const root = createPiSourceFixture(t, { mismatch: true });
  assert.throws(() => readPinnedPiSourceVersion(root), /Pi source package versions do not match:.*coding-agent=0\.80\.7/);
});
