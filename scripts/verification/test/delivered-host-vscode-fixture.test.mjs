import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

// Focused SDK-free regression for the delivered VS Code fixture's deactivation
// lifecycle report: the fulfilled and rejected paths must both stay inside one
// awaited sequence so a metadata inspection failure after a fulfilled bootstrap
// deactivate reports deactivation-error instead of an unhandled rejection that
// strands qualification until it times out.
const spawnBeforeRequiringFixture = childProcess.spawn;
const requireFixture = createRequire(import.meta.url);
const { handleDeactivationMessage } = requireFixture('./fixtures/delivered-host-vscode.cjs');

test('delivered fixture message handler derives the v2-only metadata root and reports deactivation', async () => {
  assert.equal(childProcess.spawn, spawnBeforeRequiringFixture,
    'requiring the delivered fixture as a module must not patch the importer process spawn.');
  const root = await mkdtemp(path.join(os.tmpdir(), 'pie-delivered-fixture-deactivation-'));
  try {
    const metadataRoot = path.join(root, 'pie-runtime-v2');
    await mkdir(path.join(metadataRoot, 'leases'), { recursive: true });
    await mkdir(path.join(metadataRoot, 'selections'), { recursive: true });
    await writeFile(path.join(metadataRoot, 'leases', 'generation-a'), 'lease', 'utf8');
    const sent = [];
    const disconnected = [];
    const runtime = { deactivate: async () => { sent.push({ type: 'deactivate-resolved' }); }, selectionWatchers: { size: 0 } };
    await handleDeactivationMessage({ type: 'deactivate' }, {
      runtime, releaseRoot: root, runtimeDirectory: 'pie-runtime-v2',
      send: message => sent.push(message), disconnect: () => disconnected.push(true),
    });
    assert.deepEqual(sent.map(message => message.type), ['deactivating', 'deactivate-resolved', 'deactivated'],
      'the deactivation report must send deactivating before awaiting deactivate and deactivated only after it resolves.');
    const deactivated = sent.find(message => message.type === 'deactivated');
    assert.equal(deactivated.selectionWatcherCount, 0, 'closed bootstrap selection watchers must be reported.');
    assert.deepEqual(deactivated.leases, ['generation-a'], 'remaining generation leases must be reported truthfully.');
    assert.deepEqual(deactivated.selections, [], 'remaining published selections must be reported truthfully.');
    assert.deepEqual(disconnected, [true], 'the handler disconnects after a successful report.');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('delivered fixture message handler sends deactivation-error on post-deactivate inspection failure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pie-delivered-fixture-deactivation-'));
  try {
    const sent = [];
    const disconnected = [];
    const runtime = { deactivate: async () => {}, selectionWatchers: { size: 1 } };
    await handleDeactivationMessage({ type: 'deactivate' }, {
      runtime, releaseRoot: root, runtimeDirectory: 'pie-runtime-v2',
      send: message => sent.push(message), disconnect: () => disconnected.push(true),
    });
    assert.deepEqual(sent.map(message => message.type), ['deactivating', 'deactivation-error'],
      'the actual message handler must send deactivation-error when metadata inspection fails.');
    assert.match(sent[1].error, /ENOENT/);
    assert.deepEqual(disconnected, [true], 'the handler disconnects after reporting failure.');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('delivered fixture message handler reports bootstrap deactivate failures', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pie-delivered-fixture-deactivation-'));
  try {
    const sent = [];
    const failure = Object.assign(new Error('bootstrap deactivate rejected'), { code: 'EPIEDEACTIVATE' });
    const runtime = { deactivate: async () => { throw failure; }, selectionWatchers: { size: 1 } };
    await handleDeactivationMessage({ type: 'deactivate' }, {
      runtime, releaseRoot: root, runtimeDirectory: 'pie-runtime-v2', send: message => sent.push(message),
    });
    assert.deepEqual(sent.map(message => message.type), ['deactivating', 'deactivation-error'],
      'a rejected deactivate must be reported by the actual message handler.');
    assert.match(sent[1].error, /bootstrap deactivate rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});