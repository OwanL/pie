import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';

import {
  appendTriggerOp,
  DeferredTriggerStore,
  readTriggerOps,
  replayTriggers,
  type TriggerOp,
} from '../../../src/host/deferred-triggers/store';

/**
 * deferred-triggers store: sidecar append/read + pure replay semantics.
 *
 * The replay is the load-bearing logic (shared conceptually with the
 * `defer_trigger` tool's own `list` action), so it gets the bulk of the tests:
 * register sets, fire deletes, cancel-with-targetId deletes one, cancel-all
 * deletes every trigger for a session, and a fire-then-reregister cycle
 * re-arms correctly.
 */

let dir: string;
let savedSessionDirEnv: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-deferred-triggers-store-test-'));
  // Point the shared derivation at <dir>/sessions so the sidecar lands at
  // <dir>/deferred-triggers/triggers.jsonl.
  savedSessionDirEnv = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_SESSION_DIR = path.join(dir, 'sessions');
});

afterEach(() => {
  if (savedSessionDirEnv === undefined) {
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
  } else {
    process.env.PI_CODING_AGENT_SESSION_DIR = savedSessionDirEnv;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function register(id: string, sessionPath: string, triggers: unknown[], note = '', at = new Date().toISOString()): TriggerOp {
  return { id, op: 'register', sessionPath, triggers: triggers as never, note, at };
}

test('replay: register adds, fire removes the same id', () => {
  const ops: TriggerOp[] = [
    register('a', '/w.jsonl', [{ kind: 'session_finished' }]),
    { id: 'a', op: 'fire', sessionPath: '/w.jsonl', reason: 'x', at: new Date().toISOString() },
  ];
  assert.equal(replayTriggers(ops).size, 0);
});

test('replay: cancel with targetId removes only that id', () => {
  const ops: TriggerOp[] = [
    register('a', '/w.jsonl', [{ kind: 'user_input' }]),
    register('b', '/w.jsonl', [{ kind: 'user_input' }]),
    { op: 'cancel', sessionPath: '/w.jsonl', targetId: 'a', at: new Date().toISOString() },
  ];
  const map = replayTriggers(ops);
  assert.equal(map.size, 1);
  assert.ok(map.has('b'));
  assert.ok(!map.has('a'));
});

test('replay: cancel without targetId removes all triggers for that session only', () => {
  const ops: TriggerOp[] = [
    register('a', '/w.jsonl', [{ kind: 'user_input' }]),
    register('b', '/w.jsonl', [{ kind: 'timer', ms: 1000 }]),
    register('c', '/other.jsonl', [{ kind: 'user_input' }]),
    { op: 'cancel', sessionPath: '/w.jsonl', at: new Date().toISOString() },
  ];
  const map = replayTriggers(ops);
  assert.equal(map.size, 1);
  assert.ok(map.has('c'));
});

test('replay: a trigger can be registered again after firing (re-defer cycle)', () => {
  const at = new Date().toISOString();
  const ops: TriggerOp[] = [
    register('a', '/w.jsonl', [{ kind: 'session_finished' }], '', at),
    { id: 'a', op: 'fire', sessionPath: '/w.jsonl', reason: 'r', at },
    register('b', '/w.jsonl', [{ kind: 'session_finished' }], 'second', at),
  ];
  const map = replayTriggers(ops);
  assert.equal(map.size, 1);
  assert.ok(map.has('b'));
  assert.equal(map.get('b')!.note, 'second');
});

test('readTriggerOps + replay: malformed register lines are skipped, valid kept', () => {
  // `replayTriggers` trusts its input; the malformed-spec filtering happens
  // in `normalizeOp` on the read path, so this must go through `readTriggerOps`.
  const file = path.join(dir, 'deferred-triggers', 'triggers.jsonl');
  const lines = [
    { op: 'register', sessionPath: '/w.jsonl', id: 'x' }, // no triggers
    { op: 'register', sessionPath: '/w.jsonl', triggers: [{ kind: 'user_input' }] }, // no id
    { op: 'register', sessionPath: '/w.jsonl', id: 'y', triggers: [{ kind: 'bogus' }] }, // bad kind
    { op: 'register', sessionPath: '/w.jsonl', id: 'ok', triggers: [{ kind: 'user_input' }] }, // valid
  ];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  const map = replayTriggers(readTriggerOps());
  assert.equal(map.size, 1);
  assert.ok(map.has('ok'));
});

test('append + read round-trips through the sidecar file', () => {
  appendTriggerOp(register('a', '/w.jsonl', [{ kind: 'session_finished' }], 'note'));
  appendTriggerOp({ op: 'cancel', sessionPath: '/w.jsonl', at: new Date().toISOString() });
  const ops = readTriggerOps();
  assert.equal(ops.length, 2);
  assert.equal(ops[0].op, 'register');
  assert.equal(ops[0].id, 'a');
  assert.equal(ops[1].op, 'cancel');
});

test('readTriggerOps tolerates a corrupt/malformed line without throwing', () => {
  appendTriggerOp(register('a', '/w.jsonl', [{ kind: 'user_input' }]));
  const file = path.join(dir, 'deferred-triggers', 'triggers.jsonl');
  fs.appendFileSync(file, 'not json\n{"op":"fire","id":"a","sessionPath":"/w.jsonl"}\n', 'utf8');
  const ops = readTriggerOps();
  assert.equal(ops.length, 2);
  assert.equal(ops[1].op, 'fire');
});

test('two store instances racing one trigger produce one durable claim', () => {
  const file = path.join(dir, 'deferred-triggers', 'triggers.jsonl');
  const first = new DeferredTriggerStore(file);
  const second = new DeferredTriggerStore(file);
  first.append(register('a', '/w.jsonl', [{ kind: 'session_finished' }]));

  const firstClaim = first.tryClaim('a', '/w.jsonl', 'host-a', 101, 'race');
  const secondClaim = second.tryClaim('a', '/w.jsonl', 'host-b', 102, 'race');

  assert.ok(firstClaim);
  assert.equal(secondClaim, undefined);
  const active = replayTriggers(second.readOps()).get('a');
  assert.equal(active?.deliveryState, 'claimed');
  assert.equal(active?.claimId, firstClaim.claimId);
});

test('a stale claim artifact left after durable release is cleaned and remains retryable', () => {
  const file = path.join(dir, 'deferred-triggers', 'triggers.jsonl');
  const store = new DeferredTriggerStore(file);
  store.append(register('a', '/w.jsonl', [{ kind: 'session_finished' }]));
  const claim = store.tryClaim('a', '/w.jsonl', 'host-a', 101, 'attempt');
  assert.ok(claim);
  const claimName = fs.readdirSync(path.dirname(file)).find((name) => name.startsWith('triggers.jsonl.claim-'));
  assert.ok(claimName);
  const artifact = path.join(path.dirname(file), claimName);
  const artifactContent = fs.readFileSync(artifact, 'utf8');

  store.releaseClaim(claim, 'dispatch failed');
  // Simulate a crash/persistence ordering where the durable release survived
  // but removal of the already-published claim artifact did not.
  fs.writeFileSync(artifact, artifactContent, 'utf8');

  const active = replayTriggers(store.readOps()).get('a');
  assert.equal(active?.deliveryState, 'retryable');
  assert.equal(fs.existsSync(artifact), false);
});

test('a confirmed-dead pre-dispatch owner is durably recovered as explicitly retryable', () => {
  const file = path.join(dir, 'deferred-triggers', 'triggers.jsonl');
  const claimedAt = new Date('2026-09-03T10:00:00.000Z');
  const store = new DeferredTriggerStore(file, () => claimedAt);
  store.append(register('a', '/w.jsonl', [{ kind: 'session_finished' }]));
  const claim = store.tryClaim('a', '/w.jsonl', 'dead-host', 41_001, 'attempt');
  assert.ok(claim);

  const claimName = fs.readdirSync(path.dirname(file)).find((name) => name.startsWith('triggers.jsonl.claim-'));
  assert.ok(claimName);
  const artifact = JSON.parse(fs.readFileSync(path.join(path.dirname(file), claimName), 'utf8')) as Record<string, unknown>;
  assert.equal(artifact.ownerId, 'dead-host');
  assert.equal(artifact.ownerPid, 41_001);
  assert.equal(artifact.at, claimedAt.toISOString());

  const recovered = store.recoverDeadOwnerClaims((owner) => {
    assert.deepEqual(owner, { ownerId: 'dead-host', ownerPid: 41_001, claimedAt: claimedAt.toISOString() });
    return 'dead';
  });
  assert.deepEqual(recovered, ['a']);
  const active = replayTriggers(store.readOps()).get('a');
  assert.equal(active?.deliveryState, 'retryable');
  assert.equal(active?.recoveryState, 'dead-owner-recovered');
  assert.match(active?.deliveryDetail ?? '', /owner exited before dispatch/);
  assert.equal(fs.existsSync(path.join(path.dirname(file), claimName)), false);
});

test('an artifact-only dead claim remains replayably retryable after recovery', () => {
  const file = path.join(dir, 'deferred-triggers', 'triggers.jsonl');
  const store = new DeferredTriggerStore(file);
  const registerOp = register('a', '/w.jsonl', [{ kind: 'session_finished' }]);
  store.append(registerOp);
  assert.ok(store.tryClaim('a', '/w.jsonl', 'dead-host', 41_005, 'attempt'));

  // Preserve the authoritative artifact but remove the claim log record to
  // model a crash between hard-link publication and the following append.
  fs.writeFileSync(file, `${JSON.stringify(registerOp)}\n`, 'utf8');
  assert.equal(replayTriggers(store.readOps()).get('a')?.deliveryState, 'claimed');

  assert.deepEqual(store.recoverDeadOwnerClaims(() => 'dead'), ['a']);
  const active = replayTriggers(store.readOps()).get('a');
  assert.equal(active?.deliveryState, 'retryable');
  assert.equal(active?.recoveryState, 'dead-owner-recovered');
  const persisted = fs.readFileSync(file, 'utf8');
  assert.match(persisted, /"op":"claim"/);
  assert.match(persisted, /"op":"release"/);
});

test('healthy and unknown claim owners remain fail-closed', () => {
  const file = path.join(dir, 'deferred-triggers', 'triggers.jsonl');
  const store = new DeferredTriggerStore(file);
  store.append(register('healthy', '/w.jsonl', [{ kind: 'session_finished' }]));
  assert.ok(store.tryClaim('healthy', '/w.jsonl', 'live-host', 41_002, 'attempt'));
  assert.deepEqual(store.recoverDeadOwnerClaims(() => 'alive'), []);
  assert.equal(replayTriggers(store.readOps()).get('healthy')?.deliveryState, 'claimed');

  store.append(register('legacy', '/legacy.jsonl', [{ kind: 'session_finished' }]));
  store.append({
    id: 'legacy',
    op: 'claim',
    sessionPath: '/legacy.jsonl',
    claimId: 'legacy-claim',
    ownerId: 'old-host',
    reason: 'attempt',
    at: new Date().toISOString(),
  });
  let checks = 0;
  assert.deepEqual(store.recoverDeadOwnerClaims(() => { checks++; return 'unknown'; }), []);
  assert.equal(checks, 1, 'only the modern healthy claim has enough ownership data to check');
  assert.equal(replayTriggers(store.readOps()).get('legacy')?.deliveryState, 'claimed');
});

test('dead-owner recovery rechecks the dispatch boundary after liveness confirmation', () => {
  const file = path.join(dir, 'deferred-triggers', 'triggers.jsonl');
  const store = new DeferredTriggerStore(file);
  store.append(register('a', '/w.jsonl', [{ kind: 'session_finished' }]));
  const claim = store.tryClaim('a', '/w.jsonl', 'dying-host', 41_003, 'attempt');
  assert.ok(claim);

  const recovered = store.recoverDeadOwnerClaims(() => {
    // Deterministically model the owner crossing the durable boundary and
    // exiting while another registry's earlier replay is awaiting liveness.
    store.markDispatchStarted(claim);
    return 'dead';
  });

  assert.deepEqual(recovered, []);
  const active = replayTriggers(store.readOps()).get('a');
  assert.equal(active?.deliveryState, 'claimed');
  assert.equal(active?.recoveryState, 'acknowledgement-ambiguous');
});

test('a dead owner after the dispatch boundary remains acknowledgement-ambiguous and fail-closed', () => {
  const file = path.join(dir, 'deferred-triggers', 'triggers.jsonl');
  const store = new DeferredTriggerStore(file);
  store.append(register('a', '/w.jsonl', [{ kind: 'session_finished' }]));
  const claim = store.tryClaim('a', '/w.jsonl', 'dead-host', 41_003, 'attempt');
  assert.ok(claim);
  store.markDispatchStarted(claim);

  assert.deepEqual(store.recoverDeadOwnerClaims(() => 'dead'), []);
  const active = replayTriggers(store.readOps()).get('a');
  assert.equal(active?.deliveryState, 'claimed');
  assert.equal(active?.recoveryState, 'acknowledgement-ambiguous');
  assert.match(active?.deliveryDetail ?? '', /automatic retry is blocked/);
  assert.equal(store.tryClaim('a', '/w.jsonl', 'other-host', 41_004, 'duplicate'), undefined);
});

test('a released claim records retryable failure and can be claimed by another store', () => {
  const file = path.join(dir, 'deferred-triggers', 'triggers.jsonl');
  const first = new DeferredTriggerStore(file);
  const second = new DeferredTriggerStore(file);
  first.append(register('a', '/w.jsonl', [{ kind: 'session_finished' }]));
  const firstClaim = first.tryClaim('a', '/w.jsonl', 'host-a', 101, 'attempt');
  assert.ok(firstClaim);

  first.releaseClaim(firstClaim, 'tab closed');
  const retryable = replayTriggers(second.readOps()).get('a');
  assert.equal(retryable?.deliveryState, 'retryable');
  assert.equal(retryable?.deliveryDetail, 'tab closed');

  const secondClaim = second.tryClaim('a', '/w.jsonl', 'host-b', 102, 'retry');
  assert.ok(secondClaim);
  second.completeClaim(secondClaim);
  assert.equal(replayTriggers(first.readOps()).size, 0);
});
