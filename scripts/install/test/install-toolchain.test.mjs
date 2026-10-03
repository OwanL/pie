// Focused unit tests for scripts/install/lib/toolchain.mjs — the pure
// pinned-vs-actual comparison (no installs) used by the Windows installer and
// exercised by the `verify-toolchain` dry-run.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readPinnedVersions, verifyToolchain } from '../lib/toolchain.mjs';
import { inferRepoRoot } from '../../lib/sdk-version.mjs';

const repoRoot = inferRepoRoot();

test('readPinnedVersions returns Node/npm pins and the matched in-tree Pi source version', () => {
  const { node, npm, piSource } = readPinnedVersions(repoRoot);
  assert.match(node, /^\d+\.\d+\.\d+$/);
  assert.match(npm, /^\d+\.\d+\.\d+$/);
  assert.match(piSource, /^\d+\.\d+\.\d+$/);
  // Cross-check against the committed pins.
  assert.equal(node, '24.16.0');
  assert.equal(npm, '11.13.0');
});

test('verifyToolchain does not require a globally installed Pi CLI', () => {
  const pinned = { node: '24.16.0', npm: '11.13.0', piSource: '0.80.6' };
  const status = verifyToolchain({ pinned, actual: { node: '24.16.0', npm: '11.13.0' } });
  assert.equal(status.allOk, true);
  assert.equal(status.node.ok, true);
  assert.equal(status.npm.installCommand, null);
  assert.deepEqual(status.piSource, {
    version: '0.80.6',
    provenance: 'harness/pi/packages/{tui,ai,agent,coding-agent}/package.json',
  });
});

test('verifyToolchain reports npm drift with an install command and keeps Pi source informational', () => {
  const pinned = { node: '24.16.0', npm: '11.13.0', piSource: '0.80.6' };
  const status = verifyToolchain({ pinned, actual: { node: '24.16.0', npm: '10.9.8' } });
  assert.equal(status.allOk, false);
  assert.equal(status.npm.ok, false);
  assert.deepEqual(status.npm.installCommand, ['npm', 'install', '-g', 'npm@11.13.0']);
  assert.equal(status.piSource.version, '0.80.6');
});

test('verifyToolchain reports node drift without any install command (node is never auto-installed)', () => {
  const pinned = { node: '24.16.0', npm: '11.13.0', piSource: '0.80.6' };
  const status = verifyToolchain({ pinned, actual: { node: '22.22.3', npm: '11.13.0' } });
  assert.equal(status.allOk, false);
  assert.equal(status.node.ok, false);
  assert.equal(status.node.actual, '22.22.3');
  // No install command is offered for Node — the wrapper hard-errors instead.
  assert.equal(status.npm.installCommand, null);
  assert.equal('pi' in status, false);
});
