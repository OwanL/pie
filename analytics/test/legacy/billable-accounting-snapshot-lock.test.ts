import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BillableAccounting } from '../../legacy/billable-accounting/service';
import type { SessionUsageSnapshot } from '../../usage-accounting/session-usage';

const sessionPath = '/workspace/snapshot-lock.jsonl';
const snapshot: SessionUsageSnapshot = {
  branchId: 'entry-3', branchEntryIds: ['entry-1', 'entry-2', 'entry-3'],
  samples: Array.from({ length: 3 }, (_, index) => ({
    sourceId: `assistant:entry-${index + 1}`, kind: 'conversation',
    inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 7,
    startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:01.000Z',
  })),
};

function fixture(t: import('node:test').TestContext, canonical = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-snapshot-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let privateSession = false;
  const notices: unknown[] = [];
  const accounting = new BillableAccounting({
    getStorageDir: () => dir, now: () => new Date('2026-01-01T00:00:01.000Z'),
    scheduleRender: () => {}, dispatchArchEvent: (notice) => notices.push(notice),
    getCapturedPricingFacts: () => undefined, resolveInvocationPricing: () => undefined,
    isPrivateSession: () => privateSession, sessionIdentity: () => ({ sessionId: 'snapshot-session' }),
    currentRunId: () => null, activeOperationId: () => null, markDerivedExportDirty: () => {},
    ...(canonical ? { canonicalCapture: {
      captureProviderSettlement: () => { throw new Error('snapshot must not recapture settlements'); },
      captureExecution: () => { throw new Error('snapshot must not recapture executions'); },
    } } : {}),
  });
  return { accounting, dir, notices, setPrivate: (value: boolean) => { privateSession = value; } };
}

test('snapshot groups physical lock acquisition while retaining immutable rows, activity and reopen deduplication', (t) => {
  const { accounting } = fixture(t);
  let acquisitions = 0;
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]).endsWith('.pie-lock') && args[1] === 'wx') acquisitions += 1;
    return open(...args);
  });
  accounting.observeSessionUsageSnapshot(sessionPath, 'snapshot-session', snapshot);
  // One session projection and one enclosing replay transaction, not locks per row.
  assert.equal(acquisitions, 2);
  const rows = [...accounting.exportRecords()];
  assert.equal(rows.length, 3);
  assert.equal(rows.reduce((sum, row) => sum + (row.providerTotalTokens ?? 0), 0), 21);
  const activity = accounting.activityTimeline.projectAll();
  assert.deepEqual(activity.map((row) => row.invocationId).sort(), rows.map((row) => row.invocationId).sort());
  assert.ok(rows.every((row) => row.evidenceOrigin === 'migration' && row.branchId === 'entry-3'));
  accounting.observeSessionUsageSnapshot(sessionPath, 'snapshot-session', snapshot);
  assert.deepEqual(accounting.exportRecords(), rows);
  assert.deepEqual(accounting.activityTimeline.projectAll(), activity);
  assert.equal(accounting.projectSessionUsage(sessionPath).samples.length, 3);
});

test('canonical historical snapshot performs no legacy reads or writes and no recapture', (t) => {
  const { accounting, dir } = fixture(t, true);
  t.mock.method(accounting.invocationLedger, 'projectSession', () => { throw new Error('legacy read'); });
  t.mock.method(accounting.invocationLedger, 'transaction', () => { throw new Error('legacy write'); });
  accounting.observeSessionUsageSnapshot(sessionPath, 'snapshot-session', snapshot);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('private snapshot remains process-local through privacy transitions', (t) => {
  const { accounting, dir, setPrivate } = fixture(t);
  setPrivate(true);
  accounting.markSessionPrivate(sessionPath, 'snapshot-session');
  accounting.observeSessionUsageSnapshot(sessionPath, 'snapshot-session', snapshot);
  assert.equal(accounting.projectSessionUsage(sessionPath).samples.length, 3);
  assert.equal(accounting.exportRecords().length, 0);
  assert.equal(accounting.activityTimeline.projectAll().length, 0);
  assert.equal(fs.existsSync(path.join(dir, 'billable-invocations.jsonl')), false);
  setPrivate(false);
  accounting.markSessionOrdinary(sessionPath, 'snapshot-session');
  accounting.observeSessionUsageSnapshot(sessionPath, 'snapshot-session', snapshot);
  assert.equal(accounting.exportRecords().length, 0); // No promotion of private history.
  accounting.forgetSession(sessionPath, 'snapshot-session');
  accounting.observeSessionUsageSnapshot(sessionPath, 'snapshot-session', snapshot);
  assert.equal(accounting.exportRecords().length, 3);
  setPrivate(true);
  accounting.markSessionPrivate(sessionPath, 'snapshot-session');
  assert.equal(accounting.exportRecords().length, 0);
  assert.equal(accounting.activityTimeline.projectAll().length, 0);
});

test('failed historical row stays pending, notices once and retries without losing activity coverage', (t) => {
  const { accounting, notices } = fixture(t);
  const append = accounting.invocationLedger.append.bind(accounting.invocationLedger);
  let fail = true;
  let successfulAppends = 0;
  t.mock.method(accounting.invocationLedger, 'append', (...args: Parameters<typeof append>) => {
    if (args[0].sourceId === snapshot.samples[1].sourceId && fail) throw new Error('fixture write failure');
    const result = append(...args);
    if (result === 'appended') successfulAppends += 1;
    return result;
  });
  accounting.observeSessionUsageSnapshot(sessionPath, 'snapshot-session', snapshot);
  assert.equal(notices.length, 1);
  assert.equal(accounting.exportRecords().length, 2);
  assert.equal(accounting.activityTimeline.projectAll().length, 2);
  fail = false;
  accounting.retryPendingWrites();
  accounting.retryPendingWrites();
  accounting.observeSessionUsageSnapshot(sessionPath, 'snapshot-session', snapshot);
  assert.equal(successfulAppends, 3);
  assert.equal(notices.length, 1);
  assert.equal(accounting.exportRecords().length, 3);
  assert.equal(accounting.activityTimeline.projectAll().length, 3);
});
