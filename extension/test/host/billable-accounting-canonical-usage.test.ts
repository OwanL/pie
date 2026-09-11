import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { BillableInvocationRecord } from '../../src/shared/billable-invocation';
import { BillableAccounting, type BillableAccountingDeps } from '../../src/host/billable-accounting/service';
import type { CanonicalAnalyticsCapture } from '../../src/analytics/canonical-capture.js';

function accountingWithCapture(
  tempDir: string,
  captureOutcome: 'submitted' | 'rejected' = 'submitted',
  captured?: BillableInvocationRecord[],
): BillableAccounting {
  const deps: BillableAccountingDeps = {
    getStorageDir: () => tempDir,
    now: () => new Date(Date.parse('2026-01-01T00:00:00.000Z')),
    scheduleRender: () => undefined,
    dispatchArchEvent: () => undefined,
    getAgentDir: () => null,
    isPrivateSession: () => false,
    sessionIdentity: () => ({ sessionId: 'session-id-1' }),
    currentRunId: () => null,
    activeOperationId: () => null,
    markDerivedExportDirty: () => undefined,
    canonicalCapture: {
      captureProviderSettlement: (record: BillableInvocationRecord) => {
        captured?.push(record);
        return captureOutcome;
      },
    } as CanonicalAnalyticsCapture,
  };
  return new BillableAccounting(deps);
}

const assistantSample = {
  kind: 'assistant_message' as const,
  sourceId: 'assistant:op-1',
  occurredAt: '2026-01-01T00:01:00.000Z',
  modelId: 'claude-x',
  provider: 'anthropic',
  inputTokens: 100,
  outputTokens: 40,
  cacheReadTokens: 10,
  cacheWriteTokens: 0,
  providerTotalTokens: 150,
  reportedCostUsd: 0.02,
  outcome: 'succeeded' as const,
};

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'pie-accounting-canonical-'));
}

test('canonical authority projects settled invocations as the authoritative live snapshot', () => {
  const temp = tempDir();
  try {
    const captured: BillableInvocationRecord[] = [];
    const accounting = accountingWithCapture(temp, 'submitted', captured);

    const before = accounting.projectSessionUsage('/sessions/a.jsonl');
    assert.deepEqual(before, { samples: [], authority: 'unknown' });

    accounting.observeAuxiliaryLlmUsage('/sessions/a', assistantSample);
    assert.equal(captured.length, 1);

    // The canonical authority never writes the legacy JSONL ledger.
    assert.equal(accounting.invocationLedger.projectAll().records.length, 0);
    assert.equal(accounting.exportRecords().length, 0);

    const snapshot = accounting.projectSessionUsage('/sessions/a');
    assert.equal(snapshot.authority, 'canonical');
    assert.equal(snapshot.samples.length, 1);
    const sample = snapshot.samples[0]!;
    assert.equal(sample.sourceId, 'assistant:op-1');
    assert.equal(sample.kind, 'conversation');
    assert.equal(sample.modelId, 'claude-x');
    assert.equal(sample.inputTokens, 100);
    assert.equal(sample.outputTokens, 40);
    assert.equal(sample.totalTokens, 150);
    assert.equal(sample.reportedCostUsd, 0.02);
    assert.equal(sample.tokenChannelsKnown, true);
    assert.equal(sample.provenance, 'exact');
    assert.equal(snapshot.incompleteInvocationCount, 0);

    // Session close drops the process-local settlements; no legacy fallback.
    accounting.onSessionClosed('/sessions/a');
    assert.deepEqual(accounting.projectSessionUsage('/sessions/a'), { samples: [], authority: 'unknown' });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('rejected canonical capture is not projected and empty sessions stay honestly unknown', () => {
  const temp = tempDir();
  try {
    const accounting = accountingWithCapture(temp, 'rejected');
    accounting.observeAuxiliaryLlmUsage('/sessions/a', assistantSample);
    assert.deepEqual(accounting.projectSessionUsage('/sessions/a'), { samples: [], authority: 'unknown' });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('canonical projection preserves unknown channels and re-pathing moves settlements', () => {
  const temp = tempDir();
  try {
    const accounting = accountingWithCapture(temp);
    accounting.observeAuxiliaryLlmUsage('/sessions/a', {
      kind: 'assistant_message',
      sourceId: 'assistant:op-2',
      occurredAt: '2026-01-01T00:02:00.000Z',
      provider: 'anthropic',
      // No token channels at all: the provider seam omitted usage.
      instrumentationGap: true,
      instrumentationGapReason: 'The provider response exposed no complete token-channel usage.',
      outcome: 'failed',
    });
    const snapshot = accounting.projectSessionUsage('/sessions/b');
    assert.deepEqual(snapshot, { samples: [], authority: 'unknown' });

    accounting.replaceSessionPath('/sessions/a', '/sessions/b');
    const moved = accounting.projectSessionUsage('/sessions/b');
    assert.equal(moved.authority, 'canonical');
    const sample = moved.samples[0]!;
    assert.equal(sample.sourceId, 'assistant:op-2');
    assert.equal(sample.tokenChannelsKnown, false);
    assert.equal(sample.instrumentationGap, true);
    assert.equal(sample.provenance, 'unknown');
    assert.equal(moved.incompleteInvocationCount, 1);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});