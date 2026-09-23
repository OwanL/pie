import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type {
  AnalyticsDetailCapture,
  AnalyticsObservation,
} from '../../../shared/analytics/contracts.js';
import { SqliteAnalyticsRecorder } from '../../../extension/src/analytics/sqlite-recorder.js';
import { captureSubagentTerminalResult } from '../src/analytics-capture.js';
import type { SingleResult, SubagentProviderInvocationRecord } from '../types.js';

const RATES = {
  inputUsdPerMillionTokens: 0.075,
  outputUsdPerMillionTokens: 0.25,
  cacheReadUsdPerMillionTokens: 0.015,
  cacheWriteUsdPerMillionTokens: 0,
  catalogVersion: 'sha256:fixture',
};

function invocation(options: {
  usage?: SubagentProviderInvocationRecord['usage'];
  model?: string;
  provider?: string;
}): SubagentProviderInvocationRecord {
  return {
    invocationId: 'attempt:provider:1',
    attemptId: 'attempt',
    provider: options.provider ?? 'fixture-provider',
    model: options.model ?? 'fixture-model',
    ...(options.usage !== undefined ? { usage: options.usage } : {}),
    startedAt: 1_800_000_000_000,
    completedAt: 1_800_000_000_001,
    outcome: 'success',
  };
}

function result(invocation: SubagentProviderInvocationRecord): SingleResult {
  return {
    childId: 'child',
    agent: 'fixture-agent',
    agentSource: 'project',
    task: 'fixture task',
    exitCode: 0,
    messages: [],
    stderr: '',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, contextTokens: 0, turns: 1 },
    provider: invocation.provider,
    model: invocation.model,
    attemptId: invocation.attemptId,
    startedAt: invocation.startedAt ?? 1_800_000_000_000,
    completedAt: invocation.completedAt ?? 1_800_000_000_001,
    stopReason: 'completed',
    providerInvocations: [invocation],
  };
}

function context(options: {
  facts: AnalyticsObservation[];
  details: AnalyticsDetailCapture[];
  priceSettlement?: (request: unknown) => unknown;
}) {
  return {
    generationId: 'generation-settlement-pricing',
    captureSubject: { kind: 'session' as const, rootSessionId: 'root-settlement-pricing' },
    sink: { submitDetail: (capture: AnalyticsDetailCapture) => { options.details.push(capture); } },
    factSink: { submit: (observation: AnalyticsObservation) => { options.facts.push(observation); } },
    ...(options.priceSettlement ? { priceSettlement: options.priceSettlement } : {}),
  };
}

function providerSettlementFacts(facts: AnalyticsObservation[]): AnalyticsObservation[] {
  return facts.filter((fact) => fact.observationKind === 'providerSettlement');
}

test('complete-channel settlements carry an oracle-v1 catalog snapshot for recorder pricing', () => {
  const facts: AnalyticsObservation[] = [];
  const details: AnalyticsDetailCapture[] = [];
  const priceRequests: unknown[] = [];
  const terminal = result(invocation({
    usage: { input: 4_000, output: 200, cacheRead: 1_000, cacheWrite: 2_000 },
  }));
  assert.equal(captureSubagentTerminalResult(terminal, context({
    facts,
    details,
    priceSettlement: (request) => {
      priceRequests.push(request);
      return RATES;
    },
  }), 'submitted'), 'submitted');

  const settlements = providerSettlementFacts(facts);
  assert.equal(settlements.length, 1);
  const fields = settlements[0]!.fields as Record<string, unknown>;
  assert.deepEqual(fields.pricing, {
    normalizationVersion: 'oracle-v1',
    catalogVersion: 'sha256:fixture',
    currency: 'USD',
    inputUsdPerMillionTokens: 0.075,
    outputUsdPerMillionTokens: 0.25,
    cacheReadUsdPerMillionTokens: 0.015,
    cacheWriteUsdPerMillionTokens: 0,
  });
  // The producer resolves from provider-qualified evidence and never fabricates
  // a cost value itself: the recorder calculates from channels plus rates.
  assert.equal(fields.calculatedCostUsd, undefined);
  assert.deepEqual(priceRequests, [{
    provider: 'fixture-provider',
    model: 'fixture-model',
    usage: { input: 4_000, output: 200, cacheRead: 1_000, cacheWrite: 2_000 },
    // Original observed invocation timestamps ride along for scheduled
    // pricing eligibility; they are never synthesized here.
    startedAtMs: 1_800_000_000_000,
    endedAtMs: 1_800_000_000_001,
  }]);
});

test('settlement pricing requests carry the original invocation interval endpoints', () => {
  const facts: AnalyticsObservation[] = [];
  const details: AnalyticsDetailCapture[] = [];
  const priceRequests: unknown[] = [];
  const scheduled: SubagentProviderInvocationRecord = {
    ...invocation({ usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }),
    startedAt: 1_790_000_123_000,
    completedAt: 1_790_000_456_000,
  };
  captureSubagentTerminalResult(result(scheduled), context({
    facts,
    details,
    priceSettlement: (request) => {
      priceRequests.push(request);
      return RATES;
    },
  }), 'submitted');
  assert.equal(providerSettlementFacts(facts).length, 1);
  assert.deepEqual(priceRequests[0], {
    provider: 'fixture-provider',
    model: 'fixture-model',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    startedAtMs: 1_790_000_123_000,
    endedAtMs: 1_790_000_456_000,
  });
});

test('settlement pricing does not reuse synthesized attempt timestamps as invocation evidence', () => {
  const facts: AnalyticsObservation[] = [];
  const details: AnalyticsDetailCapture[] = [];
  const priceRequests: unknown[] = [];
  const untimed: SubagentProviderInvocationRecord = {
    invocationId: 'attempt:provider:untimed',
    attemptId: 'attempt',
    provider: 'fixture-provider',
    model: 'fixture-model',
    usage: { input: 4_000, output: 200, cacheRead: 1_000, cacheWrite: 2_000 },
    outcome: 'success',
  };
  captureSubagentTerminalResult(result(untimed), context({
    facts,
    details,
    priceSettlement: (request) => {
      priceRequests.push(request);
      const interval = request as { startedAtMs?: unknown; endedAtMs?: unknown };
      return typeof interval.startedAtMs === 'number' && typeof interval.endedAtMs === 'number'
        ? RATES : undefined;
    },
  }), 'submitted');

  assert.deepEqual(priceRequests, [{
    provider: 'fixture-provider',
    model: 'fixture-model',
    usage: { input: 4_000, output: 200, cacheRead: 1_000, cacheWrite: 2_000 },
    startedAtMs: undefined,
    endedAtMs: undefined,
  }]);
  const settlement = providerSettlementFacts(facts)[0]!.fields as Record<string, unknown>;
  assert.equal(settlement.pricing, undefined);
  assert.equal(settlement.calculatedCostUsd, undefined);
});

test('unresolvable or incomplete evidence keeps the settlement explicitly unpriced', () => {
  const facts: AnalyticsObservation[] = [];
  const details: AnalyticsDetailCapture[] = [];
  const contextValue = context({
    facts,
    details,
    priceSettlement: () => undefined,
  });
  // No catalog rates: the fact carries no pricing and no invented cost.
  assert.equal(captureSubagentTerminalResult(result(invocation({
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
  })), contextValue), 'submitted');
  // Incomplete channels are never priced even when rates exist.
  assert.equal(captureSubagentTerminalResult(result(invocation({
    usage: { input: 10, output: 2, cacheRead: 0 },
  })), contextValue), 'submitted');
  // Provider-reported cost evidence keeps precedence over catalog pricing.
  assert.equal(captureSubagentTerminalResult(result(invocation({
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.03 },
  })), contextValue), 'submitted');

  const settlements = providerSettlementFacts(facts);
  assert.equal(settlements.length, 3);
  for (const settlement of settlements) {
    const fields = settlement.fields as Record<string, unknown>;
    assert.equal(fields.pricing, undefined);
    assert.equal(fields.calculatedCostUsd, undefined);
  }
  // The third settlement still retains its explicit reported evidence.
  const last = settlements[2]!.fields as Record<string, unknown>;
  assert.equal(last.reportedCostUsd, 0.03);
});

test('absent resolver preserves the legacy unpriced settlement shape', () => {
  const facts: AnalyticsObservation[] = [];
  const details: AnalyticsDetailCapture[] = [];
  const terminal = result(invocation({
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
  }));
  assert.equal(captureSubagentTerminalResult(terminal, context({ facts, details })), 'submitted');
  const settlements = providerSettlementFacts(facts);
  assert.equal(settlements.length, 1);
  const fields = settlements[0]!.fields as Record<string, unknown>;
  assert.equal(fields.pricing, undefined);
  assert.equal(fields.coverage, 'known');
});

test('recorder prices a complete-channel subagent settlement from the catalog snapshot', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-subagent-settlement-pricing-'));
  const recorder = new SqliteAnalyticsRecorder(path.join(root, 'analytics.sqlite'));
  try {
    const facts: AnalyticsObservation[] = [];
    const details: AnalyticsDetailCapture[] = [];
    const terminal = result(invocation({
      usage: { input: 4_000, output: 200, cacheRead: 1_000, cacheWrite: 2_000 },
    }));
    assert.equal(captureSubagentTerminalResult(terminal, {
      generationId: 'generation-recorder-pricing',
      captureSubject: { kind: 'session' as const, rootSessionId: 'root-recorder-pricing' },
      sink: recorder,
      factSink: recorder,
      priceSettlement: () => RATES,
    } as never, 'parent-tool'), 'submitted');
    const read = recorder.readProviderSettlementProjection('root-recorder-pricing');
    assert.equal(read.settlements.length, 1);
    const settlement = read.settlements[0]!;
    // 4_000 * 0.075 + 200 * 0.25 + 1_000 * 0.015 + 2_000 * 0 == 365 / 1e6 USD.
    assert.equal(settlement.calculatedCostComplete, true);
    assert.equal(settlement.calculatedCostUsd, 365 / 1_000_000);
    assert.equal(settlement.effectiveCostSource, 'calculated');
    assert.equal(settlement.effectiveCostUsd, 365 / 1_000_000);
    assert.equal(settlement.effectiveCostCoverage, 'known');
  } finally {
    recorder.close();
    rmSync(root, { recursive: true, force: true });
  }
});