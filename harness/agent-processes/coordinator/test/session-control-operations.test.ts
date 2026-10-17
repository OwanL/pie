import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionControlOperations } from '../session-control-operations.js';

const time = 1791970000000;
const key = (offset: number) => `${time + offset}:00000000-0000-4000-8000-${String(offset).padStart(12, '0')}`;
const operation = (records: SessionControlOperations, requestKey: string, owner = 'caller') => records.status(owner, requestKey).operation as Record<string, unknown>;

test('status has no execution path; pending and partial known evidence remain distinct', () => {
  const records = new SessionControlOperations(4, 8192, time, () => time + 10);
  assert.equal(operation(records, key(0)).status, 'unavailable');
  assert.equal(records.begin('caller', key(0), 'create', 'payload'), true);
  records.phase('caller', key(0), 'configuration', { creation: { status: 'created' }, configuration: { status: 'pending' } });
  assert.equal(operation(records, key(0)).status, 'pending');
  assert.equal(operation(records, key(0)).phase, 'configuration');
  assert.equal(records.begin('caller', key(0), 'create', 'payload'), false);
  assert.throws(() => records.begin('caller', key(0), 'create', 'changed'), /another operation/u);
  records.finish('caller', key(0), { creation: { status: 'created' }, configuration: { status: 'unknown' }, message: { status: 'not_sent' } });
  assert.equal(operation(records, key(0)).status, 'known');
  assert.equal(operation(records, key(0)).outcome, 'unknown');
  assert.equal(operation(records, key(0), 'other').status, 'unavailable');
});

test('evicted and pre-restart keys are unavailable and cannot execute again', () => {
  const records = new SessionControlOperations(1, 8192, time, () => time + 10);
  records.begin('caller', key(0), 'message', 'payload');
  records.finish('caller', key(0), { message: { status: 'accepted' } });
  records.begin('caller', key(1), 'message', 'new');
  assert.equal(operation(records, key(0)).status, 'unavailable');
  assert.throws(() => records.begin('caller', key(0), 'message', 'payload'), /Stale requestKey/u);
  const restarted = new SessionControlOperations(1, 8192, time + 2, () => time + 10);
  assert.equal(operation(restarted, key(1)).status, 'unavailable');
  assert.throws(() => restarted.begin('caller', key(1), 'message', 'new'), /Stale requestKey/u);
});

test('pending receipt count saturation rejects admission without eviction', () => {
  const records = new SessionControlOperations(1, 8192, time, () => time + 10);
  records.begin('caller', key(0), 'cleanup', 'payload');
  assert.throws(() => records.begin('caller', key(1), 'create', 'another'), /capacity/u);
  assert.equal(operation(records, key(0)).status, 'pending');
});

test('pending byte saturation hashes fingerprints, omits oversized evidence, and remains bounded', () => {
  const cap = 1600;
  const records = new SessionControlOperations(50, cap, time, () => time + 100);
  const internal = records as unknown as { records: Map<string, unknown> };
  const retainedBytes = () => [...internal.records].reduce((total, row) => total + Buffer.byteLength(JSON.stringify(row), 'utf8'), 0);
  records.begin('caller', key(0), 'create', 'large input'.repeat(100000));
  assert.ok(retainedBytes() < cap);
  records.phase('caller', key(0), 'configuration', { payload: 'huge evidence'.repeat(100000) });
  assert.equal(operation(records, key(0)).evidenceUnavailable, true);
  assert.equal(operation(records, key(0)).result, undefined);
  assert.ok(retainedBytes() < cap);
  let saturated = false;
  for (let i = 1; i < 50; i++) {
    try { records.begin('caller', key(i), 'message', 'payload'); }
    catch (error) { assert.match(String(error), /capacity/u); saturated = true; break; }
    records.phase('caller', key(i), 'message', { message: { status: 'pending' }, bulk: 'x'.repeat(cap) });
    assert.ok(retainedBytes() <= cap);
  }
  assert.ok(saturated);
  assert.equal(operation(records, key(0)).status, 'pending');
  records.finish('caller', key(0), { creation: { status: 'created' }, bulk: 'x'.repeat(cap) });
  assert.equal(operation(records, key(0)).status, 'known');
  assert.equal(operation(records, key(0)).evidenceUnavailable, true);
  assert.ok(retainedBytes() <= cap);
});
