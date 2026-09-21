import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createAnalyticsHandoffPipeName,
} from '../../../shared/analytics/host-status-messages.js';
import {
  ANALYTICS_CONTROLLED_RESTART_PROTOCOL,
  claimPendingControlledRestart,
  consumePendingControlledRestart,
  createAnalyticsHostControlledRestart,
  createControlledRestartError,
  createControlledRestartRequest,
  isPendingControlledRestartConsumable,
  PENDING_CONTROLLED_RESTART_FILENAME,
  pendingControlledRestartExists,
  readPendingControlledRestart,
  verifyControlledRestartRequest,
  verifyControlledRestartResponse,
  writePendingControlledRestartAtomically,
} from '../../src/host/analytics-controlled-restart.js';
import { AnalyticsHandoffControl } from '../../src/host/analytics-handoff-control.js';
import { SessionLifecycleStore } from '../../src/backend/session-lifecycle-store.js';

function temporaryRoot(label: string): string {
  return mkdtempSync(path.join(tmpdir(), `pie-controlled-restart-${label}-`));
}

function temporaryStore(root: string): SessionLifecycleStore {
  return new SessionLifecycleStore(path.join(root, 'state', 'session-lifecycle.sqlite'));
}

async function sendFrame(pipeName: string, frame: unknown): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(pipeName);
    let data = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('controlled restart test response timed out')); }, 5_000);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.end(`${JSON.stringify(frame)}\n`));
    socket.on('data', (chunk: string) => { data += chunk; });
    socket.on('end', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(data.trim()) as unknown); } catch (error) { reject(error); }
    });
    socket.on('error', (error: Error) => { clearTimeout(timer); reject(error); });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const identity = {
  hostInstanceId: 'host-restart-1',
  workspaceId: 'workspace-restart-1',
  generationId: 'generation-restart-1',
  buildId: 'build-restart-1',
  processId: process.pid,
} as const;
const KEY = 'unit-test-controlled-restart-key';

function restartFields(hostInstanceId: string = identity.hostInstanceId) {
  return {
    targetHostInstanceId: hostInstanceId,
    successorHandoffKey: KEY,
    loadedGenerationPath: path.join(tmpdir(), 'loaded-generation.json'),
    successorCapabilities: [],
    evidenceOwner: true,
  } as const;
}

function distinctIdentity(suffix: string) {
  return {
    hostInstanceId: `host-restart-${suffix}`,
    workspaceId: `workspace-restart-${suffix}`,
    generationId: `generation-restart-${suffix}`,
    buildId: 'build-restart-1',
    processId: process.pid,
  } as const;
}

test('controlled restart requests round-trip, bind to auth, and reject tampering', () => {
  const request = createControlledRestartRequest({
    workspaceId: identity.workspaceId,
    purpose: 'storage-cutoff',
    operationId: 'operation-1',
    restartNonce: 'nonce-1234-abc',
    terminalRestartReceiptPath: path.join(tmpdir(), 'receipt.json'),
    ...restartFields(),
  }, KEY, { requestId: 'req-1', nonce: 'frame-1', issuedAtMs: 100, expiresAtMs: 5_000 });
  assert.equal(request.protocol, ANALYTICS_CONTROLLED_RESTART_PROTOCOL);
  const verified = verifyControlledRestartRequest(JSON.parse(JSON.stringify(request)), KEY);
  assert.equal(verified.restartNonce, 'nonce-1234-abc');
  assert.equal(verified.purpose, 'storage-cutoff');

  const tampered = { ...JSON.parse(JSON.stringify(request)), restartNonce: 'nonce-9999-xyz' };
  assert.throws(() => verifyControlledRestartRequest(tampered, KEY), /authentication failed/);
  assert.throws(() => verifyControlledRestartRequest(JSON.parse(JSON.stringify(request)), 'other-key'), /authentication failed/);
  const error = createControlledRestartError('req-1', 'boom', KEY);
  const verifiedError = verifyControlledRestartResponse(JSON.parse(JSON.stringify(error)), KEY);
  assert.equal(verifiedError.ok, false);
  assert.throws(() => verifyControlledRestartResponse(JSON.parse(JSON.stringify(error)), 'other-key'), /authentication failed/);
});

test('controlled restart request bounds fail closed', () => {
  const base = {
    workspaceId: identity.workspaceId,
    purpose: 'storage-cutoff' as const,
    operationId: 'operation-1',
    restartNonce: 'nonce-1234-abc',
    terminalRestartReceiptPath: path.join(tmpdir(), 'receipt.json'),
    ...restartFields(),
  };
  assert.throws(() => createControlledRestartRequest(base, KEY, { issuedAtMs: 100, expiresAtMs: 100 + 5 * 60 * 1_000 + 1 }), /expiry is invalid/);
  assert.throws(() => createControlledRestartRequest({ ...base, terminalRestartReceiptPath: 'relative/receipt.json' }, KEY), /must be absolute/);
  assert.throws(() => createControlledRestartRequest({ ...base, restartNonce: 'bad nonce!' }, KEY), /invalid format/);
  assert.throws(() => createControlledRestartRequest({ ...base, purpose: 'other' as never }, KEY), /purpose is invalid/);
});

test('the host restart handler records a durable pending slot and schedules the quiet restart', async () => {
  const root = temporaryRoot('handler');
  try {
    const stateDir = path.join(root, 'state');
    const performed: string[] = [];
    const handler = createAnalyticsHostControlledRestart({
      stateDir,
      identity,
      performRestart: () => performed.push('restart'),
    });
    const request = createControlledRestartRequest({
      workspaceId: identity.workspaceId,
      purpose: 'analytics-activation',
      operationId: 'operation-2',
      restartNonce: 'restart-nonce-1',
      terminalRestartReceiptPath: path.join(root, 'receipt.json'),
      ...restartFields(),
    }, KEY);
    await handler.restart(verifyControlledRestartRequest(JSON.parse(JSON.stringify(request)), KEY));
    const record = readPendingControlledRestart(stateDir, identity.hostInstanceId);
    assert.ok(record, 'pending restart must be durable before the acknowledgement returns');
    assert.equal(record.restartNonce, 'restart-nonce-1');
    assert.equal(record.terminalRestartReceiptPath, path.join(root, 'receipt.json'));
    assert.equal(record.purpose, 'analytics-activation');
    assert.equal(record.workspaceId, identity.workspaceId);
    assert.deepEqual(performed, [], 'no restart may fire before the acknowledgement has flushed');
    await sleep(700);
    assert.deepEqual(performed, ['restart'], 'the quiet restart fires after the bounded delay');
    assert.ok(isPendingControlledRestartConsumable(record, record.issuedAtMs + 1));
    assert.equal(isPendingControlledRestartConsumable(record, record.expiresAtMs + 1), false);
    consumePendingControlledRestart(stateDir, identity.hostInstanceId);
    assert.equal(pendingControlledRestartExists(stateDir, identity.hostInstanceId), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('successor boots claim distinct host-scoped pending records without sharing keys or evidence paths', () => {
  const root = temporaryRoot('claims');
  try {
    const stateDir = path.join(root, 'state');
    const first = {
      schemaVersion: 1 as const,
      purpose: 'analytics-activation' as const,
      workspaceId: identity.workspaceId,
      operationId: 'operation-claims',
      predecessorHostInstanceId: 'host-predecessor-a',
      successorHandoffKey: 'successor-key-a',
      loadedGenerationPath: path.join(root, 'loaded-a.json'),
      successorCapabilities: [],
      evidenceOwner: true,
      restartNonce: 'restart-claims',
      terminalRestartReceiptPath: path.join(root, 'receipt-a.json'),
      issuedAtMs: 0,
      expiresAtMs: 5_000,
    };
    const second = {
      ...first,
      predecessorHostInstanceId: 'host-predecessor-b',
      successorHandoffKey: 'successor-key-b',
      loadedGenerationPath: path.join(root, 'loaded-b.json'),
      terminalRestartReceiptPath: path.join(root, 'receipt-b.json'),
      evidenceOwner: false,
    };
    writePendingControlledRestartAtomically(stateDir, first);
    writePendingControlledRestartAtomically(stateDir, second);
    const claimed = [claimPendingControlledRestart(stateDir, 1), claimPendingControlledRestart(stateDir, 1)];
    assert.equal(claimed[0]?.successorHandoffKey === claimed[1]?.successorHandoffKey, false);
    assert.notEqual(claimed[0]?.loadedGenerationPath, claimed[1]?.loadedGenerationPath);
    assert.equal(claimPendingControlledRestart(stateDir, 1), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a newer signed request supersedes the pending slot and re-arms the restart', async () => {
  const root = temporaryRoot('supersede');
  try {
    const stateDir = path.join(root, 'state');
    const performed: string[] = [];
    const handler = createAnalyticsHostControlledRestart({
      stateDir,
      identity,
      performRestart: () => performed.push('restart'),
    });
    const first = createControlledRestartRequest({
      workspaceId: identity.workspaceId,
      purpose: 'analytics-activation',
      operationId: 'operation-3',
      restartNonce: 'restart-nonce-a',
      terminalRestartReceiptPath: path.join(root, 'receipt-a.json'),
      ...restartFields(),
    }, KEY);
    const second = createControlledRestartRequest({
      workspaceId: identity.workspaceId,
      purpose: 'storage-cutoff',
      operationId: 'operation-4',
      restartNonce: 'restart-nonce-b',
      terminalRestartReceiptPath: path.join(root, 'receipt-b.json'),
      ...restartFields(),
    }, KEY);
    await handler.restart(verifyControlledRestartRequest(JSON.parse(JSON.stringify(first)), KEY));
    await handler.restart(verifyControlledRestartRequest(JSON.parse(JSON.stringify(second)), KEY));
    const record = readPendingControlledRestart(stateDir, identity.hostInstanceId);
    assert.ok(record);
    assert.equal(record.restartNonce, 'restart-nonce-b');
    assert.equal(record.terminalRestartReceiptPath, path.join(root, 'receipt-b.json'));
    await sleep(700);
    assert.deepEqual(performed, ['restart'], 'only the superseding restart may fire');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the authenticated control endpoint serves signed restart requests and advertises the capability', async () => {
  const root = temporaryRoot('endpoint');
  const store = temporaryStore(root);
  const stateDir = path.join(root, 'state');
  try {
    const performed: string[] = [];
    const control = new AnalyticsHandoffControl({
      registry: store,
      identity: { ...identity, capabilities: ['host-discovery', 'host-status'] },
      key: KEY,
      pipeName: createAnalyticsHandoffPipeName(identity.workspaceId, identity.hostInstanceId),
      now: () => 100,
      restart: createAnalyticsHostControlledRestart({
        stateDir,
        identity,
        performRestart: () => performed.push('restart'),
        schedule: () => () => undefined,
      }),
    });
    await control.start();
    assert.equal(control.isAvailable, true);
    const registered = store.getAnalyticsHost(identity.hostInstanceId);
    assert.equal(registered?.capabilities.includes('controlled-restart'), true);

    const request = createControlledRestartRequest({
      workspaceId: identity.workspaceId,
      purpose: 'storage-cutoff',
      operationId: 'operation-5',
      restartNonce: 'restart-nonce-endpoint',
      terminalRestartReceiptPath: path.join(root, 'receipt.json'),
      ...restartFields(),
    }, KEY, { requestId: 'req-endpoint', nonce: 'frame-endpoint', issuedAtMs: 100, expiresAtMs: 5_000 });
    const response = verifyControlledRestartResponse(await sendFrame(control.endpointName!, request), KEY);
    assert.equal(response.ok, true);
    assert.equal(response.host.hostInstanceId, identity.hostInstanceId);
    assert.equal(response.pendingRestartRecorded, true);
    assert.equal(response.restartScheduled, true);
    assert.equal(readPendingControlledRestart(stateDir, identity.hostInstanceId)?.restartNonce, 'restart-nonce-endpoint');
    assert.deepEqual(performed, []);

    // A replayed frame is refused with a signed error, not a replayed ack.
    const replayed = await sendFrame(control.endpointName!, request);
    const verifiedReplay = verifyControlledRestartResponse(replayed, KEY);
    assert.equal(verifiedReplay.ok, false);
    assert.match(verifiedReplay.error ?? '', /nonce was replayed/);

    const unsigned = { ...JSON.parse(JSON.stringify(request)), mac: 'invalid' };
    const rejected = await sendFrame(control.endpointName!, unsigned);
    const verifiedRejection = verifyControlledRestartResponse(rejected, KEY);
    assert.equal(verifiedRejection.ok, false);

    const foreign = createControlledRestartRequest({
      workspaceId: 'other-workspace',
      purpose: 'storage-cutoff',
      operationId: 'operation-5',
      restartNonce: 'restart-nonce-foreign',
      terminalRestartReceiptPath: path.join(root, 'receipt.json'),
      ...restartFields(),
    }, KEY, { issuedAtMs: 100, expiresAtMs: 5_000 });
    const foreignResponse = await sendFrame(control.endpointName!, foreign);
    const verifiedForeign = verifyControlledRestartResponse(foreignResponse, KEY);
    assert.equal(verifiedForeign.ok, false);
    assert.match(verifiedForeign.error ?? '', /workspace identity does not match/);
    await control.stop();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the control endpoint without a restart handler rejects restart frames and hides the capability', async () => {
  const root = temporaryRoot('endpoint-absent');
  const store = temporaryStore(root);
  const stateDir = path.join(root, 'state');
  const absentIdentity = distinctIdentity('absent');
  try {
    const control = new AnalyticsHandoffControl({
      registry: store,
      identity: { ...absentIdentity, capabilities: ['host-discovery', 'host-status'] },
      key: KEY,
      pipeName: createAnalyticsHandoffPipeName(absentIdentity.workspaceId, absentIdentity.hostInstanceId),
      now: () => 100,
    });
    await control.start();
    assert.equal(control.isAvailable, true);
    const registered = store.getAnalyticsHost(absentIdentity.hostInstanceId);
    assert.equal(registered?.capabilities.includes('controlled-restart'), false);
    const request = createControlledRestartRequest({
      workspaceId: absentIdentity.workspaceId,
      purpose: 'analytics-activation',
      operationId: 'operation-6',
      restartNonce: 'restart-nonce-absent',
      terminalRestartReceiptPath: path.join(root, 'receipt.json'),
      ...restartFields(absentIdentity.hostInstanceId),
    }, KEY, { issuedAtMs: 100, expiresAtMs: 5_000 });
    const rejected = await sendFrame(control.endpointName!, request);
    const verified = verifyControlledRestartResponse(rejected, KEY);
    assert.equal(verified.ok, false);
    assert.match(verified.error ?? '', /controlled-restart handler is unavailable/);
    assert.equal(pendingControlledRestartExists(stateDir, absentIdentity.hostInstanceId), false);
    await control.stop();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the pending slot reader treats malformed slots as absent', () => {
  const root = temporaryRoot('malformed');
  try {
    const stateDir = path.join(root, 'state');
    const destination = path.join(stateDir, PENDING_CONTROLLED_RESTART_FILENAME);
    const valid = {
      schemaVersion: 1,
      purpose: 'analytics-activation',
      workspaceId: identity.workspaceId,
      operationId: 'operation-6',
      predecessorHostInstanceId: identity.hostInstanceId,
      successorHandoffKey: KEY,
      loadedGenerationPath: path.join(root, 'loaded.json'),
      successorCapabilities: [],
      evidenceOwner: true,
      restartNonce: 'restart-nonce-malformed',
      terminalRestartReceiptPath: path.join(root, 'receipt.json'),
      issuedAtMs: 0,
      expiresAtMs: 5 * 60 * 1_000,
    };
    for (const broken of [
      'not json',
      JSON.stringify({ ...valid, extra: 1 }),
      JSON.stringify({ ...valid, schemaVersion: 2 }),
      JSON.stringify({ ...valid, restartNonce: 'bad nonce!' }),
      JSON.stringify({ ...valid, terminalRestartReceiptPath: 'relative/receipt.json' }),
    ]) {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(destination, `${broken}\n`);
      assert.equal(readPendingControlledRestart(stateDir), undefined, broken.slice(0, 40));
    }
    rmSync(destination, { force: true });
    assert.equal(readPendingControlledRestart(stateDir), undefined);
    assert.equal(existsSync(destination), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});