// Focused unit tests for scripts/install/lib/toolchain.mjs — the pure
// pinned-vs-actual comparison (no installs) shared by both shell installers and
// exercised by the `verify-toolchain` dry-run.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readPinnedVersions, verifyToolchain } from '../install/lib/toolchain.mjs';
import { inferRepoRoot } from '../lib/sdk-version.mjs';

const repoRoot = inferRepoRoot();

test('readPinnedVersions returns the three pinned versions from the repo', () => {
  const { node, npm, pi } = readPinnedVersions(repoRoot);
  assert.match(node, /^\d+\.\d+\.\d+$/);
  assert.match(npm, /^\d+\.\d+\.\d+$/);
  assert.match(pi, /^\d+\.\d+\.\d+$/);
  // Cross-check against the committed pins.
  assert.equal(node, '24.16.0');
  assert.equal(npm, '11.13.0');
});

test('verifyToolchain reports allOk when actuals match the pins', () => {
  const pinned = { node: '24.16.0', npm: '11.13.0', pi: '0.80.6' };
  const status = verifyToolchain({ pinned, actual: { ...pinned } });
  assert.equal(status.allOk, true);
  assert.equal(status.node.ok, true);
  assert.equal(status.npm.installCommand, null);
  assert.equal(status.pi.installCommand, null);
});

test('verifyToolchain reports npm drift with an install command and never touches node/pi', () => {
  const pinned = { node: '24.16.0', npm: '11.13.0', pi: '0.80.6' };
  const status = verifyToolchain({ pinned, actual: { node: '24.16.0', npm: '10.9.8', pi: '0.80.6' } });
  assert.equal(status.allOk, false);
  assert.equal(status.npm.ok, false);
  assert.deepEqual(status.npm.installCommand, ['npm', 'install', '-g', 'npm@11.13.0']);
  assert.equal(status.pi.ok, true);
  assert.equal(status.pi.installCommand, null);
});

test('verifyToolchain reports pi drift and pi-unavailable identically (install command present)', () => {
  const pinned = { node: '24.16.0', npm: '11.13.0', pi: '0.80.6' };
  const drifted = verifyToolchain({ pinned, actual: { node: '24.16.0', npm: '11.13.0', pi: '0.74.2' } });
  assert.equal(drifted.pi.ok, false);
  assert.deepEqual(drifted.pi.installCommand, ['npm', 'install', '-g', '@earendil-works/pi-coding-agent@0.80.6']);
  const unavailable = verifyToolchain({ pinned, actual: { node: '24.16.0', npm: '11.13.0', pi: '' } });
  assert.equal(unavailable.pi.ok, false);
  assert.deepEqual(unavailable.pi.installCommand, drifted.pi.installCommand);
});

test('verifyToolchain reports node drift without any install command (node is never auto-installed)', () => {
  const pinned = { node: '24.16.0', npm: '11.13.0', pi: '0.80.6' };
  const status = verifyToolchain({ pinned, actual: { node: '22.22.3', npm: '11.13.0', pi: '0.80.6' } });
  assert.equal(status.allOk, false);
  assert.equal(status.node.ok, false);
  assert.equal(status.node.actual, '22.22.3');
  // No install command is offered for Node — the wrapper hard-errors instead.
  assert.equal(status.npm.installCommand, null);
  assert.equal(status.pi.installCommand, null);
});
