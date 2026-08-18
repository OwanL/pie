/**
 * Pending-command store tests (browser server plan §5.2/§5.3): bounded
 * tracking, ack/status resolution, snapshot confirmation, sessionStorage
 * mirroring (metadata only — never payloads), and staging release.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { WebviewToHostMessage } from '../../../src/shared/protocol';

// Side-effect first: install the fake `window.sessionStorage` BEFORE the
// store singleton is constructed (imports run in order).
import { storageWrites } from './setup-session-storage';
import { pendingCommandStore } from '../../../src/webview/transport/pending-command-store';

function command(overrides: Partial<Extract<WebviewToHostMessage, { type: 'newSession' }>> = {}): WebviewToHostMessage {
  return { type: 'newSession', ...overrides } as WebviewToHostMessage;
}

function imageInput(): WebviewToHostMessage {
  return {
    type: 'addComposerInput',
    sessionPath: '/session/a',
    input: {
      kind: 'imageBlob',
      mimeType: 'image/png',
      name: 'shot.png',
      sizeBytes: 1234,
      source: 'paste',
      dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    },
  } as WebviewToHostMessage;
}

test('track(): mints a clientCommandId, stamps it, and records a pending entry', () => {
  const tracked = pendingCommandStore.track(command());
  assert.ok(tracked, 'the store accepts the command');
  const stamped = tracked?.message as Extract<WebviewToHostMessage, { type: 'newSession' }> & { clientCommandId: string };
  assert.match(stamped.clientCommandId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const entry = pendingCommandStore.lookup(stamped.clientCommandId);
  assert.equal(entry?.decision, 'pending');
  assert.equal(entry?.type, 'newSession');
});

test('track(): non-application messages are never tracked', () => {
  assert.equal(pendingCommandStore.track({ type: 'ready', viewGeneration: 1 } as WebviewToHostMessage), null);
  assert.equal(pendingCommandStore.track({ type: 'refreshState' } as WebviewToHostMessage), null);
});

test('onAck(): accepted resolves the entry and releases staging; rejected records the reason', () => {
  const tracked = pendingCommandStore.track(imageInput());
  const id = (tracked?.message as { clientCommandId: string }).clientCommandId;
  assert.equal(pendingCommandStore.lookup(id)?.decision, 'pending');

  pendingCommandStore.onAck(id, 'accepted');
  assert.equal(pendingCommandStore.lookup(id)?.decision, 'accepted');
  assert.equal(pendingCommandStore.takeStagedInput(id), null, 'accepted staging is released');

  const rejected = pendingCommandStore.track(command());
  const rejectedId = (rejected?.message as { clientCommandId: string }).clientCommandId;
  pendingCommandStore.onAck(rejectedId, 'rejected', 'session-not-open');
  assert.equal(pendingCommandStore.lookup(rejectedId)?.decision, 'rejected');
  assert.equal(pendingCommandStore.lookup(rejectedId)?.reason, 'session-not-open');
});

test('onStatus(): unknown answers keep the entry for read-only reconciliation', () => {
  const tracked = pendingCommandStore.track(command());
  const id = (tracked?.message as { clientCommandId: string }).clientCommandId;
  pendingCommandStore.onStatus(id, 'unknown');
  assert.equal(pendingCommandStore.lookup(id)?.decision, 'unknown');
  assert.ok(pendingCommandStore.unknownEntries().some((entry) => entry.clientCommandId === id));
});

test('confirmAcceptedBySnapshot(): matching input metadata confirms early; absence never rejects', () => {
  const tracked = pendingCommandStore.track(imageInput());
  const id = (tracked?.message as { clientCommandId: string }).clientCommandId;

  // Absence alone: still pending.
  pendingCommandStore.confirmAcceptedBySnapshot([]);
  assert.equal(pendingCommandStore.lookup(id)?.decision, 'pending');

  // Matching metadata in the host-owned pending inputs confirms acceptance.
  pendingCommandStore.confirmAcceptedBySnapshot([{
    id: 'input-1',
    kind: 'imageBlob',
    mimeType: 'image/png',
    name: 'shot.png',
    sizeBytes: 1234,
    dataBase64: 'iVBORw0KGgo=',
    source: 'paste',
  }]);
  assert.equal(pendingCommandStore.lookup(id)?.decision, 'accepted');
  assert.equal(pendingCommandStore.takeStagedInput(id), null, 'snapshot-confirmed staging is released');
});

test('takeStagedInput(): restores the draft for a never-accepted input (never replayed)', () => {
  const tracked = pendingCommandStore.track(imageInput());
  const id = (tracked?.message as { clientCommandId: string }).clientCommandId;
  const draft = pendingCommandStore.takeStagedInput(id);
  assert.equal(draft?.kind, 'imageBlob');
  assert.equal(draft?.name, 'shot.png');
  assert.equal(pendingCommandStore.takeStagedInput(id), null, 'staging is single-use');
});

test('the store is bounded: capacity evicts the oldest entries and their staging', () => {
  const first = pendingCommandStore.track(imageInput());
  const firstId = (first?.message as { clientCommandId: string }).clientCommandId;
  for (let index = 0; index < 40; index += 1) {
    pendingCommandStore.track(command());
  }
  assert.ok(pendingCommandStore.size() <= 32, 'capacity is bounded');
  assert.equal(pendingCommandStore.lookup(firstId), undefined, 'the oldest entry is evicted');
  assert.equal(pendingCommandStore.takeStagedInput(firstId), null, 'evicted staging is released');
});

test('the sessionStorage mirror holds metadata only — never base64 payloads', () => {
  const before = storageWrites.length;
  const tracked = pendingCommandStore.track(imageInput());
  const id = (tracked?.message as { clientCommandId: string }).clientCommandId;
  const mirror = storageWrites[storageWrites.length - 1] ?? '';
  assert.ok(storageWrites.length > before, 'a mirror write happened');
  assert.ok(mirror.includes(id), 'the mirror carries the clientCommandId');
  assert.ok(mirror.includes('image/png'), 'the mirror carries declared metadata');
  assert.ok(!mirror.includes('iVBORw0KGgo'), 'the mirror NEVER contains base64 payload bytes');
  assert.ok(!mirror.includes('dataBase64'), 'the mirror never contains the payload field');
  assert.ok(mirror.includes('inputDigest'), 'the mirror carries a content digest instead');
});
