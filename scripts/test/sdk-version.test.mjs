// Focused unit tests for scripts/lib/sdk-version.mjs — the version-coercion and
// lockfile-reading helpers that bootstrap.mjs, doctor.mjs, and the shell
// installers rely on to pin the global `pi` CLI to the extension's locked SDK.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  readPinnedSdkVersion,
  readDeclaredSdkRange,
  coerceVersion,
  compareVersions,
  gte,
  inferRepoRoot,
} from '../lib/sdk-version.mjs';

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

test('readPinnedSdkVersion returns the exact locked SDK version from extension/package-lock.json', () => {
  const v = readPinnedSdkVersion(repoRoot);
  assert.match(v, /^\d+\.\d+\.\d+$/);
  // The audit pins 0.80.6; the lockfile currently resolves to exactly that.
  assert.equal(v, '0.80.6');
});

test('readDeclaredSdkRange returns the package.json range (^x.y.z)', () => {
  const r = readDeclaredSdkRange(repoRoot);
  assert.ok(r, 'expected a declared range');
  assert.equal(r.startsWith('^'), true);
  assert.equal(coerceVersion(r).join('.'), '0.80.6');
});

test('readPinnedSdkVersion throws a clear error for a missing lockfile', () => {
  assert.throws(
    () => readPinnedSdkVersion(path.join(repoRoot, 'scripts')),
    /Could not read extension lockfile/,
  );
});
