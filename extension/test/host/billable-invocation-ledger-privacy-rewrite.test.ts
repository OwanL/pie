import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import test, { afterEach, beforeEach } from 'node:test';

import { BillableInvocationLedger } from '../../src/host/billable-invocation-ledger/service';
import type { BillableInvocationRecord } from '../../src/shared/billable-invocation';

let directory: string;
let ledgerPath: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-billable-ledger-privacy-rewrite-test-'));
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

const mutableFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');

/** Fail only the ledger-file rewrite rename, not the privacy-fence rename. */
function failLedgerRewriteRename(): () => void {
  const original = mutableFs.renameSync;
  mutableFs.renameSync = ((source: string, destination: string) => {
    if (destination === ledgerPath) {
      throw Object.assign(new Error('injected ledger rewrite failure'), { code: 'EIO' });
    }
    return original(source, destination);
  }) as typeof mutableFs.renameSync;
  syncBuiltinESMExports();
  return () => {
    mutableFs.renameSync = original;
    syncBuiltinESMExports();
  };
}

/** Persist the privacy fence, fail the durable rewrite, and verify the resulting state. */
function persistFenceWithFailedRewrite(): void {
  const ledger = new BillableInvocationLedger(ledgerPath);
  ledger.append(invocation('private-before'), { visibility: 'ordinary' });
  ledger.append(invocation('unrelated', {
    sessionId: 'session-b',
    sessionPath: '/sessions/b.jsonl',
  }), { visibility: 'ordinary' });

  const restore = failLedgerRewriteRename();
  let failure: unknown;
  try {
    ledger.markSessionPrivate({ sessionId: 'session-a' });
  } catch (error) {
    failure = error;
  } finally {
    restore();
  }
  assert.match(String((failure as Error)?.message), /injected ledger rewrite failure/);

  // Fence persisted but the durable rewrite failed: rows remain on disk.
  assert.equal(fs.existsSync(ledgerPath), true);
  assert.match(fs.readFileSync(ledgerPath, 'utf8'), /private-before/);
  assert.equal(fs.existsSync(path.join(directory, 'accounting-private-sessions.json')), true);
}

test('failed privacy rewrite keeps fenced rows out of reload, sibling projection, and export', () => {
  persistFenceWithFailedRewrite();

  for (const ledger of [
    new BillableInvocationLedger(ledgerPath),
    new BillableInvocationLedger(ledgerPath),
  ]) {
    assert.deepEqual(
      ledger.exportRecords().map((record) => record.invocationId),
      ['unrelated'],
      'fenced rows must not re-enter export as ordinary after a failed rewrite',
    );
    assert.doesNotMatch(ledger.exportJsonl(), /private-before/);
    assert.deepEqual(
      ledger.projectAll({ includePrivate: false }).records.map((record) => record.invocationId),
      ['unrelated'],
      'fenced rows must not re-enter non-private projections as ordinary',
    );
    assert.deepEqual(
      ledger.projectAll().records.map((record) => record.invocationId).sort(),
      ['private-before', 'unrelated'],
      'live projections still include the reclassified process-local private usage',
    );
  }
});

test('fenced rows stay scrubable process-locally and the ordinary transition restores durability', () => {
  persistFenceWithFailedRewrite();

  const ledger = new BillableInvocationLedger(ledgerPath);
  // While fenced, new matching invocations stay process-local and off disk.
  ledger.append(invocation('while-fenced'), { visibility: 'ordinary' });
  assert.doesNotMatch(fs.readFileSync(ledgerPath, 'utf8'), /while-fenced/);
  assert.match(fs.readFileSync(ledgerPath, 'utf8'), /unrelated/);

  assert.equal(ledger.scrubPrivateRecords({ sessionId: 'session-a' }), 2);
  // The durable row survives the failed rewrite, so while the fence stays
  // active a reload resurrects it only as process-local private usage.
  assert.deepEqual(
    ledger.projectAll({ includePrivate: false }).records.map((record) => record.invocationId),
    ['unrelated'],
  );
  assert.deepEqual(
    ledger.projectAll().records.map((record) => record.invocationId).sort(),
    ['private-before', 'unrelated'],
  );

  // Removing the fence stops future classification; the already-private row
  // remains process-local until its normal scrub boundary.
  ledger.markSessionOrdinary({ sessionId: 'session-a' });
  assert.deepEqual(ledger.exportRecords().map((record) => record.invocationId), ['unrelated']);
  assert.equal(ledger.scrubPrivateRecords({ sessionId: 'session-a' }), 1);
  // Fence removed and scrubbed: the surviving durable row reloads as ordinary.
  assert.deepEqual(
    ledger.exportRecords().map((record) => record.invocationId).sort(),
    ['private-before', 'unrelated'],
  );
  assert.deepEqual(
    ledger.projectAll({ includePrivate: false }).records.map((record) => record.invocationId).sort(),
    ['private-before', 'unrelated'],
  );

  const restarted = new BillableInvocationLedger(ledgerPath);
  assert.deepEqual(
    restarted.exportRecords().map((record) => record.invocationId).sort(),
    ['private-before', 'unrelated'],
  );
});