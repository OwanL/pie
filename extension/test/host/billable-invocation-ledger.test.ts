import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';

import { BillableInvocationLedger } from '../../src/host/billable-invocation-ledger/service';
import type { BillableInvocationRecord } from '../../src/shared/billable-invocation';

let directory: string;
let ledgerPath: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-billable-ledger-test-'));
  ledgerPath = path.join(directory, 'billable-invocations.jsonl');
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

function invocation(
  invocationId: string,
  overrides: Partial<BillableInvocationRecord> = {},
): BillableInvocationRecord {
  return {
    schemaVersion: 1,
    invocationId,
    sourceId: `source:${invocationId}`,
    sessionId: 'session-a',
    sessionPath: '/sessions/a.jsonl',
    branchId: 'branch-a',
    parentOperationId: 'operation-a',
    parentRunId: 'run-a',
    parentToolId: null,
    kind: 'conversation',
    provider: 'provider-a',
    model: 'model-a',
    inputTokens: 10,
    outputTokens: 5,
    providerTotalTokens: 15,
    providerReportedCostUsd: 0.25,
    provenance: 'exact',
    startedAt: '2026-09-04T10:00:00.000Z',
    endedAt: '2026-09-04T10:00:01.000Z',
    outcome: 'succeeded',
    instrumentationGap: false,
    ...overrides,
  } as BillableInvocationRecord;
}

test('append is idempotent by invocationId across duplicate calls and restart', () => {
  const first = new BillableInvocationLedger(ledgerPath);
  const record = invocation('invocation-1');

  assert.equal(first.append(record, { visibility: 'ordinary' }), 'appended');
  assert.equal(first.append(record, { visibility: 'ordinary' }), 'duplicate');
  assert.equal(fs.readFileSync(ledgerPath, 'utf8').trim().split('\n').length, 1);

  const restarted = new BillableInvocationLedger(ledgerPath);
  assert.equal(restarted.projectAll().records.length, 1);
  assert.equal(restarted.append(record, { visibility: 'ordinary' }), 'duplicate');
  assert.equal(fs.readFileSync(ledgerPath, 'utf8').trim().split('\n').length, 1);
  assert.throws(
    () => restarted.append(invocation('invocation-1', { outputTokens: 6 }), { visibility: 'ordinary' }),
    /conflicting data/,
  );
  assert.ok(Object.isFrozen(restarted.projectAll().records[0]));
});

test('replay skips malformed, torn, and duplicate lines without losing later valid records', () => {
  const firstRecord = invocation('invocation-1');
  fs.writeFileSync(
    ledgerPath,
    `${JSON.stringify(firstRecord)}\nnot-json\n${JSON.stringify(firstRecord)}\n{"schemaVersion":1,"invocationId":"torn"`,
    'utf8',
  );

  const ledger = new BillableInvocationLedger(ledgerPath);
  assert.deepEqual(ledger.projectAll().records.map((record) => record.invocationId), ['invocation-1']);
  assert.equal(ledger.append(invocation('invocation-2'), { visibility: 'ordinary' }), 'appended');

  const restarted = new BillableInvocationLedger(ledgerPath);
  assert.deepEqual(
    restarted.projectAll().records.map((record) => record.invocationId),
    ['invocation-1', 'invocation-2'],
  );
});

test('unknown and unpriced values stay incomplete while provider totals and reported cost remain usable', () => {
  const ledger = new BillableInvocationLedger(ledgerPath);
  ledger.append(invocation('gap', {
    inputTokens: undefined,
    outputTokens: undefined,
    providerTotalTokens: undefined,
    providerReportedCostUsd: undefined,
    provenance: 'unknown',
    outcome: 'unknown',
    instrumentationGap: true,
    instrumentationGapReason: 'provider adapter exposed no usage event',
  }), { visibility: 'ordinary' });
  ledger.append(invocation('unpriced', {
    inputTokens: 9,
    outputTokens: undefined,
    providerTotalTokens: 37,
    providerReportedCostUsd: undefined,
    provenance: 'unpriced',
  }), { visibility: 'ordinary' });
  ledger.append(invocation('total-only', {
    inputTokens: undefined,
    outputTokens: undefined,
    providerTotalTokens: 41,
    providerReportedCostUsd: 0.75,
  }), { visibility: 'ordinary' });

  const summary = ledger.projectAll().summary;
  assert.deepEqual(summary.inputTokens, {
    value: 9,
    knownInvocations: 1,
    unknownInvocations: 2,
    complete: false,
  });
  assert.deepEqual(summary.outputTokens, {
    knownInvocations: 0,
    unknownInvocations: 3,
    complete: false,
  });
  assert.equal(summary.providerTotalTokens.value, 78);
  assert.equal(summary.providerTotalTokens.knownInvocations, 2);
  assert.equal(summary.effectiveCostUsd.value, 0.75);
  assert.equal(summary.effectiveCostUsd.knownInvocations, 1);
  assert.equal(summary.provenanceCounts.unpriced, 1);
  assert.equal(summary.provenanceCounts.unknown, 1);
  assert.equal(summary.instrumentationGapInvocations, 1);
});

test('session, all, and provider/model/kind aggregate projections share conserved summaries', () => {
  const ledger = new BillableInvocationLedger(ledgerPath);
  ledger.append(invocation('a-1'), { visibility: 'ordinary' });
  ledger.append(invocation('a-2', {
    kind: 'retry',
    inputTokens: 2,
    outputTokens: 3,
    providerTotalTokens: 5,
    providerReportedCostUsd: undefined,
    pricing: { catalogVersion: 'catalog-7', calculatedCostUsd: 0.1 },
    provenance: 'estimated',
    outcome: 'failed',
  }), { visibility: 'ordinary' });
  ledger.append(invocation('b-1', {
    sessionId: 'session-b',
    sessionPath: '/sessions/b.jsonl',
    branchId: 'branch-b',
    provider: 'provider-b',
    model: 'model-b',
    kind: 'session_title',
    inputTokens: 4,
    outputTokens: 1,
    providerTotalTokens: 5,
    providerReportedCostUsd: 0.05,
  }), { visibility: 'ordinary' });

  const session = ledger.projectSession({ sessionId: 'session-a' });
  assert.equal(session.summary.invocationCount, 2);
  assert.equal(session.summary.providerTotalTokens.value, 20);
  assert.equal(session.summary.effectiveCostUsd.value, 0.35);

  const all = ledger.projectAll();
  const aggregate = ledger.projectAggregate();
  assert.equal(all.summary.invocationCount, 3);
  assert.deepEqual(aggregate.summary, all.summary);
  assert.equal(aggregate.groups.length, 3);
  assert.deepEqual(
    aggregate.groups.map((group) => `${group.provider}/${group.model}/${group.kind}`),
    [
      'provider-a/model-a/conversation',
      'provider-a/model-a/retry',
      'provider-b/model-b/session_title',
    ],
  );
});

test('disabling privacy makes only future matching invocations durable', () => {
  const ledger = new BillableInvocationLedger(ledgerPath);
  ledger.markSessionPrivate({ sessionId: 'session-a' });
  ledger.append(invocation('while-private'), { visibility: 'ordinary' });
  assert.equal(ledger.exportRecords().length, 0);

  ledger.markSessionOrdinary({ sessionId: 'session-a' });
  ledger.append(invocation('after-private'), { visibility: 'ordinary' });
  assert.deepEqual(ledger.exportRecords().map((record) => record.invocationId), ['after-private']);
  assert.match(fs.readFileSync(ledgerPath, 'utf8'), /after-private/);
  assert.doesNotMatch(fs.readFileSync(ledgerPath, 'utf8'), /while-private/);
});

test('private records never persist or export and privacy/forget scrub durable state', () => {
  const ledger = new BillableInvocationLedger(ledgerPath);
  ledger.append(invocation('ordinary'), { visibility: 'ordinary' });
  ledger.append(invocation('private', {
    sessionId: 'session-private',
    sessionPath: '/sessions/private.jsonl',
    branchId: 'private-branch',
  }), { visibility: 'private' });

  assert.equal(ledger.projectAll().summary.invocationCount, 2);
  assert.equal(ledger.projectAll({ includePrivate: false }).summary.invocationCount, 1);
  assert.deepEqual(ledger.exportRecords().map((record) => record.invocationId), ['ordinary']);
  assert.doesNotMatch(fs.readFileSync(ledgerPath, 'utf8'), /"private"/);
  assert.doesNotMatch(ledger.exportJsonl(), /"private"/);

  assert.equal(ledger.markSessionPrivate({ sessionId: 'session-a' }), 1);
  assert.equal(fs.readFileSync(ledgerPath, 'utf8'), '');
  assert.equal(ledger.exportRecords().length, 0);
  assert.equal(ledger.projectAll().records.length, 2, 'live private projection remains process-local');
  assert.equal(ledger.scrubPrivateRecords({ sessionId: 'session-a' }), 1);
  assert.deepEqual(ledger.projectAll().records.map((record) => record.invocationId), ['private']);

  ledger.append(invocation('forgotten', {
    sessionId: 'session-forgotten',
    sessionPath: '/sessions/forgotten.jsonl',
  }), { visibility: 'ordinary' });
  assert.equal(ledger.forgetSession({ sessionPath: '/sessions/forgotten.jsonl' }), 1);
  assert.equal(fs.readFileSync(ledgerPath, 'utf8'), '');

  const restarted = new BillableInvocationLedger(ledgerPath);
  assert.equal(restarted.projectAll().summary.invocationCount, 0);
});
