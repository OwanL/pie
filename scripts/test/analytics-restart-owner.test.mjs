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
const { createAnalyticsHostControlledRestart, claimPendingControlledRestart } = await import(pathToFileURL(config.restartEntry).href);
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
  buildId: config.buildId,
  processId: process.pid,
  capabilities: config.cutoffRoot
    ? ['host-discovery', 'host-status', storageCutoffRootCapability(config.cutoffRoot)]
    : ['host-discovery', 'host-status'],
};
const store = new SessionLifecycleStore(config.lifecycleStorePath);
let successorControl;
async function simulateSuccessor() {
  const pending = claimPendingControlledRestart(config.stateDir);
  if (!pending) throw new Error('fixture successor could not claim its pending restart');
  for (const predecessorHostInstanceId of config.predecessorHostInstanceIds ?? [identity.hostInstanceId]) {
    const predecessor = store.getAnalyticsHost(predecessorHostInstanceId);
    if (predecessor && predecessor.state !== 'stopped') {
      store.markAnalyticsHostState(
        predecessor.hostInstanceId,
        predecessor.processId,
        predecessor.generationId,
        'stopped',
        Date.now(),
      );
    }
  }
  if (config.successorDelayMs) {
    await new Promise((resolve) => setTimeout(resolve, config.successorDelayMs));
  }
  const successorIdentity = {
    hostInstanceId: config.successorHostInstanceId,
    workspaceId: config.workspaceId,
    generationId: config.successorHostInstanceId,
    buildId: config.buildId,
    processId: process.pid,
    capabilities: ['host-discovery', 'host-status', ...pending.successorCapabilities],
  };
  successorControl = new AnalyticsHandoffControl({
    registry: store,
    identity: successorIdentity,
    key: pending.successorHandoffKey,
    pipeName: pipeName(config.workspaceId, config.successorHostInstanceId),
    restart: createAnalyticsHostControlledRestart({
      stateDir: config.stateDir,
      identity: successorIdentity,
      performRestart: () => undefined,
      schedule: () => () => undefined,
    }),
  });
  await successorControl.start();
  const loadedAt = new Date().toISOString();
  writeFileSync(pending.loadedGenerationPath, JSON.stringify({
    schemaVersion: 1,
    generationId: config.analyticsGenerationId,
    buildId: config.buildId,
    manifestRevision: 1,
    manifestSha256: 'a'.repeat(64),
    workspaceId: config.workspaceId,
    hostInstanceId: config.successorHostInstanceId,
    restartNonce: pending.restartNonce,
    loadedAt,
  }) + String.fromCharCode(10));
  writeFileSync(pending.terminalRestartReceiptPath, JSON.stringify({
    schemaVersion: 1,
    kind: 'pie-p7-terminal-restart-v1',
    status: 'ready',
    generationId: config.analyticsGenerationId,
    buildId: config.buildId,
    restartNonce: pending.restartNonce,
    hostInstanceId: config.successorHostInstanceId,
    processId: process.pid,
    loadedAt,
    verifiedAt: new Date().toISOString(),
  }) + String.fromCharCode(10));
}
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
    performRestart: () => {
      writeFileSync(config.restartMarkerPath, 'restarted' + String.fromCharCode(10));
      if (config.simulateSuccessor !== false) {
        void simulateSuccessor().catch((error) => writeFileSync(
          config.errorMarkerPath,
          'successor: ' + String(error && error.message ? error.message : error) + String.fromCharCode(10),
          { flag: 'a' },
        ));
      }
    },
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

function waitForChildExit(child) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once('exit', resolve));
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
        successorHostInstanceId: restartedHostInstanceId,
        generationId: preRestartHostInstanceId,
        analyticsGenerationId: 'generation-owner-e2e',
        buildId: 'build-owner-test',
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
          generationId: 'generation-owner-e2e',
          buildId: 'build-owner-test',
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

        // The fixture's controlled-restart handler claims its scoped pending
        // record, starts a fresh authenticated endpoint, and writes complete
        // loaded/terminal evidence for the actual successor identity.
        await waitForMarker(restartMarker, 10_000, fixtureError);
        const exitCode = await new Promise((resolve) => owner.on('exit', resolve));
        assert.equal(exitCode, 0, `owner failed: ${ownerError}`);

        assert.equal(existsSync(path.join(stateDir, PENDING_FILENAME)), false, 'the successor must consume its scoped pending record');
        const ownerRecord = readJson(ownerRecordPath(stateDir));
        assert.equal(ownerRecord.outcome, 'completed');
        assert.deepEqual(ownerRecord.ackedHostInstanceIds, [preRestartHostInstanceId]);
        assert.equal(ownerRecord.receiptObserved, true);
        assert.deepEqual(ownerRecord.refreshedKeyHostInstanceIds, [restartedHostInstanceId]);
        assert.equal(ownerRecord.authenticatedSuccessorHostInstanceIds[0], restartedHostInstanceId);
        assert.notEqual(readJson(keysPath)[restartedHostInstanceId], key);
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

test('the owner settles staggered two-host replacements with distinct successor keys and evidence paths', async () => {
  const root = temporaryRoot('two-host');
  const stateDir = path.join(root, 'state');
  const workspaceId = `workspace-owner-two-host-${randomBytes(6).toString('hex')}`;
  const predecessors = ['host-owner-pre-a', 'host-owner-pre-b'];
  const successors = ['host-owner-post-a', 'host-owner-post-b'];
  const oldKeys = {
    [predecessors[0]]: 'old-owner-key-a-000000000000000000000001',
    [predecessors[1]]: 'old-owner-key-b-000000000000000000000002',
  };
  const operationId = 'op-owner-two-host';
  let store;
  try {
    const storeModule = await import(pathToFileURL(lifecycleStoreEntryPath).href);
    const { SessionLifecycleStore } = storeModule;
    store = new SessionLifecycleStore(path.join(stateDir, 'session-lifecycle.sqlite'));
    const fixtures = [];
    let owner;
    try {
      const fixturePath = path.join(root, 'two-host-fixture.mjs');
      writeFileSync(fixturePath, fixtureSource);
      const configs = predecessors.map((hostInstanceId, index) => ({
        controlEntry: controlEntryPath,
        lifecycleStoreEntry: lifecycleStoreEntryPath,
        restartEntry: restartEntryPath,
        allHostEntry: allHostEntryPath,
        lifecycleStorePath: path.join(stateDir, 'session-lifecycle.sqlite'),
        workspaceId,
        hostInstanceId,
        predecessorHostInstanceIds: predecessors,
        generationId: hostInstanceId,
        analyticsGenerationId: 'generation-owner-two-host',
        buildId: 'build-owner-test',
        successorHostInstanceId: successors[index],
        successorDelayMs: index === 0 ? 0 : 150,
        stateDir,
        key: oldKeys[hostInstanceId],
        readyMarkerPath: path.join(root, `fixture-${index}-ready.txt`),
        restartMarkerPath: path.join(root, `fixture-${index}-restarted.txt`),
        errorMarkerPath: path.join(root, `fixture-${index}-errors.txt`),
      }));
      const fixtureErrors = configs.map(() => '');
      for (const [index, config] of configs.entries()) {
        const child = spawn(process.execPath, [fixturePath, JSON.stringify(config)], {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        child.stderr?.on('data', (chunk) => { fixtureErrors[index] += String(chunk); });
        fixtures.push(child);
      }
      await Promise.all(configs.map((config, index) => waitForMarker(
        config.readyMarkerPath,
        10_000,
        fixtureErrors[index],
      )));
      const identities = configs.map((config) => ({
        hostInstanceId: config.hostInstanceId,
        workspaceId,
        generationId: config.generationId,
        buildId: config.buildId,
        processId: Number(readFileSync(config.readyMarkerPath, 'utf8').trim()),
      }));
      const fence = store.beginAnalyticsWriterFence({
        workspaceId,
        operationId: `${operationId}:analytics-activation`,
        purpose: 'analytics-activation',
        expectedHosts: identities,
        nowMs: Date.now(),
      });
      for (const identity of identities) {
        store.acknowledgeAnalyticsWriterFence({
          workspaceId,
          operationId: `${operationId}:analytics-activation`,
          fenceEpoch: fence.fenceEpoch,
          identity,
          activeWriterCount: 0,
          nowMs: Date.now(),
        });
      }
      store.completeAnalyticsWriterFence(workspaceId, `${operationId}:analytics-activation`, Date.now());
      const keysPath = path.join(root, 'two-host-keys.json');
      writeBoundedJsonAtomically(keysPath, oldKeys, 64 * 1024);
      const receiptPath = path.join(root, 'two-host-terminal-receipt.json');
      const planPath = path.join(root, 'two-host-plan.json');
      writeBoundedJsonAtomically(planPath, {
        stateDir,
        workspaceId,
        cutoverMode: 'analytics-activation',
        operationId,
        terminalRestartReceiptPath: receiptPath,
        lifecycleStorePath: path.join(stateDir, 'session-lifecycle.sqlite'),
        generationId: 'generation-owner-two-host',
        buildId: 'build-owner-test',
        hostHandoffKeysPath: keysPath,
        hostProbeTimeoutMs: 5_000,
        restartSettleTimeoutMs: 10_000,
      }, 8 * 1024 * 1024);
      owner = spawn(process.execPath, [
        path.join(repositoryRoot, 'scripts', 'analytics-restart-owner.mjs'),
        '--plan', planPath,
      ], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          PIE_ANALYTICS_RESTART_NONCE: 'nonce-owner-two-host-1',
          PIE_ANALYTICS_TERMINAL_RESTART_RECEIPT_PATH: receiptPath,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      const ownerExit = waitForChildExit(owner);
      let ownerError = '';
      owner.stderr?.on('data', (chunk) => { ownerError += String(chunk); });
      await Promise.all(configs.map((config, index) => waitForMarker(
        config.restartMarkerPath,
        10_000,
        fixtureErrors[index],
      )));
      const exitCode = await ownerExit;
      assert.equal(exitCode, 0, `owner failed: ${ownerError}`);
      assert.equal(configs.some((config) => existsSync(config.errorMarkerPath)), false);
      assert.equal(existsSync(path.join(stateDir, PENDING_FILENAME)), false);
      const ownerRecord = readJson(ownerRecordPath(stateDir));
      assert.equal(ownerRecord.outcome, 'completed');
      assert.deepEqual(ownerRecord.ackedHostInstanceIds, predecessors);
      assert.deepEqual(ownerRecord.replacementHostInstanceIds, successors);
      assert.deepEqual(ownerRecord.authenticatedSuccessorHostInstanceIds, successors);
      assert.equal(ownerRecord.receiptObserved, true);
      const keyChannel = readJson(keysPath);
      assert.notEqual(keyChannel[successors[0]], oldKeys[predecessors[0]]);
      assert.notEqual(keyChannel[successors[1]], oldKeys[predecessors[1]]);
      assert.notEqual(keyChannel[successors[0]], keyChannel[successors[1]]);
      assert.equal(existsSync(path.join(stateDir, 'analytics-loaded-generation-v1.json')), true);
      const secondLoadedSuffix = createHash('sha256').update(predecessors[1], 'utf8').digest('hex').slice(0, 32);
      assert.equal(existsSync(path.join(stateDir, `analytics-loaded-generation-v1.json.${secondLoadedSuffix}.json`)), true);
      assert.equal(existsSync(receiptPath), true);
      const secondReceiptSuffix = createHash('sha256').update(predecessors[1], 'utf8').digest('hex').slice(0, 32);
      assert.equal(existsSync(`${receiptPath}.${secondReceiptSuffix}.json`), true);
    } finally {
      owner?.kill();
      for (const fixture of fixtures) fixture.kill();
    }
  } finally {
    store?.close();
    await removeTemporaryRoot(root);
  }
});

test('the owner times out nonzero and refuses a duplicate destructive request', async () => {
  const root = temporaryRoot('timeout');
  const stateDir = path.join(root, 'state');
  const workspaceId = `workspace-owner-timeout-${randomBytes(6).toString('hex')}`;
  const hostInstanceId = 'host-owner-timeout-pre';
  const key = 'timeout-owner-key-000000000000000000000001';
  try {
    const storeModule = await import(pathToFileURL(lifecycleStoreEntryPath).href);
    const { SessionLifecycleStore } = storeModule;
    const store = new SessionLifecycleStore(path.join(stateDir, 'session-lifecycle.sqlite'));
    let fixture;
    try {
      const fixturePath = path.join(root, 'timeout-host-fixture.mjs');
      const readyMarker = path.join(root, 'fixture-ready.txt');
      const restartMarker = path.join(root, 'fixture-restarted.txt');
      const errorMarker = path.join(root, 'fixture-errors.txt');
      writeFileSync(fixturePath, fixtureSource);
      fixture = spawn(process.execPath, [fixturePath, JSON.stringify({
        controlEntry: controlEntryPath,
        lifecycleStoreEntry: lifecycleStoreEntryPath,
        restartEntry: restartEntryPath,
        allHostEntry: allHostEntryPath,
        lifecycleStorePath: path.join(stateDir, 'session-lifecycle.sqlite'),
        workspaceId,
        hostInstanceId,
        generationId: hostInstanceId,
        analyticsGenerationId: 'generation-owner-timeout',
        buildId: 'build-owner-test',
        successorHostInstanceId: 'unused-successor',
        stateDir,
        key,
        simulateSuccessor: false,
        readyMarkerPath: readyMarker,
        restartMarkerPath: restartMarker,
        errorMarkerPath: errorMarker,
      })], { stdio: ['ignore', 'ignore', 'pipe'] });
      let fixtureError = '';
      fixture.stderr?.on('data', (chunk) => { fixtureError += String(chunk); });
      await waitForMarker(readyMarker, 10_000, fixtureError);
      const fixturePid = Number(readFileSync(readyMarker, 'utf8').trim());
      const identity = {
        hostInstanceId,
        workspaceId,
        generationId: hostInstanceId,
        buildId: 'build-owner-test',
        processId: fixturePid,
      };
      const fence = store.beginAnalyticsWriterFence({
        workspaceId,
        operationId: 'op-owner-timeout:analytics-activation',
        purpose: 'analytics-activation',
        expectedHosts: [identity],
        nowMs: Date.now(),
      });
      store.acknowledgeAnalyticsWriterFence({
        workspaceId,
        operationId: 'op-owner-timeout:analytics-activation',
        fenceEpoch: fence.fenceEpoch,
        identity,
        activeWriterCount: 0,
        nowMs: Date.now(),
      });
      store.completeAnalyticsWriterFence(workspaceId, 'op-owner-timeout:analytics-activation', Date.now());
      const keysPath = path.join(root, 'timeout-keys.json');
      writeBoundedJsonAtomically(keysPath, { [hostInstanceId]: key }, 64 * 1024);
      const receiptPath = path.join(root, 'timeout-receipt.json');
      const planPath = path.join(root, 'timeout-plan.json');
      writeBoundedJsonAtomically(planPath, {
        stateDir,
        workspaceId,
        cutoverMode: 'analytics-activation',
        operationId: 'op-owner-timeout',
        terminalRestartReceiptPath: receiptPath,
        lifecycleStorePath: path.join(stateDir, 'session-lifecycle.sqlite'),
        generationId: 'generation-owner-timeout',
        buildId: 'build-owner-test',
        hostHandoffKeysPath: keysPath,
        hostProbeTimeoutMs: 500,
        restartSettleTimeoutMs: 100,
      }, 8 * 1024 * 1024);
      const ownerArgs = [path.join(repositoryRoot, 'scripts', 'analytics-restart-owner.mjs'), '--plan', planPath];
      const ownerEnvironment = {
        ...process.env,
        PIE_ANALYTICS_RESTART_NONCE: 'nonce-owner-timeout-1',
        PIE_ANALYTICS_TERMINAL_RESTART_RECEIPT_PATH: receiptPath,
      };
      const runOwner = () => spawn(process.execPath, ownerArgs, {
        cwd: repositoryRoot,
        env: ownerEnvironment,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      const owner = runOwner();
      const firstExit = waitForChildExit(owner);
      let ownerError = '';
      owner.stderr?.on('data', (chunk) => { ownerError += String(chunk); });
      await waitForMarker(restartMarker, 10_000, fixtureError);
      const firstCode = await firstExit;
      assert.equal(firstCode, 1);
      assert.match(ownerError, /complete replacement census before timeout/);
      const firstRecord = readJson(ownerRecordPath(stateDir));
      assert.equal(firstRecord.outcome, 'failed');
      assert.deepEqual(firstRecord.ackedHostInstanceIds, [hostInstanceId]);
      assert.deepEqual(firstRecord.replacementHostInstanceIds, []);
      assert.equal(readFileSync(restartMarker, 'utf8').trim().split('\\n').length, 1);

      const retry = runOwner();
      let retryError = '';
      retry.stderr?.on('data', (chunk) => { retryError += String(chunk); });
      const retryCode = await waitForChildExit(retry);
      assert.equal(retryCode, 1);
      assert.match(retryError, /refusing to issue another destructive restart request/);
      assert.equal(readFileSync(restartMarker, 'utf8').trim().split('\\n').length, 1);
    } finally {
      fixture?.kill();
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
        generationId: 'generation-stale-host',
        buildId: 'build-owner-test',
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