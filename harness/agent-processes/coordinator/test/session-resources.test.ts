import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeSessionResourceName, SessionResourceRegistry, type SessionResourceLeaseView } from '../session-resources.js';

const epoch = 1_800_000_000_000;

function setup() {
  let now = epoch;
  return {
    registry: new SessionResourceRegistry(() => now),
    advance(ms: number) { now += ms; },
    get now() { return now; },
  };
}

function acquiredLease(result: ReturnType<SessionResourceRegistry['execute']>): SessionResourceLeaseView {
  assert.equal(result.action, 'acquire');
  assert.equal(result.outcome, 'acquired');
  return result.lease;
}

function resourceHolders(registry: SessionResourceRegistry, name: string): readonly SessionResourceLeaseView[] {
  const result = registry.execute({ owner: 'reader', action: 'status', name });
  assert.equal(result.action, 'status');
  return result.resources[0]?.holders ?? [];
}

test('resource names use one trimmed lowercase Unicode-codepoint bound', () => {
  assert.equal(normalizeSessionResourceName('  Repo:PiE  '), 'repo:pie');
  assert.equal(normalizeSessionResourceName('界'.repeat(60)), '界'.repeat(60));
  assert.equal(normalizeSessionResourceName('🙂'.repeat(96)), '🙂'.repeat(96));
  assert.equal(normalizeSessionResourceName('İ'.repeat(48)), 'i\u0307'.repeat(48));
  assert.throws(() => normalizeSessionResourceName('x'.repeat(97)), /96 Unicode characters/u);
  assert.throws(() => normalizeSessionResourceName('İ'.repeat(49)), /after lowercase normalization/u);
});

test('exclusive reservations contend while shared reservations coexist', () => {
  const { registry } = setup();
  const first = acquiredLease(registry.execute({ owner: 'a', action: 'acquire', name: 'repo:pie', purpose: 'inspect' }));
  const busy = registry.execute({ owner: 'b', action: 'acquire', name: 'repo:pie', purpose: 'build' });
  assert.equal(busy.action, 'acquire');
  assert.equal(busy.outcome, 'busy');
  assert.equal(busy.conflicts[0]?.leaseId, first.leaseId);

  registry.execute({ owner: 'a', action: 'release', leaseId: first.leaseId });
  const readA = acquiredLease(registry.execute({ owner: 'a', action: 'acquire', name: 'repo:pie', purpose: 'read A', mode: 'shared' }));
  const readB = acquiredLease(registry.execute({ owner: 'b', action: 'acquire', name: 'repo:pie', purpose: 'read B', mode: 'shared' }));
  const writer = registry.execute({ owner: 'c', action: 'acquire', name: 'repo:pie', purpose: 'write' });
  assert.equal(writer.action, 'acquire');
  assert.equal(writer.outcome, 'busy');
  assert.deepEqual(new Set(writer.conflicts.map((lease) => lease.leaseId)), new Set([readA.leaseId, readB.leaseId]));
});

test('a queued grant must start before its deadline; an expired grant stops conflicting', () => {
  const clock = setup();
  const lease = acquiredLease(clock.registry.execute({
    owner: 'a', action: 'acquire', name: 'fixture:server', purpose: 'run browser fixture',
    ttlMs: 20_000, startWithinMs: 3_000,
  }));
  assert.equal(lease.state, 'reserved');
  assert.equal(lease.startBy, epoch + 3_000);
  clock.advance(3_000);
  assert.throws(() => clock.registry.execute({ owner: 'a', action: 'start', leaseId: lease.leaseId }), /expired before start/u);
  assert.equal(resourceHolders(clock.registry, 'fixture:server').length, 0);
  const fresh = acquiredLease(clock.registry.execute({ owner: 'b', action: 'acquire', name: 'fixture:server', purpose: 'fresh grant' }));
  assert.notEqual(fresh.leaseId, lease.leaseId);
});

test('active expiry remains conflicting until explicit release or confirmed reclaim', () => {
  const clock = setup();
  const lease = acquiredLease(clock.registry.execute({
    owner: 'a', action: 'acquire', name: 'repo:snapshot', purpose: 'take snapshot', ttlMs: 2_000,
  }));
  const started = clock.registry.execute({ owner: 'a', action: 'start', leaseId: lease.leaseId });
  assert.equal(started.action, 'start');
  assert.equal(started.lease.expiresAt, epoch + 2_000);
  clock.advance(2_000);
  const holders = resourceHolders(clock.registry, 'repo:snapshot');
  assert.equal(holders[0]?.state, 'expired-active');
  const next = clock.registry.execute({ owner: 'b', action: 'acquire', name: 'repo:snapshot', purpose: 'new snapshot' });
  assert.equal(next.action, 'acquire');
  assert.equal(next.outcome, 'busy');

  assert.throws(() => clock.registry.execute({ owner: 'a', action: 'renew', leaseId: lease.leaseId, ttlMs: 5_000 }), /cannot renew/u);
  assert.throws(() => clock.registry.execute({ owner: 'b', action: 'reclaim', leaseId: lease.leaseId, reason: 'looked old' }), /confirmStopped/u);
  const reclaimed = clock.registry.execute({
    owner: 'b', action: 'reclaim', leaseId: lease.leaseId, reason: 'verified fixture process exited', confirmStopped: true,
  });
  assert.equal(reclaimed.action, 'reclaim');
  assert.equal(reclaimed.lease.state, 'reclaimed');
  assert.equal(reclaimed.lease.reclaimReason, 'verified fixture process exited');
  const replacement = acquiredLease(clock.registry.execute({ owner: 'b', action: 'acquire', name: 'repo:snapshot', purpose: 'new snapshot' }));
  assert.notEqual(replacement.leaseId, lease.leaseId);
});

test('renewal extends only a live owner lease; release is owner-scoped and idempotent', () => {
  const clock = setup();
  const lease = acquiredLease(clock.registry.execute({
    owner: 'stable-owner', ownerAddress: 'Research', action: 'acquire', name: 'machine:memory', purpose: 'reserve memory', ttlMs: 5_000,
  }));
  clock.registry.execute({ owner: 'stable-owner', action: 'start', leaseId: lease.leaseId });
  clock.advance(2_000);
  const renewed = clock.registry.execute({ owner: 'stable-owner', action: 'renew', leaseId: lease.leaseId, ttlMs: 7_000 });
  assert.equal(renewed.action, 'renew');
  assert.equal(renewed.lease.ttlMs, 7_000, 'renewed duration metadata agrees with the new expiry');
  assert.equal(renewed.lease.expiresAt, epoch + 9_000);
  assert.throws(() => clock.registry.execute({ owner: 'intruder', action: 'release', leaseId: lease.leaseId }), /another owner/u);
  const released = clock.registry.execute({ owner: 'stable-owner', action: 'release', leaseId: lease.leaseId });
  assert.equal(released.action, 'release');
  assert.equal(released.outcome, 'released');
  const repeated = clock.registry.execute({ owner: 'stable-owner', action: 'release', leaseId: lease.leaseId });
  assert.equal(repeated.action, 'release');
  assert.equal(repeated.outcome, 'already_released');
  assert.equal(resourceHolders(clock.registry, 'machine:memory').length, 0);
});

test('retiring an owner expires reservations but leaves started work orphaned and conflicting', () => {
  const clock = setup();
  const reserved = acquiredLease(clock.registry.execute({ owner: 'worker-a', action: 'acquire', name: 'path:a', purpose: 'edit A' }));
  const active = acquiredLease(clock.registry.execute({ owner: 'worker-a', action: 'acquire', name: 'path:b', purpose: 'edit B' }));
  clock.registry.execute({ owner: 'worker-a', action: 'start', leaseId: active.leaseId });
  clock.registry.retireOwner('worker-a');
  assert.equal(resourceHolders(clock.registry, 'path:a').length, 0);
  assert.equal(resourceHolders(clock.registry, 'path:b')[0]?.state, 'orphaned');
  const busy = clock.registry.execute({ owner: 'worker-b', action: 'acquire', name: 'path:b', purpose: 'edit B' });
  assert.equal(busy.action, 'acquire');
  assert.equal(busy.outcome, 'busy');
  assert.throws(() => clock.registry.execute({ owner: 'worker-a', action: 'start', leaseId: reserved.leaseId }), /expired before start/u);
  assert.equal(clock.registry.execute({ owner: 'worker-a', action: 'status', name: 'path:b' }).action, 'status');
});

test('status is bounded and acquisition enforces resource and holder caps', () => {
  const { registry } = setup();
  for (let index = 0; index < 128; index += 1) {
    registry.execute({ owner: `owner-${index}`, action: 'acquire', name: `resource-${index}`, purpose: 'bounded' });
  }
  assert.throws(() => registry.execute({ owner: 'last', action: 'acquire', name: 'resource-128', purpose: 'bounded' }), /resource capacity/u);

  const second = setup().registry;
  for (let index = 0; index < 256; index += 1) {
    second.execute({ owner: `owner-${index}`, action: 'acquire', name: 'shared:capacity', purpose: 'bounded', mode: 'shared' });
  }
  assert.throws(() => second.execute({ owner: 'last', action: 'acquire', name: 'shared:capacity', purpose: 'bounded', mode: 'shared' }), /holder capacity/u);
  const status = second.execute({ owner: 'reader', action: 'status' });
  assert.equal(status.action, 'status');
  assert.equal(status.resources.length, 1);
  assert.equal(status.resources[0]?.holders.length, 256);
});

test('names, purposes, lease durations, and reclaim reasons are bounded', () => {
  const { registry } = setup();
  assert.throws(() => registry.execute({ owner: 'a', action: 'acquire', name: '', purpose: 'x' }), /name must/u);
  assert.throws(() => registry.execute({ owner: 'a', action: 'acquire', name: 'r', purpose: 'x'.repeat(241) }), /purpose must/u);
  assert.throws(() => registry.execute({ owner: 'a', action: 'acquire', name: 'r', purpose: 'x', ttlMs: 0 }), /ttlMs must/u);
  assert.throws(() => registry.execute({ owner: 'a', action: 'acquire', name: 'r', purpose: 'x', startWithinMs: 600_000 }), /startWithinMs must/u);
});

test('purpose and reclaim reason limits count Unicode code points after trimming', () => {
  const { registry } = setup();
  const exact = '🙂'.repeat(240);
  const acquired = acquiredLease(registry.execute({
    owner: 'owner', action: 'acquire', name: 'unicode:purpose', purpose: ` ${exact} `,
  }));
  assert.equal(acquired.purpose, exact);
  registry.execute({ owner: 'owner', action: 'start', leaseId: acquired.leaseId });
  registry.retireOwner('owner');
  const reclaimed = registry.execute({
    owner: 'recovery', action: 'reclaim', leaseId: acquired.leaseId,
    reason: ` ${exact} `, confirmStopped: true,
  });
  assert.equal(reclaimed.action, 'reclaim');
  assert.equal(reclaimed.lease.reclaimReason, exact);

  assert.throws(() => registry.execute({
    owner: 'another', action: 'acquire', name: 'unicode:too-long-purpose', purpose: '🙂'.repeat(241),
  }), /240 Unicode characters/u);
  const active = acquiredLease(registry.execute({
    owner: 'active', action: 'acquire', name: 'unicode:reason', purpose: 'work',
  }));
  registry.execute({ owner: 'active', action: 'start', leaseId: active.leaseId });
  registry.retireOwner('active');
  assert.throws(() => registry.execute({
    owner: 'recovery', action: 'reclaim', leaseId: active.leaseId,
    reason: '🙂'.repeat(241), confirmStopped: true,
  }), /240 Unicode characters/u);
});

test('availability events are committed, release wakes contenders, and renewal/start do not', () => {
  const { registry } = setup();
  const changes: Array<{ name: string; revision: number; cause: string }> = [];
  const unsubscribe = registry.subscribeAvailability(change => {
    changes.push(change);
    assert.equal(registry.isCompatible(change.name), true, 'listeners see committed availability');
  });
  const lease = acquiredLease(registry.execute({ owner: 'a', action: 'acquire', name: 'gpu:0', purpose: 'render', ttlMs: 5_000 }));
  registry.execute({ owner: 'a', action: 'start', leaseId: lease.leaseId });
  registry.execute({ owner: 'a', action: 'renew', leaseId: lease.leaseId, ttlMs: 6_000 });
  assert.deepEqual(changes, [], 'acquire/start/renew do not tell contenders availability increased');

  registry.execute({ owner: 'a', action: 'release', leaseId: lease.leaseId });
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0], { name: 'gpu:0', revision: 1, cause: 'released' });
  const status = registry.execute({ owner: 'reader', action: 'status', name: 'gpu:0' });
  assert.equal(status.action, 'status');
  assert.equal(status.revision, changes[0]?.revision);
  unsubscribe();
});

test('shared availability wakes compatible readers but waits for all readers before an exclusive writer', () => {
  const { registry } = setup();
  const first = acquiredLease(registry.execute({ owner: 'a', action: 'acquire', name: 'checkout:pie', purpose: 'read', mode: 'shared' }));
  const second = acquiredLease(registry.execute({ owner: 'b', action: 'acquire', name: 'checkout:pie', purpose: 'read', mode: 'shared' }));
  const changes: string[] = [];
  registry.subscribeAvailability(change => changes.push(change.name));
  assert.equal(registry.isCompatible('checkout:pie', 'shared'), true);
  assert.equal(registry.isCompatible('checkout:pie', 'exclusive'), false);

  registry.execute({ owner: 'a', action: 'release', leaseId: first.leaseId });
  assert.deepEqual(changes, ['checkout:pie']);
  assert.equal(registry.isCompatible('checkout:pie', 'shared'), true);
  assert.equal(registry.isCompatible('checkout:pie', 'exclusive'), false);
  registry.execute({ owner: 'b', action: 'release', leaseId: second.leaseId });
  assert.deepEqual(changes, ['checkout:pie', 'checkout:pie']);
  assert.equal(registry.isCompatible('checkout:pie', 'exclusive'), true);
});

test('reserved deadline expiry and retired reservations notify, active expiry and orphaning do not', () => {
  const clock = setup();
  const reserved = acquiredLease(clock.registry.execute({ owner: 'reserved-owner', action: 'acquire', name: 'path:reserved', purpose: 'edit', startWithinMs: 1_000 }));
  const active = acquiredLease(clock.registry.execute({ owner: 'active-owner', action: 'acquire', name: 'path:active', purpose: 'edit', ttlMs: 1_000 }));
  clock.registry.execute({ owner: 'active-owner', action: 'start', leaseId: active.leaseId });
  const changes: Array<{ name: string; cause: string }> = [];
  clock.registry.subscribeAvailability(change => changes.push({ name: change.name, cause: change.cause }));

  assert.equal(clock.registry.nextReservedExpiry(), reserved.startBy);
  clock.advance(1_000);
  clock.registry.sweepExpired();
  assert.deepEqual(changes, [{ name: 'path:reserved', cause: 'reserved-expired' }]);
  assert.equal(clock.registry.isCompatible('path:reserved'), true);
  assert.equal(clock.registry.isCompatible('path:active'), false);

  clock.registry.retireOwner('active-owner');
  assert.deepEqual(changes, [{ name: 'path:reserved', cause: 'reserved-expired' }], 'orphaning active work is not availability');
  const reclaimed = clock.registry.execute({ owner: 'recovery', action: 'reclaim', leaseId: active.leaseId, reason: 'verified process stopped', confirmStopped: true });
  assert.equal(reclaimed.action, 'reclaim');
  assert.deepEqual(changes, [
    { name: 'path:reserved', cause: 'reserved-expired' },
    { name: 'path:active', cause: 'reclaimed' },
  ]);
  assert.equal(clock.registry.nextReservedExpiry(), undefined);
});

test('retiring an unstarted owner reservation emits availability after the reservation is removed', () => {
  const { registry } = setup();
  const reserved = acquiredLease(registry.execute({ owner: 'closing-owner', action: 'acquire', name: 'checkout:pie', purpose: 'edit' }));
  const changes: Array<{ name: string; cause: string }> = [];
  registry.subscribeAvailability(change => changes.push({ name: change.name, cause: change.cause }));
  registry.retireOwner('closing-owner');
  assert.deepEqual(changes, [{ name: 'checkout:pie', cause: 'owner-retired' }]);
  assert.equal(registry.isCompatible('checkout:pie'), true);
  assert.throws(() => registry.execute({ owner: 'closing-owner', action: 'start', leaseId: reserved.leaseId }), /expired before start/u);
});

test('owner display metadata accepts canonical address sizes and stays immutable', () => {
  const { registry } = setup();
  const address = 'x'.repeat(768);
  const lease = acquiredLease(registry.execute({
    owner: 'stable-owner', ownerAddress: address, ownerTitle: 'A'.repeat(256),
    action: 'acquire', name: 'checkout:metadata', purpose: 'read',
  }));
  assert.equal(lease.ownerAddress, address);
  assert.equal(lease.ownerTitle, 'A'.repeat(256));
  assert.throws(() => registry.execute({
    owner: 'bad-address', ownerAddress: `${'x'.repeat(767)}é`,
    action: 'acquire', name: 'checkout:bad-address', purpose: 'read',
  }), /768 bytes/u);
  assert.throws(() => registry.execute({
    owner: 'bad-title', ownerTitle: 'T'.repeat(257),
    action: 'acquire', name: 'checkout:bad-title', purpose: 'read',
  }), /256 bytes/u);
});

test('private owner deletion redacts active tombstones while preserving conflict and reclaim by exact lease ID', () => {
  const { registry } = setup();
  const lease = acquiredLease(registry.execute({
    owner: 'deleted-owner', ownerAddress: 'reply-ref', ownerTitle: 'Private title',
    action: 'acquire', name: 'shared:file', purpose: 'editing confidential file',
  }));
  registry.execute({ owner: 'deleted-owner', action: 'start', leaseId: lease.leaseId });
  registry.retireOwner('deleted-owner', { deleted: true });

  const holder = resourceHolders(registry, 'shared:file')[0];
  assert.equal(holder?.leaseId, lease.leaseId);
  assert.equal(holder?.state, 'orphaned');
  assert.equal(holder?.ownerDeleted, true);
  assert.equal(holder?.ownerAddress, undefined);
  assert.equal(holder?.ownerTitle, undefined);
  assert.equal(holder?.purpose, undefined);
  const busy = registry.execute({ owner: 'new-peer', action: 'acquire', name: 'shared:file', purpose: 'new work' });
  assert.equal(busy.action, 'acquire');
  assert.equal(busy.outcome, 'busy');
  assert.equal(busy.conflicts[0]?.leaseId, lease.leaseId);
  assert.equal(busy.conflicts[0]?.ownerDeleted, true);

  const reclaimed = registry.execute({
    owner: 'recovery-peer', action: 'reclaim', leaseId: lease.leaseId,
    reason: 'verified the old operation stopped', confirmStopped: true,
  });
  assert.equal(reclaimed.action, 'reclaim');
  assert.equal(reclaimed.lease.leaseId, lease.leaseId);
  assert.equal(reclaimed.lease.state, 'reclaimed');
  assert.equal(reclaimed.lease.ownerDeleted, true);
  assert.equal(reclaimed.lease.ownerAddress, undefined);
  assert.equal(reclaimed.lease.ownerTitle, undefined);
  assert.equal(reclaimed.lease.purpose, undefined);
  assert.equal(reclaimed.lease.reclaimReason, 'verified the old operation stopped');
  assert.equal(registry.isCompatible('shared:file'), true);
});

test('private deletion redacts retained terminal receipts and frees deleted unstarted grants', () => {
  const { registry } = setup();
  const released = acquiredLease(registry.execute({
    owner: 'deleted-owner', ownerAddress: 'private-address', ownerTitle: 'Private worker',
    action: 'acquire', name: 'terminal:receipt', purpose: 'private purpose',
  }));
  registry.execute({ owner: 'deleted-owner', action: 'release', leaseId: released.leaseId });
  const reserved = acquiredLease(registry.execute({
    owner: 'deleted-owner', ownerAddress: 'private-address', ownerTitle: 'Private worker',
    action: 'acquire', name: 'reserved:delete', purpose: 'private purpose',
  }));
  registry.retireOwner('deleted-owner', { deleted: true });

  const terminalReceipt = registry.execute({ owner: 'deleted-owner', action: 'release', leaseId: released.leaseId });
  assert.equal(terminalReceipt.action, 'release');
  assert.equal(terminalReceipt.outcome, 'already_released');
  assert.equal(terminalReceipt.lease.ownerDeleted, true);
  assert.equal(terminalReceipt.lease.ownerAddress, undefined);
  assert.equal(terminalReceipt.lease.ownerTitle, undefined);
  assert.equal(terminalReceipt.lease.purpose, undefined);

  assert.equal(resourceHolders(registry, 'reserved:delete').length, 0);
  const replacement = acquiredLease(registry.execute({
    owner: 'replacement', action: 'acquire', name: 'reserved:delete', purpose: 'fresh purpose',
  }));
  assert.notEqual(replacement.leaseId, reserved.leaseId);
  assert.throws(() => registry.execute({ owner: 'deleted-owner', action: 'start', leaseId: reserved.leaseId }), /expired before start/u);
});
