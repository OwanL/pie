import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BillableAccounting, type BillableAccountingDeps } from '../../src/host/billable-accounting/service';
import type { BillableInvocationRecord } from '../../src/shared/billable-invocation';

function accountingWithAgentDir(agentDir: string, tempDir: string): BillableAccounting {
  const deps: BillableAccountingDeps = {
    getStorageDir: () => tempDir,
    now: () => new Date(Date.parse('2026-01-01T00:00:00.000Z')),
    scheduleRender: () => undefined,
    dispatchArchEvent: () => undefined,
    getAgentDir: () => agentDir,
    isPrivateSession: () => false,
    sessionIdentity: () => ({ sessionId: 'session-id-1' }),
    currentRunId: () => null,
    activeOperationId: () => null,
    markDerivedExportDirty: () => undefined,
  };
  return new BillableAccounting(deps);
}

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'pie-accounting-pricing-'));
}

test('accounting prices matching providers and keeps unknown providers explicitly unpriced', () => {
  const temp = tempDir();
  const agentDir = mkdtempSync(path.join(tmpdir(), 'pie-accounting-pricing-catalog-'));
  try {
    writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
      providers: {
        'provider-a': {
          models: [{ id: 'model-a', cost: { input: 0.075, output: 0.25, cacheRead: 0.015, cacheWrite: 0 } }],
        },
      },
    }));
    const accounting = accountingWithAgentDir(agentDir, temp);

    accounting.observeAssistantTurnEnded('/sessions/a.jsonl', 'turn-a', 100, {
      inputTokens: 4_000,
      outputTokens: 200,
      cacheReadTokens: 1_000,
      cacheWriteTokens: 2_000,
      totalTokens: 7_200,
    }, undefined, {
      modelId: 'model-a',
      provider: 'provider-a',
      occurredAt: '2026-01-01T00:01:00.000Z',
    });
    // An explicitly named provider without a matching catalog record must not
    // inherit the unique record's rates — the row stays explicitly unpriced.
    accounting.observeAssistantTurnEnded('/sessions/b.jsonl', 'turn-b', 100, {
      inputTokens: 4_000,
      outputTokens: 200,
      cacheReadTokens: 1_000,
      cacheWriteTokens: 2_000,
      totalTokens: 7_200,
    }, undefined, {
      modelId: 'model-a',
      provider: 'other-provider',
      occurredAt: '2026-01-01T00:01:00.000Z',
    });

    const records = accounting.exportRecords().filter((record) => record.kind === 'conversation');
    assert.equal(records.length, 2);
    const priced = records.find((record) => record.provider === 'provider-a');
    assert.ok(priced?.pricing);
    assert.equal(priced.pricing.rateSnapshot?.inputTokensUsdPerMillion, 0.075);
    assert.match(priced.pricing.catalogVersion, /^sha256:[0-9a-f]{64}$/);
    const unpriced = records.find((record) => record.provider === 'other-provider');
    assert.ok(unpriced);
    assert.equal(unpriced.pricing, undefined);
  } finally {
    rmSync(temp, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});
// --- Pricing applicability: scheduled peak window + unsupported cache read ---

// 2026-09-23 is a Wednesday; the fixture window is weekday 12:00–18:00 UTC.
const SCHEDULED_CATALOG = {
  providers: {
    ollama: {
      models: [{
        id: 'deepseek-scheduled',
        cost: {
          input: 0.15,
          output: 0.6,
          cacheRead: 0.003,
          cacheWrite: 0,
          peak: {
            weekdaysUtc: [1, 2, 3, 4, 5],
            startMinutesUtc: 720,
            endMinutesUtc: 1080,
            override: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
          },
        },
      }, {
        id: 'unsupported-cache',
        cost: { input: 0.06, output: 0.24, cacheRead: 0, cacheWrite: 0, cacheReadUnsupported: true },
      }],
    },
  },
};

/** Observe one assistant turn whose derived interval is
 *  `[occurredAt - durationMs, occurredAt]`. */
function observeTurn(
  accounting: BillableAccounting,
  sessionPath: string,
  turnId: string,
  endedAtIso: string,
  durationMs: number,
  usageOverrides: Record<string, unknown> = {},
  modelId = 'deepseek-scheduled',
): void {
  accounting.observeAssistantTurnEnded(sessionPath, turnId, durationMs, {
    inputTokens: 4_000,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 4_200,
    ...usageOverrides,
  }, undefined, {
    modelId,
    provider: 'ollama',
    occurredAt: endedAtIso,
  });
}

function conversationRecord(
  accounting: BillableAccounting,
  turnId: string,
): BillableInvocationRecord | undefined {
  return accounting.exportRecords().find((entry) => entry.sourceId === `assistant:${turnId}`);
}

test('accounting prices a peak-window interval at the override rates', () => {
  const temp = tempDir();
  const agentDir = mkdtempSync(path.join(tmpdir(), 'pie-accounting-pricing-peak-'));
  try {
    writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify(SCHEDULED_CATALOG));
    const accounting = accountingWithAgentDir(agentDir, temp);
    // Wednesday 12:00–13:00 UTC lies entirely inside the peak window.
    observeTurn(accounting, '/sessions/peak.jsonl', 'turn-peak', '2026-09-23T13:00:00.000Z', 3_600_000);
    const priced = conversationRecord(accounting, 'turn-peak');
    assert.ok(priced?.pricing);
    assert.equal(priced.pricing.rateSnapshot?.inputTokensUsdPerMillion, 0.3);
    assert.equal(priced.pricing.rateSnapshot?.outputTokensUsdPerMillion, 1.2);
    assert.equal(priced.pricing.rateSnapshot?.cacheReadTokensUsdPerMillion, 0.006);
  } finally {
    rmSync(temp, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test('accounting prices off-peak weekday and weekend intervals at base rates', () => {
  const temp = tempDir();
  const agentDir = mkdtempSync(path.join(tmpdir(), 'pie-accounting-pricing-offpeak-'));
  try {
    writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify(SCHEDULED_CATALOG));
    const accounting = accountingWithAgentDir(agentDir, temp);
    // Wednesday 19:00–20:00 UTC (outside the window).
    observeTurn(accounting, '/sessions/offpeak.jsonl', 'turn-offpeak', '2026-09-23T20:00:00.000Z', 3_600_000);
    const offpeak = conversationRecord(accounting, 'turn-offpeak');
    assert.ok(offpeak?.pricing);
    assert.equal(offpeak.pricing.rateSnapshot?.inputTokensUsdPerMillion, 0.15);
    assert.equal(offpeak.pricing.rateSnapshot?.outputTokensUsdPerMillion, 0.6);
    assert.equal(offpeak.pricing.rateSnapshot?.cacheReadTokensUsdPerMillion, 0.003);
    // Saturday 13:00–14:00 UTC: weekend is entirely off-peak even inside the
    // clock window.
    observeTurn(accounting, '/sessions/weekend.jsonl', 'turn-weekend', '2026-09-19T14:00:00.000Z', 3_600_000);
    const weekend = conversationRecord(accounting, 'turn-weekend');
    assert.ok(weekend?.pricing);
    assert.equal(weekend.pricing.rateSnapshot?.inputTokensUsdPerMillion, 0.15);
    assert.equal(weekend.pricing.rateSnapshot?.outputTokensUsdPerMillion, 0.6);
  } finally {
    rmSync(temp, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test('accounting keeps band-crossing intervals explicitly unpriced', () => {
  const temp = tempDir();
  const agentDir = mkdtempSync(path.join(tmpdir(), 'pie-accounting-pricing-crossing-'));
  try {
    writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify(SCHEDULED_CATALOG));
    const accounting = accountingWithAgentDir(agentDir, temp);
    // Wednesday 11:30–12:30 UTC straddles the 12:00 window opening.
    observeTurn(accounting, '/sessions/crossing.jsonl', 'turn-crossing', '2026-09-23T12:30:00.000Z', 3_600_000);
    const record = conversationRecord(accounting, 'turn-crossing');
    assert.equal(record?.pricing, undefined);
  } finally {
    rmSync(temp, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test('accounting keeps scheduled intervals without reliable timestamps unpriced', () => {
  const temp = tempDir();
  const agentDir = mkdtempSync(path.join(tmpdir(), 'pie-accounting-pricing-missing-'));
  try {
    writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify(SCHEDULED_CATALOG));
    const accounting = accountingWithAgentDir(agentDir, temp);
    // An auxiliary sample with only occurredAt carries no reliable start:
    // scheduled pricing stays unknown instead of falling back to one rate.
    accounting.observeAuxiliaryLlmUsage('/sessions/no-times.jsonl', {
      kind: 'other',
      sourceId: 'aux-no-times',
      occurredAt: '2026-09-23T13:00:00.000Z',
      modelId: 'deepseek-scheduled',
      provider: 'ollama',
      inputTokens: 4_000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      tokenChannelsKnown: true,
    });
    const record = accounting.exportRecords().find((entry) => entry.sourceId === 'aux-no-times');
    assert.ok(record);
    assert.equal(record.pricing, undefined);
    // The static model in the same shape still prices normally.
    const staticCatalog = {
      providers: {
        ollama: {
          models: [{ id: 'static', cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 } }],
        },
      },
    };
    writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify(staticCatalog));
    accounting.observeAuxiliaryLlmUsage('/sessions/static.jsonl', {
      kind: 'other',
      sourceId: 'aux-static',
      occurredAt: '2026-09-23T13:00:00.000Z',
      modelId: 'static',
      provider: 'ollama',
      inputTokens: 4_000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      tokenChannelsKnown: true,
    });
    const staticRecord = accounting.exportRecords().find((entry) => entry.sourceId === 'aux-static');
    assert.ok(staticRecord?.pricing);
    assert.equal(staticRecord.pricing.rateSnapshot?.inputTokensUsdPerMillion, 0.1);
  } finally {
    rmSync(temp, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test('accounting keeps unsupported cache-read usage unpriced and prices zero cache-read', () => {
  const temp = tempDir();
  const agentDir = mkdtempSync(path.join(tmpdir(), 'pie-accounting-pricing-cache-'));
  try {
    writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify(SCHEDULED_CATALOG));
    const accounting = accountingWithAgentDir(agentDir, temp);
    // Positive cache-read usage on an unsupported-cache model: unpriced.
    observeTurn(accounting, '/sessions/cache-used.jsonl', 'turn-cache-used', '2026-09-23T13:00:00.000Z', 3_600_000, {
      cacheReadTokens: 1_000,
    }, 'unsupported-cache');
    const used = conversationRecord(accounting, 'turn-cache-used');
    assert.equal(used?.pricing, undefined);
    // Zero cache-read usage still prices the base rates.
    observeTurn(accounting, '/sessions/cache-free.jsonl', 'turn-cache-free', '2026-09-23T13:00:00.000Z', 3_600_000, {}, 'unsupported-cache');
    const free = conversationRecord(accounting, 'turn-cache-free');
    assert.ok(free?.pricing);
    assert.equal(free.pricing.rateSnapshot?.inputTokensUsdPerMillion, 0.06);
    assert.equal(free.pricing.rateSnapshot?.outputTokensUsdPerMillion, 0.24);
    assert.equal(free.pricing.rateSnapshot?.cacheReadTokensUsdPerMillion, 0);
  } finally {
    rmSync(temp, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});
