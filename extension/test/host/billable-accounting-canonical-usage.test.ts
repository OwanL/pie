import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BillableAccounting, type BillableAccountingDeps } from '../../src/host/billable-accounting/service';
import type { CanonicalAnalyticsCapture, CanonicalProviderSettlement } from '../../src/analytics/canonical-capture.js';

function accountingWithCapture(
  tempDir: string,
  captureOutcome: 'submitted' | 'rejected' = 'submitted',
  captured?: CanonicalProviderSettlement[],
  captureGaps?: Array<{
    executionId: string;
    sourceKey: string;
    observedAtMs: number;
    fields: Record<string, unknown>;
  }>,
  now?: () => Date,
): BillableAccounting {
  const deps: BillableAccountingDeps = {
    getStorageDir: () => tempDir,
    now: now ?? (() => new Date(Date.parse('2026-01-01T00:00:00.000Z'))),
    scheduleRender: () => undefined,
    dispatchArchEvent: () => undefined,
    getAgentDir: () => null,
    isPrivateSession: () => false,
    sessionIdentity: () => ({ sessionId: 'session-id-1' }),
    currentRunId: () => null,
    activeOperationId: () => null,
    markDerivedExportDirty: () => undefined,
    canonicalCapture: {
      captureProviderSettlement: (record: CanonicalProviderSettlement) => {
        captured?.push(record);
        return captureOutcome;
      },
      captureExecution: (
        _context: unknown,
        executionId: string,
        _phase: unknown,
        sourceKey: string,
        observedAtMs: number,
        fields: Record<string, unknown>,
      ) => {
        captureGaps?.push({ executionId, sourceKey, observedAtMs, fields });
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

test('canonical accounting submits exact settlements without a host history projection', () => {
  const temp = tempDir();
  try {
    const captured: CanonicalProviderSettlement[] = [];
    const accounting = accountingWithCapture(temp, 'submitted', captured);

    const before = accounting.projectSessionUsage('/sessions/a.jsonl');
    assert.deepEqual(before, { samples: [], authority: 'unknown' });

    accounting.observeAuxiliaryLlmUsage('/sessions/a', assistantSample);
    assert.equal(captured.length, 1);

    // The canonical authority never writes the legacy JSONL ledger.
    assert.equal(accounting.invocationLedger.projectAll().records.length, 0);
    assert.equal(accounting.exportRecords().length, 0);

    assert.deepEqual(accounting.projectSessionUsage('/sessions/a'), { samples: [], authority: 'unknown' });
    const sample = captured[0]!;
    assert.equal(sample.sourceId, 'assistant:op-1');
    assert.equal(sample.kind, 'conversation');
    assert.equal(sample.model, 'claude-x');
    assert.equal(sample.inputTokens, 100);
    assert.equal(sample.outputTokens, 40);
    assert.equal(sample.providerTotalTokens, 150);
    assert.equal(sample.providerReportedCostUsd, 0.02);
    assert.equal(sample.provenance, 'exact');
    // Close does not introduce a legacy fallback.
    accounting.onSessionClosed('/sessions/a');
    assert.deepEqual(accounting.projectSessionUsage('/sessions/a'), { samples: [], authority: 'unknown' });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('canonical subagent reconciliation routes mixed attempt capture status item by item', () => {
  const temp = tempDir();
  try {
    const captured: CanonicalProviderSettlement[] = [];
    const captureGaps: Array<{
      executionId: string;
      sourceKey: string;
      observedAtMs: number;
      fields: Record<string, unknown>;
    }> = [];
    let nowMs = Date.parse('2026-01-01T00:00:00.000Z');
    const accounting = accountingWithCapture(
      temp,
      'submitted',
      captured,
      captureGaps,
      () => new Date(nowMs),
    );
    const receipt = (
      attemptId: string,
      factStatus: 'disabled' | 'submitted' | 'rejected',
    ) => ({
      factStatus,
      generationId: 'generation-mixed',
      stableOriginId: `origin-${attemptId}`,
      executionId: `execution-${attemptId}`,
      attemptId,
      terminalDetailPayloadId: `detail-${attemptId}`,
      lastSubmittedSequence: factStatus === 'disabled' ? 0 : 3,
      ...(factStatus === 'submitted' ? { lastAcknowledgedSequence: 3 } : {}),
      terminalDetailComplete: factStatus !== 'rejected',
    });
    const attempt = (
      attemptId: string,
      factStatus: 'disabled' | 'submitted' | 'rejected',
      cost: number,
    ) => ({
      attemptId,
      outcome: 'success',
      providerResponseObserved: true,
      analyticsCaptureReceipt: receipt(attemptId, factStatus),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost },
    });
    const invocation = (
      attemptId: string,
      cost: number,
    ) => ({
      invocationId: `raw-${attemptId}`,
      canonicalInvocationId: `canonical-${attemptId}`,
      attemptId,
      outcome: 'success',
      startedAt: 1_800_000_000_000,
      completedAt: 1_800_000_000_001,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost },
    });

    const terminalTool = {
      id: 'mixed-tool',
      name: 'subagent',
      input: {},
      status: 'completed' as const,
      result: {
        billing: [{
          path: '0',
          attempts: [
            attempt('submitted', 'submitted', 0.02),
            attempt('disabled', 'disabled', 0.03),
            attempt('rejected', 'rejected', 0.04),
            {
              attemptId: 'missing',
              outcome: 'success',
              providerResponseObserved: true,
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.05 },
            },
            {
              attemptId: 'malformed',
              outcome: 'success',
              providerResponseObserved: true,
              analyticsCaptureReceipt: {
                ...receipt('malformed', 'submitted'),
                terminalDetailComplete: 'not-a-boolean',
              },
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.06 },
            },
          ],
          invocations: [
            invocation('submitted', 0.02),
            invocation('disabled', 0.03),
            invocation('rejected', 0.04),
            invocation('missing', 0.05),
            invocation('malformed', 0.06),
          ],
        }, {
          path: '1',
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.07 },
        }],
      },
    };
    accounting.observeSubagentToolResult('/sessions/mixed.jsonl', terminalTool);

    assert.deepEqual(
      captured.map((record) => record.invocationId),
      ['canonical-disabled'],
      'only the explicitly disabled producer item uses the parent fallback',
    );
    assert.deepEqual(captureGaps.map((gap) => gap.executionId), [
      'execution-rejected',
      'subagent-reconciliation:mixed-tool:missing',
      'subagent-reconciliation:mixed-tool:malformed',
      'subagent-reconciliation:mixed-tool:subagent:mixed-tool:1',
    ]);
    assert.equal(captureGaps.every((gap) => gap.fields.captureIncomplete === true), true);
    assert.equal(captureGaps[0]?.fields.lastSubmittedSequence, 3);
    assert.match(String(captureGaps[1]?.fields.reason), /no valid fact ownership receipt/);
    assert.match(String(captureGaps[2]?.fields.reason), /no valid fact ownership receipt/);
    assert.match(String(captureGaps[3]?.fields.reason), /no valid fact ownership receipt/);
    const firstGapDelivery = captureGaps.map((gap) => ({ ...gap, fields: { ...gap.fields } }));
    nowMs += 60_000;
    accounting.observeSubagentToolResult('/sessions/mixed.jsonl', terminalTool);
    assert.deepEqual(
      captureGaps.slice(firstGapDelivery.length),
      firstGapDelivery,
      'delayed terminal redelivery must preserve every reconciliation fact fingerprint',
    );
    assert.deepEqual(
      captured.map((record) => record.invocationId),
      ['canonical-disabled', 'canonical-disabled'],
      'explicitly disabled fallback retains its canonical invocation identity on replay',
    );
    assert.deepEqual(accounting.projectSessionUsage('/sessions/mixed.jsonl'), { samples: [], authority: 'unknown' });
    assert.equal(captured[0]?.providerReportedCostUsd, 0.03);
    assert.equal(accounting.invocationLedger.projectAll().records.length, 0);
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

test('canonical capture preserves unknown channels without retaining settlements during re-pathing', () => {
  const temp = tempDir();
  try {
    const captured: CanonicalProviderSettlement[] = [];
    const accounting = accountingWithCapture(temp, 'submitted', captured);
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
    assert.deepEqual(accounting.projectSessionUsage('/sessions/b'), { samples: [], authority: 'unknown' });
    assert.equal(captured.length, 1);
    const sample = captured[0]!;
    assert.equal(sample.sourceId, 'assistant:op-2');
    assert.equal(sample.inputTokens, undefined);
    assert.equal(sample.outputTokens, undefined);
    assert.equal(sample.cacheReadTokens, undefined);
    assert.equal(sample.cacheWriteTokens, undefined);
    assert.equal(sample.instrumentationGap, true);
    assert.equal(sample.provenance, 'unknown');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
