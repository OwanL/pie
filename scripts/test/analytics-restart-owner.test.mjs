import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  writeBoundedJsonAtomically,
  commonHostKey,
  expectedFenceForMode,
  mergeKeyChannelEntries,
  readRestartEnvironment,
  ownerRecordPath,
} from '../analytics-restart-owner.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const lifecycleStoreEntryPath = path.join(repositoryRoot, 'extension', 'out', 'session-lifecycle-store.js');
const controlEntryPath = path.join(repositoryRoot, 'extension', 'out', 'analytics-handoff-control.js');
const restartEntryPath = path.join(repositoryRoot, 'extension', 'out', 'analytics-controlled-restart.js');
const allHostEntryPath = path.join(repositoryRoot, 'extension', 'out', 'analytics-all-host-handoff.js');
for (const required of [lifecycleStoreEntryPath, controlEntryPath, restartEntryPath, allHostEntryPath]) {
  if (!existsSync(required)) {
    throw new Error(`${required} is missing; run the extension build first`);
  }
}

function temporaryRoot(label) {
  return mkdtempSync(path.join(tmpdir(), `pie-restart-owner-${label}-`));
}

async function removeTemporaryRoot(root) {
  // A freshly killed child may still hold file locks for a few hundred ms.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

test('restart owner seams validate the helper-issued pair, fence derivation, and key channel rules', () => {
  assert.throws(() => readRestartEnvironment({}), /requires PIE_ANALYTICS_RESTART_NONCE/);
  const resolved = readRestartEnvironment({
    PIE_ANALYTICS_RESTART_NONCE: ' nonce-env-1 ',
    PIE_ANALYTICS_TERMINAL_RESTART_RECEIPT_PATH: 'C:\\temp\\receipt.json',
  });
  assert.deepEqual(resolved, {
    restartNonce: 'nonce-env-1',
    terminalRestartReceiptPath: 'C:\\temp\\receipt.json',
  });

  const plan = { cutoverMode: 'analytics-activation', operationId: 'op-1' };
  assert.deepEqual(expectedFenceForMode(plan), {
    mode: 'analytics-activation',
    operationId: 'op-1:analytics-activation',
    purpose: 'analytics-activation',
  });
  assert.deepEqual(expectedFenceForMode({ cutoverMode: 'storage-cutoff', operationId: 'op-2' }), {
    mode: 'storage-cutoff',
    operationId: 'op-2',
    purpose: 'storage-cutoff',
  });
  assert.deepEqual(expectedFenceForMode({ generationId: 'gen-9' }), {
    mode: 'analytics-activation',
    operationId: 'gen-9:analytics-activation',
    purpose: 'analytics-activation',
  });
  assert.throws(() => expectedFenceForMode({ cutoverMode: 'other' }), /unsupported/);
  assert.throws(() => expectedFenceForMode({}), /operationId or generationId is required/);

  assert.equal(commonHostKey(['k1', 'k1']), 'k1');
  assert.throws(() => commonHostKey([]), /no registered host/);
  assert.throws(() => commonHostKey(['k1', 'k2']), /ambiguous/);
});

test('key channel refresh updates the durable file channel without disturbing existing entries', () => {
  const root = temporaryRoot('keys');
  try {
    const keysPath = path.join(root, 'host-handoff-keys.json');
    writeBoundedJsonAtomically(keysPath, { 'host-old': 'shared-key' }, 64 * 1024);
    const channel = { keys: new Map(Object.entries(readJson(keysPath))), file: keysPath, planPath: undefined };
    const updated = mergeKeyChannelEntries(channel, { 'host-new': 'shared-key' });
    assert.deepEqual(readJson(keysPath), { 'host-old': 'shared-key', 'host-new': 'shared-key' });
    assert.equal(updated.keys.get('host-new'), 'shared-key');
    // A key channel with no durable file refuses to refresh.
    assert.throws(
      () => mergeKeyChannelEntries({ keys: new Map(), file: undefined, planPath: undefined }, { h: 'k' }),
      /no durable file/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Serves the REAL built authenticated control endpoint with the real
// controlled-restart handler, exactly like a loaded Pie host.
const fixtureSource = `
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [configJson] = process.argv.slice(2);
const config = JSON.parse(configJson);
const { AnalyticsHandoffControl } = await import(pathToFileURL(config.controlEntry).href);
const { SessionLifecycleStore, storageCutoffRootCapability } = await import(pathToFileURL(config.lifecycleStoreEntry).href);
const { createAnalyticsHostControlledRestart } = await import(pathToFileURL(config.restartEntry).href);
const { createAnalyticsHostWriterFence } = await import(pathToFileURL(config.allHostEntry).href);
function pipeName(workspaceId, hostInstanceId) {
  const digest = createHash('sha256').update(workspaceId + String.fromCharCode(0) + hostInstanceId).digest('hex').slice(0, 40);
  const backslash = String.fromCharCode(92);
  return backslash + backslash + '.' + backslash + 'pipe' + backslash + 'pie-analytics-handoff-' + digest;
}
const identity = {
  hostInstanceId: config.hostInstanceId,
  workspaceId: config.workspaceId,
  generationId: config.generationId,
  buildId: 'build-owner-test',
  processId: process.pid,
  capabilities: config.cutoffRoot
    ? ['host-discovery', 'host-status', storageCutoffRootCapability(config.cutoffRoot)]
    : ['host-discovery', 'host-status'],
};
const store = new SessionLifecycleStore(config.lifecycleStorePath);
const control = new AnalyticsHandoffControl({
  registry: store,
  identity,
  key: config.key,
  pipeName: pipeName(config.workspaceId, config.hostInstanceId),
  onError: (error, stage) => writeFileSync(config.errorMarkerPath, stage + ': ' + String(error && error.message ? error.message : error) + String.fromCharCode(10), { flag: 'a' }),
  writerFence: createAnalyticsHostWriterFence({
    identity,
    activeWriterCount: () => 0,
    revokeAdmission: () => { throw new Error('fixture writer fence is not wired to a backend'); },
    isAdmissionRevoked: () => true,
    waitForIdle: async () => 0,
  }),
  restart: createAnalyticsHostControlledRestart({
    stateDir: config.stateDir,
    identity,
    performRestart: () => writeFileSync(config.restartMarkerPath, 'restarted' + String.fromCharCode(10)),
  }),
});
await control.start();
if (!control.isAvailable) {
  process.exit(2);
}
// The ready marker doubles as the fixture's pid evidence for the fence census.
writeFileSync(config.readyMarkerPath, String(process.pid));
// The fixture stays up until the test kills it; the endpoint closes then.
setInterval(() => {}, 60_000);
`;

async function waitForMarker(markerPath, timeoutMs = 10_000, capturedError = '') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(markerPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`fixture marker ${markerPath} never appeared${capturedError ? `: ${capturedError.slice(0, 2_000)}` : ''}`);
}

const PENDING_FILENAME = 'analytics-pending-controlled-restart-v1.json';

test('the one-shot owner coordinates the fenced census, records the nonce, and refreshes the key channel', async () => {
  const root = temporaryRoot('e2e');
  const stateDir = path.join(root, 'state');
  const workspaceId = `workspace-owner-e2e-${randomBytes(6).toString('hex')}`;
  const preRestartHostInstanceId = 'host-owner-pre-1';
  const restartedHostInstanceId = 'host-owner-post-1';
  const key = 'shared-owner-e2e-key-0000000000000001';
  const cutoffRoot = 'C:\\final\\sessions';
  try {
    const storeModule = await import(pathToFileURL(lifecycleStoreEntryPath).href);
    const { SessionLifecycleStore, storageCutoffRootCapability } = storeModule;
    const store = new SessionLifecycleStore(path.join(stateDir, 'session-lifecycle.sqlite'));
    try {
      // The fixture serves the real authenticated endpoint; its start()
      // registration happens while no writer fence exists.
      const fixturePath = path.join(root, 'control-host-fixture.mjs');
      const readyMarker = path.join(root, 'fixture-ready.txt');
      const restartMarker = path.join(root, 'fixture-restarted.txt');
      const errorMarker = path.join(root, 'fixture-errors.txt');
      writeFileSync(fixturePath, fixtureSource);
      const fixture = spawn(process.execPath, [fixturePath, JSON.stringify({
        controlEntry: controlEntryPath,
        lifecycleStoreEntry: lifecycleStoreEntryPath,
        restartEntry: restartEntryPath,
        allHostEntry: allHostEntryPath,
        lifecycleStorePath: path.join(stateDir, 'session-lifecycle.sqlite'),
        workspaceId,
        hostInstanceId: preRestartHostInstanceId,
        generationId: preRestartHostInstanceId,
        stateDir,
        key,
        cutoffRoot,
        readyMarkerPath: readyMarker,
        restartMarkerPath: restartMarker,
        errorMarkerPath: errorMarker,
      })], { stdio: ['ignore', 'ignore', 'pipe'] });
      const fixtureStdoutChunks = [];
      const fixtureStderrChunks = [];
      fixture.stdout?.on('data', (chunk) => { fixtureStdoutChunks.push(String(chunk)); });
      fixture.stderr?.on('data', (chunk) => { fixtureStderrChunks.push(String(chunk)); });
      fixture.on('exit', (code) => { fixtureStdoutChunks.push(`[fixture exited ${code}]`); });
      let fixtureError = '';
      fixture.stderr?.on('data', (chunk) => { fixtureError += String(chunk); });
      let owner;
      let ownerError = '';
      try {
        try {
          await waitForMarker(readyMarker, 10_000, fixtureError);
        } catch (error) {
          const endpointErrors = existsSync(errorMarker) ? readFileSync(errorMarker, 'utf8') : '';
          throw new Error(`${error instanceof Error ? error.message : String(error)} | fixture endpoint errors: ${endpointErrors.slice(0, 1_000)}`);
        }
        const fixturePid = Number(readFileSync(readyMarker, 'utf8').trim());
        const fixtureIdentity = {
          hostInstanceId: preRestartHostInstanceId,
          workspaceId,
          generationId: preRestartHostInstanceId,
          buildId: 'build-owner-test',
          processId: fixturePid,
        };

        // The helper's cutoff/activation phases establish this fence over the
        // complete registry census first.
        const fence = store.beginAnalyticsWriterFence({
          workspaceId,
          operationId: 'op-owner-e2e',
          purpose: 'storage-cutoff',
          expectedHosts: [fixtureIdentity],
          nowMs: Date.now(),
        });
        store.acknowledgeAnalyticsWriterFence({
          workspaceId,
          operationId: 'op-owner-e2e',
          fenceEpoch: fence.fenceEpoch,
          identity: fixtureIdentity,
          activeWriterCount: 0,
          nowMs: Date.now(),
        });
        store.completeAnalyticsWriterFence(workspaceId, 'op-owner-e2e', Date.now());
        // The helper's P7b binding step makes successor admission possible.
        store.authorizeStorageCutoffSuccessorCapability({
          workspaceId,
          operationId: 'op-owner-e2e',
          requiredCapability: storageCutoffRootCapability(cutoffRoot),
          nowMs: Date.now(),
        });

        const keysPath = path.join(root, 'host-handoff-keys.json');
        writeBoundedJsonAtomically(keysPath, { [preRestartHostInstanceId]: key }, 64 * 1024);
        const receiptPath = path.join(root, 'terminal-restart-receipt.json');
        const planPath = path.join(root, 'plan.json');
        writeBoundedJsonAtomically(planPath, {
          stateDir,
          workspaceId,
          cutoverMode: 'storage-cutoff',
          operationId: 'op-owner-e2e',
          terminalRestartReceiptPath: receiptPath,
          lifecycleStorePath: path.join(stateDir, 'session-lifecycle.sqlite'),
          cutoffRoots: { sessions: cutoffRoot, artifacts: 'C:\\final\\artifacts' },
          hostHandoffKeysPath: keysPath,
          hostProbeTimeoutMs: 5_000,
        }, 8 * 1024 * 1024);

        owner = spawn(process.execPath, [
          path.join(repositoryRoot, 'scripts', 'analytics-restart-owner.mjs'),
          '--plan', planPath,
        ], {
          cwd: repositoryRoot,
          env: {
            ...process.env,
            PIE_ANALYTICS_RESTART_NONCE: 'nonce-owner-e2e-1',
            PIE_ANALYTICS_TERMINAL_RESTART_RECEIPT_PATH: receiptPath,
          },
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        owner.stderr?.on('data', (chunk) => { ownerError += String(chunk); });

        // Simulate the restarted successor boot registering while the owner
        // watches the census. The pre-restart host quits as part of its quiet
        // restart, so it marks itself terminal before the successor registers.
        await new Promise((resolve) => setTimeout(resolve, 400));
        store.markAnalyticsHostState(preRestartHostInstanceId, fixturePid, preRestartHostInstanceId, 'stopped', Date.now());
        store.registerAnalyticsHost({
          hostInstanceId: restartedHostInstanceId,
          workspaceId,
          generationId: restartedHostInstanceId,
          buildId: 'build-owner-test',
          processId: process.pid,
          endpointName: null,
          capabilities: [
            'host-discovery',
            'host-status',
            'authenticated-control',
            storageCutoffRootCapability(cutoffRoot),
          ],
          registeredAtMs: `${Date.now()}`,
        });
        // The host handler's quiet restart fires after its bounded delay; the
        // receipt may then appear so the owner can complete.
        await waitForMarker(restartMarker, 10_000, fixtureError);
        writeFileSync(receiptPath, `${JSON.stringify({ kind: 'pie-p7-terminal-restart-v1' })}\n`);
        const exitCode = await new Promise((resolve) => owner.on('exit', resolve));
        assert.equal(exitCode, 0, `owner failed: ${ownerError}`);

        const pending = readJson(path.join(stateDir, PENDING_FILENAME));
        assert.equal(pending.restartNonce, 'nonce-owner-e2e-1');
        assert.equal(pending.terminalRestartReceiptPath, receiptPath);
        assert.equal(pending.purpose, 'storage-cutoff');
        assert.equal(pending.operationId, 'op-owner-e2e');
        const ownerRecord = readJson(ownerRecordPath(stateDir));
        assert.equal(ownerRecord.outcome, 'completed');
        assert.deepEqual(ownerRecord.ackedHostInstanceIds, [preRestartHostInstanceId]);
        assert.equal(ownerRecord.receiptObserved, true);
        assert.deepEqual(ownerRecord.refreshedKeyHostInstanceIds, [restartedHostInstanceId]);
        assert.equal(readJson(keysPath)[restartedHostInstanceId], key);
        assert.equal(readFileSync(restartMarker, 'utf8'), 'restarted\n');
      } finally {
        fixture.kill();
        owner?.kill();
      }
    } finally {
      store.close();
    }
  } finally {
    await removeTemporaryRoot(root);
  }
});

test('the owner fails closed before restarting when the fence or the ingress is missing', async () => {
  const root = temporaryRoot('fail-closed');
  const stateDir = path.join(root, 'state');
  const workspaceId = `workspace-owner-fenced-${randomBytes(6).toString('hex')}`;
  try {
    const storeModule = await import(pathToFileURL(lifecycleStoreEntryPath).href);
    const { SessionLifecycleStore } = storeModule;
    const store = new SessionLifecycleStore(path.join(stateDir, 'session-lifecycle.sqlite'));
    try {
      // Case 1: no durable fenced writer fence -> refuse without restarts.
      const planPath1 = path.join(root, 'plan-no-fence.json');
      const receiptPath1 = path.join(root, 'receipt-1.json');
      writeBoundedJsonAtomically(planPath1, {
        stateDir,
        workspaceId,
        cutoverMode: 'storage-cutoff',
        operationId: 'op-missing',
        terminalRestartReceiptPath: receiptPath1,
        lifecycleStorePath: path.join(stateDir, 'session-lifecycle.sqlite'),
        hostHandoffKeysPath: path.join(root, 'keys-1.json'),
      }, 8 * 1024 * 1024);
      const owner1 = spawn(process.execPath, [
        path.join(repositoryRoot, 'scripts', 'analytics-restart-owner.mjs'),
        '--plan', planPath1,
      ], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          PIE_ANALYTICS_RESTART_NONCE: 'nonce-fail-1',
          PIE_ANALYTICS_TERMINAL_RESTART_RECEIPT_PATH: receiptPath1,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let error1 = '';
      owner1.stderr?.on('data', (chunk) => { error1 += String(chunk); });
      const code1 = await new Promise((resolve) => owner1.on('exit', resolve));
      assert.equal(code1, 1);
      assert.match(error1, /not durable and fenced/);
      assert.equal(existsSync(receiptPath1), false, 'no restart may be requested without the fence');
      assert.equal(existsSync(path.join(stateDir, PENDING_FILENAME)), false, 'no pending restart may be recorded on refusal');
      const record1 = readJson(ownerRecordPath(stateDir));
      assert.equal(record1.outcome, 'failed');

      // Case 2: a registered host without the controlled-restart ingress.
      const legacyIdentity = {
        hostInstanceId: 'host-legacy',
        workspaceId,
        generationId: 'host-legacy',
        buildId: 'build-owner-test',
        processId: process.pid,
      };
      store.registerAnalyticsHost({
        ...legacyIdentity,
        endpointName: `\\\\.\\pipe\\pie-restart-owner-legacy`,
        capabilities: ['host-discovery', 'host-status', 'authenticated-control', 'writer-fence'],
        registeredAtMs: `${Date.now()}`,
      });
      const fence = store.beginAnalyticsWriterFence({
        workspaceId,
        operationId: 'op-stale-host',
        purpose: 'storage-cutoff',
        expectedHosts: [legacyIdentity],
        nowMs: Date.now(),
      });
      store.acknowledgeAnalyticsWriterFence({
        workspaceId,
        operationId: 'op-stale-host',
        fenceEpoch: fence.fenceEpoch,
        identity: legacyIdentity,
        activeWriterCount: 0,
        nowMs: Date.now(),
      });
      store.completeAnalyticsWriterFence(workspaceId, 'op-stale-host', Date.now());
      store.authorizeStorageCutoffSuccessorCapability({
        workspaceId,
        operationId: 'op-stale-host',
        requiredCapability: 'storage-root-sha256:0000000000000000000000000000000000000000000000000000000000000000',
        nowMs: Date.now(),
      });
      const keysPath2 = path.join(root, 'keys-2.json');
      writeBoundedJsonAtomically(keysPath2, { 'host-legacy': 'shared-key' }, 64 * 1024);
      const planPath2 = path.join(root, 'plan-stale-host.json');
      const receiptPath2 = path.join(root, 'receipt-2.json');
      writeBoundedJsonAtomically(planPath2, {
        stateDir,
        workspaceId,
        cutoverMode: 'storage-cutoff',
        operationId: 'op-stale-host',
        terminalRestartReceiptPath: receiptPath2,
        lifecycleStorePath: path.join(stateDir, 'session-lifecycle.sqlite'),
        hostHandoffKeysPath: keysPath2,
        cutoffRoots: { sessions: 'C:\\final\\sessions', artifacts: 'C:\\final\\artifacts' },
      }, 8 * 1024 * 1024);
      const owner2 = spawn(process.execPath, [
        path.join(repositoryRoot, 'scripts', 'analytics-restart-owner.mjs'),
        '--plan', planPath2,
      ], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          PIE_ANALYTICS_RESTART_NONCE: 'nonce-fail-2',
          PIE_ANALYTICS_TERMINAL_RESTART_RECEIPT_PATH: receiptPath2,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let error2 = '';
      owner2.stderr?.on('data', (chunk) => { error2 += String(chunk); });
      const code2 = await new Promise((resolve) => owner2.on('exit', resolve));
      assert.equal(code2, 1);
      assert.match(error2, /lack the controlled-restart ingress/);
      assert.equal(existsSync(receiptPath2), false, 'the bootstrap blocker must prevent restart requests');
      assert.equal(existsSync(path.join(stateDir, PENDING_FILENAME)), false, 'no pending restart may be recorded on refusal');
    } finally {
      store.close();
    }
  } finally {
    await removeTemporaryRoot(root);
  }
});