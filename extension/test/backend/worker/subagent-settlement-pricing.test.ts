import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { subagentSettlementPricingResolver } from '../../../src/backend/subagent-settlement-pricing';

function agentDirWith(models: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'pie-subagent-pricing-'));
  writeFileSync(path.join(dir, 'models.json'), JSON.stringify(models));
  return dir;
}

test('resolver returns provider-qualified catalog rates for one settlement', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pie-subagent-pricing-qualified-'));
  try {
    writeFileSync(path.join(dir, 'models.json'), JSON.stringify({
      providers: {
        'provider-a': {
          models: [{ id: 'model-a', cost: { input: 0.075, output: 0.25, cacheRead: 0.015, cacheWrite: 0 } }],
        },
        'provider-b': {
          models: [{ id: 'model-a', cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 } }],
        },
      },
    }));
    const resolve = subagentSettlementPricingResolver(dir);
    const providerARates = resolve({
      provider: 'provider-a',
      model: 'model-a',
      usage: { input: 4_000, output: 200, cacheRead: 1_000, cacheWrite: 2_000 },
    });
    assert.ok(providerARates);
    assert.match(providerARates.catalogVersion ?? '', /^sha256:[0-9a-f]{64}$/);
    assert.equal(providerARates.inputUsdPerMillionTokens, 0.075);
    assert.equal(providerARates.outputUsdPerMillionTokens, 0.25);
    assert.equal(providerARates.cacheReadUsdPerMillionTokens, 0.015);
    assert.equal(providerARates.cacheWriteUsdPerMillionTokens, 0);
    // Shared model ids resolve by provider, never by first match.
    assert.deepEqual(resolve({
      provider: 'provider-b',
      model: 'model-a',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }), {
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 2,
      cacheReadUsdPerMillionTokens: 0.1,
      cacheWriteUsdPerMillionTokens: 0.2,
      catalogVersion: providerARates.catalogVersion,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolver tolerates provider-qualified runtime model ids and selects long-context tiers', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pie-subagent-pricing-tiers-'));
  try {
    writeFileSync(path.join(dir, 'models.json'), JSON.stringify({
      providers: {
        'provider-a': {
          models: [{
            id: 'model-a',
            cost: {
              input: 0.075,
              output: 0.25,
              cacheRead: 0.015,
              cacheWrite: 0,
              tiers: [{
                inputTokensAbove: 100_000,
                input: 0.15,
                output: 0.5,
                cacheRead: 0.03,
                cacheWrite: 0,
              }],
            },
          }],
        },
      },
    }));
    const resolve = subagentSettlementPricingResolver(dir);
    const tiered = resolve({
      provider: 'provider-a',
      model: 'provider-a/model-a',
      usage: { input: 150_000, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    assert.ok(tiered);
    assert.equal(tiered.inputUsdPerMillionTokens, 0.15);
    assert.equal(tiered.outputUsdPerMillionTokens, 0.5);
    assert.equal(tiered.cacheReadUsdPerMillionTokens, 0.03);
    assert.equal(tiered.cacheWriteUsdPerMillionTokens, 0);
    assert.ok(tiered.catalogVersion);
    // Bare and qualified ids share one catalog version identity.
    assert.equal(resolve({
      provider: 'provider-a',
      model: 'model-a',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })?.catalogVersion, tiered.catalogVersion);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolver keeps unknown pricing explicitly undefined', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pie-subagent-pricing-unknown-'));
  try {
    writeFileSync(path.join(dir, 'models.json'), JSON.stringify({
      providers: {
        'provider-a': {
          models: [{ id: 'model-a', cost: { input: 0.075, output: 0.25, cacheRead: 0.015, cacheWrite: 0 } }],
        },
        'provider-b': {
          models: [{ id: 'model-a', cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 } }],
        },
      },
    }));
    const resolve = subagentSettlementPricingResolver(dir);
    assert.equal(resolve({
      provider: 'provider-a',
      model: 'unlisted-model',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    }), undefined);
    // A model id shared by several providers needs the provider dimension;
    // an unlisted provider must not pick one of the colliding rates.
    assert.equal(resolve({
      provider: 'other-provider',
      model: 'model-a',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    }), undefined);
    assert.equal(resolve({
      model: 'model-a',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    }), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an explicitly unknown provider never receives another provider\'s unique rate', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pie-subagent-pricing-wrong-provider-'));
  try {
    writeFileSync(path.join(dir, 'models.json'), JSON.stringify({
      providers: {
        'provider-a': {
          models: [{ id: 'model-a', cost: { input: 0.075, output: 0.25, cacheRead: 0.015, cacheWrite: 0 } }],
        },
      },
    }));
    const resolve = subagentSettlementPricingResolver(dir);
    const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
    // A matching provider prices the unique record.
    assert.equal(resolve({ provider: 'provider-a', model: 'model-a', usage })?.inputUsdPerMillionTokens, 0.075);
    // An explicitly named provider without a matching record stays unpriced
    // even though the record is unique — no arbitrary cross-provider pricing.
    assert.equal(resolve({ provider: 'other-provider', model: 'model-a', usage }), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('changing only the generated history file invalidates rates and catalogVersion', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pie-subagent-pricing-history-'));
  try {
    writeFileSync(path.join(dir, 'models.json'), JSON.stringify({
      providers: {
        'provider-a': {
          models: [{ id: 'model-a', cost: { input: 0.075, output: 0.25, cacheRead: 0.015, cacheWrite: 0 } }],
        },
      },
    }));
    mkdirSync(path.join(dir, 'analysis'), { recursive: true });
    const historyPath = path.join(dir, 'analysis', 'model-pricing-history.json');
    const resolve = subagentSettlementPricingResolver(dir);
    const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
    // No history yet: the history-only model stays unpriced.
    assert.equal(resolve({ provider: 'provider-a', model: 'model-h', usage }), undefined);

    writeFileSync(historyPath, JSON.stringify({
      models: [{ provider: 'provider-a', id: 'model-h', cost: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8 } }],
    }));
    const first = resolve({ provider: 'provider-a', model: 'model-h', usage });
    assert.ok(first);
    assert.equal(first.inputUsdPerMillionTokens, 5);
    assert.match(first.catalogVersion ?? '', /^sha256:[0-9a-f]{64}$/);

    // Only the history file changes; the active catalog is untouched.
    writeFileSync(historyPath, JSON.stringify({
      models: [{ provider: 'provider-a', id: 'model-h', cost: { input: 9, output: 10, cacheRead: 11, cacheWrite: 12 } }],
    }));
    const second = resolve({ provider: 'provider-a', model: 'model-h', usage });
    assert.ok(second);
    assert.equal(second.inputUsdPerMillionTokens, 9);
    assert.notEqual(second.catalogVersion, first.catalogVersion);
    // The unqualified unique history record still resolves.
    assert.equal(resolve({ model: 'model-h', usage })?.inputUsdPerMillionTokens, 9);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing or unreadable catalog keeps every settlement unpriced', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pie-subagent-pricing-missing-'));
  const resolve = subagentSettlementPricingResolver(dir);
  assert.equal(resolve({
    provider: 'provider-a',
    model: 'model-a',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  }), undefined);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(resolve({
    provider: 'provider-a',
    model: 'model-a',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  }), undefined);
});
// --- Pricing applicability: scheduled peak window + unsupported cache read ---

// 2026-09-23 is a Wednesday; the fixture window is weekday 12:00–18:00 UTC.
const PEAK_CATALOG = {
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

function resolverFor(catalog: Record<string, unknown> = PEAK_CATALOG) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pie-subagent-pricing-applicability-'));
  writeFileSync(path.join(dir, 'models.json'), JSON.stringify(catalog));
  const resolve = subagentSettlementPricingResolver(dir);
  const cleanup = (): void => rmSync(dir, { recursive: true, force: true });
  return { resolve, cleanup };
}

test('resolver prices a settlement entirely inside the weekday peak window at override rates', () => {
  const { resolve, cleanup } = resolverFor();
  try {
    // Wednesday 12:30–13:00 UTC.
    const rates = resolve({
      provider: 'ollama',
      model: 'deepseek-scheduled',
      usage: { input: 4_000, output: 200, cacheRead: 1_000, cacheWrite: 0 },
      startedAtMs: Date.parse('2026-09-23T12:30:00Z'),
      endedAtMs: Date.parse('2026-09-23T13:00:00Z'),
    });
    assert.ok(rates);
    assert.equal(rates.inputUsdPerMillionTokens, 0.3);
    assert.equal(rates.outputUsdPerMillionTokens, 1.2);
    assert.equal(rates.cacheReadUsdPerMillionTokens, 0.006);
    assert.equal(rates.cacheWriteUsdPerMillionTokens, 0);
  } finally {
    cleanup();
  }
});

test('resolver prices off-peak weekday and weekend settlements at base rates', () => {
  const { resolve, cleanup } = resolverFor();
  try {
    // Wednesday 19:00–20:00 UTC (outside the window).
    const evening = resolve({
      provider: 'ollama',
      model: 'deepseek-scheduled',
      usage: { input: 4_000, output: 200, cacheRead: 1_000, cacheWrite: 0 },
      startedAtMs: Date.parse('2026-09-23T19:00:00Z'),
      endedAtMs: Date.parse('2026-09-23T20:00:00Z'),
    });
    assert.ok(evening);
    assert.equal(evening.inputUsdPerMillionTokens, 0.15);
    assert.equal(evening.outputUsdPerMillionTokens, 0.6);
    assert.equal(evening.cacheReadUsdPerMillionTokens, 0.003);
    // Saturday 13:00–14:00 UTC (weekend is always off-peak).
    const weekend = resolve({
      provider: 'ollama',
      model: 'deepseek-scheduled',
      usage: { input: 4_000, output: 200, cacheRead: 1_000, cacheWrite: 0 },
      startedAtMs: Date.parse('2026-09-19T13:00:00Z'),
      endedAtMs: Date.parse('2026-09-19T14:00:00Z'),
    });
    assert.ok(weekend);
    assert.equal(weekend.inputUsdPerMillionTokens, 0.15);
    assert.equal(weekend.outputUsdPerMillionTokens, 0.6);
  } finally {
    cleanup();
  }
});

test('resolver keeps band-crossing settlements explicitly unpriced', () => {
  const { resolve, cleanup } = resolverFor();
  try {
    // Wednesday 11:30–12:30 UTC straddles the 12:00 window opening.
    assert.equal(resolve({
      provider: 'ollama',
      model: 'deepseek-scheduled',
      usage: { input: 4_000, output: 200, cacheRead: 0, cacheWrite: 0 },
      startedAtMs: Date.parse('2026-09-23T11:30:00Z'),
      endedAtMs: Date.parse('2026-09-23T12:30:00Z'),
    }), undefined);
    // Wednesday 17:30–18:30 UTC straddles the 18:00 window close.
    assert.equal(resolve({
      provider: 'ollama',
      model: 'deepseek-scheduled',
      usage: { input: 4_000, output: 200, cacheRead: 0, cacheWrite: 0 },
      startedAtMs: Date.parse('2026-09-23T17:30:00Z'),
      endedAtMs: Date.parse('2026-09-23T18:30:00Z'),
    }), undefined);
    // A day-long interval necessarily spans off-peak time.
    assert.equal(resolve({
      provider: 'ollama',
      model: 'deepseek-scheduled',
      usage: { input: 4_000, output: 200, cacheRead: 0, cacheWrite: 0 },
      startedAtMs: Date.parse('2026-09-23T00:00:00Z'),
      endedAtMs: Date.parse('2026-09-24T00:00:00Z'),
    }), undefined);
  } finally {
    cleanup();
  }
});

test('resolver keeps scheduled settlements without reliable timestamps unpriced', () => {
  const { resolve, cleanup } = resolverFor();
  try {
    // Missing, partial, invalid, or reversed endpoints are unknown — never a
    // static-rate fallback and never synthesized timing.
    assert.equal(resolve({
      provider: 'ollama',
      model: 'deepseek-scheduled',
      usage: { input: 4_000, output: 200, cacheRead: 0, cacheWrite: 0 },
    }), undefined);
    assert.equal(resolve({
      provider: 'ollama',
      model: 'deepseek-scheduled',
      usage: { input: 4_000, output: 200, cacheRead: 0, cacheWrite: 0 },
      endedAtMs: Date.parse('2026-09-23T13:00:00Z'),
    }), undefined);
    assert.equal(resolve({
      provider: 'ollama',
      model: 'deepseek-scheduled',
      usage: { input: 4_000, output: 200, cacheRead: 0, cacheWrite: 0 },
      startedAtMs: Number.NaN,
      endedAtMs: Date.parse('2026-09-23T13:00:00Z'),
    }), undefined);
    assert.equal(resolve({
      provider: 'ollama',
      model: 'deepseek-scheduled',
      usage: { input: 4_000, output: 200, cacheRead: 0, cacheWrite: 0 },
      startedAtMs: Date.parse('2026-09-23T13:00:00Z'),
      endedAtMs: Date.parse('2026-09-23T12:00:00Z'),
    }), undefined);
    // Static pricing is unaffected by missing timestamps.
    const staticCatalog = {
      providers: {
        ollama: {
          models: [{ id: 'static', cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 } }],
        },
      },
    };
    const staticResolver = resolverFor(staticCatalog);
    try {
      assert.deepEqual(staticResolver.resolve({
        provider: 'ollama',
        model: 'static',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }), {
        inputUsdPerMillionTokens: 0.1,
        outputUsdPerMillionTokens: 0.2,
        cacheReadUsdPerMillionTokens: 0,
        cacheWriteUsdPerMillionTokens: 0,
        catalogVersion: staticResolver.resolve({
          provider: 'ollama',
          model: 'static',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        })?.catalogVersion,
      });
    } finally {
      staticResolver.cleanup();
    }
  } finally {
    cleanup();
  }
});

test('resolver keeps unsupported cache-read settlements unpriced and prices zero cache-read', () => {
  const { resolve, cleanup } = resolverFor();
  try {
    // Positive cache-read usage: unpriced even with valid interval evidence.
    assert.equal(resolve({
      provider: 'ollama',
      model: 'unsupported-cache',
      usage: { input: 4_000, output: 200, cacheRead: 1_000, cacheWrite: 0 },
      startedAtMs: Date.parse('2026-09-23T13:00:00Z'),
      endedAtMs: Date.parse('2026-09-23T13:30:00Z'),
    }), undefined);
    // Zero cache-read usage still prices the base rates.
    const zeroCacheRead = resolve({
      provider: 'ollama',
      model: 'unsupported-cache',
      usage: { input: 4_000, output: 200, cacheRead: 0, cacheWrite: 0 },
      startedAtMs: Date.parse('2026-09-23T13:00:00Z'),
      endedAtMs: Date.parse('2026-09-23T13:30:00Z'),
    });
    assert.ok(zeroCacheRead);
    assert.equal(zeroCacheRead.inputUsdPerMillionTokens, 0.06);
    assert.equal(zeroCacheRead.outputUsdPerMillionTokens, 0.24);
    assert.equal(zeroCacheRead.cacheReadUsdPerMillionTokens, 0);
  } finally {
    cleanup();
  }
});
