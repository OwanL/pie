// Focused unit tests for scripts/install/lib/toolchain.mjs — the pure
// Proto-selected pinned-vs-actual comparison used by the Windows installer.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readPinnedVersions, verifyToolchain } from '../lib/toolchain.mjs';
import { inferRepoRoot } from '../../lib/sdk-version.mjs';

const repoRoot = inferRepoRoot();

test('readPinnedVersions returns repository Proto Node/pnpm pins and matched in-tree Pi source version', () => {
  const { node, pnpm, piSource } = readPinnedVersions(repoRoot);
  assert.match(node, /^\d+\.\d+\.\d+$/);
  assert.match(pnpm, /^\d+\.\d+\.\d+$/);
  assert.match(piSource, /^\d+\.\d+\.\d+$/);
  assert.equal(node, '24.16.0');
  assert.equal(pnpm, '10.34.4');
});

test('verifyToolchain compares Node and pnpm without install recommendations or global Pi checks', () => {
  const pinned = { node: '24.16.0', pnpm: '10.34.4', piSource: '0.80.6' };
  const status = verifyToolchain({ pinned, actual: { node: '24.16.0', pnpm: '10.34.4' } });
  assert.equal(status.allOk, true);
  assert.equal(status.node.ok, true);
  assert.equal(status.pnpm.ok, true);
  assert.deepEqual(status.piSource, {
    version: '0.80.6',
    provenance: 'harness/pi/packages/{tui,ai,agent,coding-agent}/package.json',
  });
  assert.equal('installCommand' in status.pnpm, false);
});

test('verifyToolchain reports pnpm drift without offering to install it globally', () => {
  const pinned = { node: '24.16.0', pnpm: '10.34.4', piSource: '0.80.6' };
  const status = verifyToolchain({ pinned, actual: { node: '24.16.0', pnpm: '9.9.9' } });
  assert.equal(status.allOk, false);
  assert.equal(status.pnpm.ok, false);
  assert.equal(status.pnpm.actual, '9.9.9');
  assert.equal('installCommand' in status.pnpm, false);
});

test('verifyToolchain reports node drift without installing runtimes or changing PATH', () => {
  const pinned = { node: '24.16.0', pnpm: '10.34.4', piSource: '0.80.6' };
  const status = verifyToolchain({ pinned, actual: { node: '22.22.3', pnpm: '10.34.4' } });
  assert.equal(status.allOk, false);
  assert.equal(status.node.ok, false);
  assert.equal(status.node.actual, '22.22.3');
  assert.equal(status.pnpm.ok, true);
});
