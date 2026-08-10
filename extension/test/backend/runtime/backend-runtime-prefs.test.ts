import test from 'node:test';
import assert from 'node:assert/strict';

import { handleBackendRequest } from '../../../src/backend/request-handler';
import { EXTENSION_TOGGLES_ENV, HISTORY_COMPACTION_ENV, NESTED_ALLOWED_BUCKETS_ENV, PROVIDER_TOGGLES_ENV, SUBAGENT_BUCKETS_ENV, SUBAGENT_PROVIDER_DEFAULTS_ENV, SUBAGENT_ROUTE_AROUND_SATURATED_PROVIDERS_ENV, SUBAGENT_FALLBACK_ON_PROVIDER_FAILURE_ENV } from '../../../src/shared/protocol';
import { validateRuntimePrefsSet } from '../../../src/backend/rpc';
import { ProviderGate } from '../../../src/backend/provider-gate';
import { AUTONOMOUS_MODE_ENV } from '../../../../shared/autonomous-mode.js';

const SUBAGENT_ALWAYS_PARENT_MODEL_ENV = 'PIE_SUBAGENT_ALWAYS_PARENT_MODEL';
const SUBAGENT_MAX_DEPTH_ENV = 'PIE_SUBAGENT_MAX_DEPTH';
const SUBAGENT_MAX_TREE_SESSIONS_ENV = 'PIE_SUBAGENT_MAX_TREE_SESSIONS';
const SUBAGENT_MAX_INFLIGHT_ENV = 'PIE_SUBAGENT_MAX_INFLIGHT';

test('runtimePrefs.set validates and mirrors proactive history compaction', async (t) => {
  const previous = process.env[HISTORY_COMPACTION_ENV];
  t.after(() => {
    if (previous === undefined) delete process.env[HISTORY_COMPACTION_ENV];
    else process.env[HISTORY_COMPACTION_ENV] = previous;
  });
  const historyCompaction = {
    enabled: true,
    thresholdMode: 'percentage',
    softThreshold: 70,
    hardThreshold: 85,
    keepRecentTokens: 30_000,
    summaryInstructions: '',
    summaryThinkingLevel: 'inherit',
    summaryModel: null,
    modelProfiles: {},
  };

  const result = await handleBackendRequest({} as any, {
    id: 'test-runtime-prefs-history-compaction',
    method: 'runtimePrefs.set',
    params: { providerToggles: {}, extensionToggles: {}, historyCompaction },
  }) as { historyCompaction?: typeof historyCompaction };

  assert.deepEqual(result.historyCompaction, historyCompaction);
  assert.equal(process.env[HISTORY_COMPACTION_ENV], JSON.stringify(historyCompaction));
  assert.throws(
    () => validateRuntimePrefsSet({
      providerToggles: {},
      extensionToggles: {},
      historyCompaction: { ...historyCompaction, softThreshold: 90, hardThreshold: 80 },
    }),
    /soft < hard/,
  );
  assert.throws(
    () => validateRuntimePrefsSet({
      providerToggles: {},
      extensionToggles: {},
      historyCompaction: { ...historyCompaction, modelProfiles: { 'p/m': { softThreshold: 500, hardThreshold: 100_000, keepRecentTokens: 100 } } },
    }),
    /0 <= keep < soft < hard/,
  );
});

test('runtimePrefs.set mirrors provider and extension toggles into backend environment', async (t) => {
  const previousProvider = process.env[PROVIDER_TOGGLES_ENV];
  const previousExtension = process.env[EXTENSION_TOGGLES_ENV];
  const previousAlwaysParent = process.env[SUBAGENT_ALWAYS_PARENT_MODEL_ENV];
  const previousBuckets = process.env[SUBAGENT_BUCKETS_ENV];
  t.after(() => {
    if (previousProvider === undefined) {
      delete process.env[PROVIDER_TOGGLES_ENV];
    } else {
      process.env[PROVIDER_TOGGLES_ENV] = previousProvider;
    }
    if (previousExtension === undefined) {
      delete process.env[EXTENSION_TOGGLES_ENV];
    } else {
      process.env[EXTENSION_TOGGLES_ENV] = previousExtension;
    }
    if (previousAlwaysParent === undefined) {
      delete process.env[SUBAGENT_ALWAYS_PARENT_MODEL_ENV];
    } else {
      process.env[SUBAGENT_ALWAYS_PARENT_MODEL_ENV] = previousAlwaysParent;
    }
    if (previousBuckets === undefined) {
      delete process.env[SUBAGENT_BUCKETS_ENV];
    } else {
      process.env[SUBAGENT_BUCKETS_ENV] = previousBuckets;
    }
  });

  const providerToggles = { ollama: false, 'github-copilot': true };
  const extensionToggles = { 'skill-pruner': false };
  const result = await handleBackendRequest({} as any, {
    id: 'test-runtime-prefs',
    method: 'runtimePrefs.set',
    params: { providerToggles, extensionToggles },
  });

  assert.deepEqual(result, { providerToggles, extensionToggles, autonomousMode: undefined, subagentAlwaysParentModel: undefined, subagentRouteAroundSaturatedProviders: undefined, subagentFallbackOnProviderFailure: undefined, subagentMaxDepth: undefined, subagentMaxTreeSessions: undefined, subagentMaxInflight: undefined, bashWarmPoolSize: undefined, bashFastPath: undefined, bashShellPath: undefined, bashWarmupTimeoutMs: undefined, bashDefaultTimeout: undefined, subagentBuckets: undefined, subagentNestedAllowedBuckets: undefined, subagentDropTools: undefined, providerConcurrency: undefined });
  assert.equal(process.env[PROVIDER_TOGGLES_ENV], JSON.stringify(providerToggles));
  assert.equal(process.env[EXTENSION_TOGGLES_ENV], JSON.stringify(extensionToggles));
  // When the field is omitted, the env var must not be touched.
  assert.equal(process.env[SUBAGENT_ALWAYS_PARENT_MODEL_ENV], previousAlwaysParent);
  assert.equal(process.env[SUBAGENT_BUCKETS_ENV], previousBuckets);
});

test('runtimePrefs.set applies autonomous mode to live sessions and mirrors its environment flag', async (t) => {
  const previous = process.env[AUTONOMOUS_MODE_ENV];
  t.after(() => {
    if (previous === undefined) delete process.env[AUTONOMOUS_MODE_ENV];
    else process.env[AUTONOMOUS_MODE_ENV] = previous;
  });
  const applied: boolean[] = [];

  const result = await handleBackendRequest({
    setAutonomousMode: (enabled: boolean) => applied.push(enabled),
  } as any, {
    id: 'test-runtime-prefs-autonomous',
    method: 'runtimePrefs.set',
    params: { providerToggles: {}, extensionToggles: {}, autonomousMode: true },
  }) as { autonomousMode?: boolean };

  assert.equal(result.autonomousMode, true);
  assert.deepEqual(applied, [true]);
  assert.equal(process.env[AUTONOMOUS_MODE_ENV], '1');
  assert.throws(
    () => validateRuntimePrefsSet({ autonomousMode: 'yes' }),
    /autonomousMode must be a boolean/,
  );
});

test('runtimePrefs.set mirrors subagent provider defaults into the backend environment', async (t) => {
  const previous = process.env[SUBAGENT_PROVIDER_DEFAULTS_ENV];
  t.after(() => {
    if (previous === undefined) delete process.env[SUBAGENT_PROVIDER_DEFAULTS_ENV];
    else process.env[SUBAGENT_PROVIDER_DEFAULTS_ENV] = previous;
  });

  const subagentProviderDefaults = { anthropic: false, openai: true };
  const result = await handleBackendRequest({} as any, {
    id: 'test-runtime-prefs-subagent-provider-defaults',
    method: 'runtimePrefs.set',
    params: { providerToggles: {}, extensionToggles: {}, subagentProviderDefaults },
  }) as { subagentProviderDefaults?: Record<string, boolean> };

  assert.deepEqual(result.subagentProviderDefaults, subagentProviderDefaults);
  assert.equal(process.env[SUBAGENT_PROVIDER_DEFAULTS_ENV], JSON.stringify(subagentProviderDefaults));
});

test('runtimePrefs.set writes the subagent always-parent-model env var when provided', async (t) => {
  const previousAlwaysParent = process.env[SUBAGENT_ALWAYS_PARENT_MODEL_ENV];
  t.after(() => {
    if (previousAlwaysParent === undefined) {
      delete process.env[SUBAGENT_ALWAYS_PARENT_MODEL_ENV];
    } else {
      process.env[SUBAGENT_ALWAYS_PARENT_MODEL_ENV] = previousAlwaysParent;
    }
  });

  delete process.env[SUBAGENT_ALWAYS_PARENT_MODEL_ENV];
  const result = await handleBackendRequest({} as any, {
    id: 'test-runtime-prefs-parent',
    method: 'runtimePrefs.set',
    params: { providerToggles: {}, extensionToggles: {}, subagentAlwaysParentModel: true },
  });

  assert.deepEqual(result, { providerToggles: {}, extensionToggles: {}, autonomousMode: undefined, subagentAlwaysParentModel: true, subagentRouteAroundSaturatedProviders: undefined, subagentFallbackOnProviderFailure: undefined, subagentMaxDepth: undefined, subagentMaxTreeSessions: undefined, subagentMaxInflight: undefined, bashWarmPoolSize: undefined, bashFastPath: undefined, bashShellPath: undefined, bashWarmupTimeoutMs: undefined, bashDefaultTimeout: undefined, subagentBuckets: undefined, subagentNestedAllowedBuckets: undefined, subagentDropTools: undefined, providerConcurrency: undefined });
  assert.equal(process.env[SUBAGENT_ALWAYS_PARENT_MODEL_ENV], '1');
});

test('runtimePrefs.set validates and mirrors subagent capacity routing', async (t) => {
  const previous = process.env[SUBAGENT_ROUTE_AROUND_SATURATED_PROVIDERS_ENV];
  t.after(() => {
    if (previous === undefined) delete process.env[SUBAGENT_ROUTE_AROUND_SATURATED_PROVIDERS_ENV];
    else process.env[SUBAGENT_ROUTE_AROUND_SATURATED_PROVIDERS_ENV] = previous;
  });

  const result = await handleBackendRequest({} as any, {
    id: 'test-runtime-prefs-capacity-routing',
    method: 'runtimePrefs.set',
    params: {
      providerToggles: {},
      extensionToggles: {},
      subagentRouteAroundSaturatedProviders: true,
    },
  }) as { subagentRouteAroundSaturatedProviders?: boolean };

  assert.equal(result.subagentRouteAroundSaturatedProviders, true);
  assert.equal(process.env[SUBAGENT_ROUTE_AROUND_SATURATED_PROVIDERS_ENV], '1');
  assert.throws(
    () => validateRuntimePrefsSet({ subagentRouteAroundSaturatedProviders: 'yes' }),
    /subagentRouteAroundSaturatedProviders must be a boolean/,
  );
});

test('runtimePrefs.set validates and mirrors provider-failure fallback', async (t) => {
  const previous = process.env[SUBAGENT_FALLBACK_ON_PROVIDER_FAILURE_ENV];
  t.after(() => {
    if (previous === undefined) delete process.env[SUBAGENT_FALLBACK_ON_PROVIDER_FAILURE_ENV];
    else process.env[SUBAGENT_FALLBACK_ON_PROVIDER_FAILURE_ENV] = previous;
  });

  const result = await handleBackendRequest({} as any, {
    id: 'test-runtime-prefs-provider-fallback',
    method: 'runtimePrefs.set',
    params: {
      providerToggles: {},
      extensionToggles: {},
      subagentFallbackOnProviderFailure: false,
    },
  }) as { subagentFallbackOnProviderFailure?: boolean };

  assert.equal(result.subagentFallbackOnProviderFailure, false);
  assert.equal(process.env[SUBAGENT_FALLBACK_ON_PROVIDER_FAILURE_ENV], '0');
  assert.throws(
    () => validateRuntimePrefsSet({ subagentFallbackOnProviderFailure: 'yes' }),
    /subagentFallbackOnProviderFailure must be a boolean/,
  );
});

test('runtimePrefs.set writes 0 when subagentAlwaysParentModel is false', async (t) => {
  const previousAlwaysParent = process.env[SUBAGENT_ALWAYS_PARENT_MODEL_ENV];
  t.after(() => {
    if (previousAlwaysParent === undefined) {
      delete process.env[SUBAGENT_ALWAYS_PARENT_MODEL_ENV];
    } else {
      process.env[SUBAGENT_ALWAYS_PARENT_MODEL_ENV] = previousAlwaysParent;
    }
  });

  const result = await handleBackendRequest({} as any, {
    id: 'test-runtime-prefs-parent-false',
    method: 'runtimePrefs.set',
    params: { providerToggles: {}, extensionToggles: {}, subagentAlwaysParentModel: false },
  }) as { subagentAlwaysParentModel?: boolean };

  assert.equal(result.subagentAlwaysParentModel, false);
  assert.equal(process.env[SUBAGENT_ALWAYS_PARENT_MODEL_ENV], '0');
});

test('runtimePrefs.set writes the subagent nesting env vars when provided', async (t) => {
  const prevDepth = process.env[SUBAGENT_MAX_DEPTH_ENV];
  const prevTree = process.env[SUBAGENT_MAX_TREE_SESSIONS_ENV];
  t.after(() => {
    if (prevDepth === undefined) delete process.env[SUBAGENT_MAX_DEPTH_ENV];
    else process.env[SUBAGENT_MAX_DEPTH_ENV] = prevDepth;
    if (prevTree === undefined) delete process.env[SUBAGENT_MAX_TREE_SESSIONS_ENV];
    else process.env[SUBAGENT_MAX_TREE_SESSIONS_ENV] = prevTree;
  });

  const result = await handleBackendRequest({} as any, {
    id: 'test-runtime-prefs-nesting',
    method: 'runtimePrefs.set',
    params: { providerToggles: {}, extensionToggles: {}, subagentMaxDepth: 6, subagentMaxTreeSessions: 80, subagentMaxInflight: 3 },
  }) as { subagentMaxDepth?: number; subagentMaxTreeSessions?: number; subagentMaxInflight?: number };

  assert.equal(result.subagentMaxDepth, 6);
  assert.equal(result.subagentMaxTreeSessions, 80);
  assert.equal(result.subagentMaxInflight, 3);
  assert.equal(process.env[SUBAGENT_MAX_DEPTH_ENV], '6');
  assert.equal(process.env[SUBAGENT_MAX_TREE_SESSIONS_ENV], '80');
  assert.equal(process.env[SUBAGENT_MAX_INFLIGHT_ENV], '3');
});

test('runtimePrefs.set leaves nesting env vars untouched when omitted', async (t) => {
  const prevDepth = process.env[SUBAGENT_MAX_DEPTH_ENV];
  const prevTree = process.env[SUBAGENT_MAX_TREE_SESSIONS_ENV];
  const prevInflight = process.env[SUBAGENT_MAX_INFLIGHT_ENV];
  t.after(() => {
    if (prevDepth === undefined) delete process.env[SUBAGENT_MAX_DEPTH_ENV];
    else process.env[SUBAGENT_MAX_DEPTH_ENV] = prevDepth;
    if (prevTree === undefined) delete process.env[SUBAGENT_MAX_TREE_SESSIONS_ENV];
    else process.env[SUBAGENT_MAX_TREE_SESSIONS_ENV] = prevTree;
    if (prevInflight === undefined) delete process.env[SUBAGENT_MAX_INFLIGHT_ENV];
    else process.env[SUBAGENT_MAX_INFLIGHT_ENV] = prevInflight;
  });

  delete process.env[SUBAGENT_MAX_DEPTH_ENV];
  delete process.env[SUBAGENT_MAX_TREE_SESSIONS_ENV];
  delete process.env[SUBAGENT_MAX_INFLIGHT_ENV];
  await handleBackendRequest({} as any, {
    id: 'test-runtime-prefs-nesting-omitted',
    method: 'runtimePrefs.set',
    params: { providerToggles: {}, extensionToggles: {} },
  });

  assert.equal(process.env[SUBAGENT_MAX_DEPTH_ENV], undefined);
  assert.equal(process.env[SUBAGENT_MAX_TREE_SESSIONS_ENV], undefined);
  assert.equal(process.env[SUBAGENT_MAX_INFLIGHT_ENV], undefined);
});

test('runtimePrefs.set rejects out-of-range nesting values', () => {
  assert.throws(() =>
    validateRuntimePrefsSet({ providerToggles: {}, extensionToggles: {}, subagentMaxDepth: 99 }),
  );
  assert.throws(() =>
    validateRuntimePrefsSet({ providerToggles: {}, extensionToggles: {}, subagentMaxTreeSessions: 1 }),
  );
  assert.throws(() =>
    validateRuntimePrefsSet({ providerToggles: {}, extensionToggles: {}, subagentMaxDepth: 4.5 }),
  );
});

test('runtimePrefs.set validates providerConcurrency override bounds', () => {
  const valid = validateRuntimePrefsSet({
    providerConcurrency: {
      openai: {
        maxConcurrentRequests: 2,
        afterburnSeconds: 0,
        queueWaitSeconds: 1.5,
        headerWaitSeconds: 120,
      },
      omitted: undefined,
      disabled: null,
    },
  });

  assert.deepEqual(valid.providerConcurrency, {
    openai: {
      maxConcurrentRequests: 2,
      afterburnSeconds: 0,
      queueWaitSeconds: 1.5,
      headerWaitSeconds: 120,
    },
  });

  const invalidCases: Array<{ params: unknown; message: RegExp }> = [
    { params: { providerConcurrency: [] }, message: /providerConcurrency must be an object/ },
    { params: { providerConcurrency: { openai: [] } }, message: /providerConcurrency\.openai must be an object/ },
    { params: { providerConcurrency: { openai: { maxConcurrentRequests: 0 } } }, message: /maxConcurrentRequests must be a positive integer/ },
    { params: { providerConcurrency: { openai: { maxConcurrentRequests: -1 } } }, message: /maxConcurrentRequests must be a positive integer/ },
    { params: { providerConcurrency: { openai: { maxConcurrentRequests: 1.5 } } }, message: /maxConcurrentRequests must be a positive integer/ },
    { params: { providerConcurrency: { openai: { maxConcurrentRequests: '3' } } }, message: /maxConcurrentRequests must be a positive integer/ },
    { params: { providerConcurrency: { openai: { afterburnSeconds: -1 } } }, message: /afterburnSeconds must be a non-negative number/ },
    { params: { providerConcurrency: { openai: { queueWaitSeconds: -1 } } }, message: /queueWaitSeconds must be a non-negative number/ },
    { params: { providerConcurrency: { openai: { headerWaitSeconds: -1 } } }, message: /headerWaitSeconds must be a non-negative number/ },
  ];

  for (const { params, message } of invalidCases) {
    assert.throws(() => validateRuntimePrefsSet(params), message);
  }
});

test('runtimePrefs.set applies providerConcurrency overrides to the live ProviderGate', async (t) => {
  ProviderGate.uninstall();
  t.after(() => ProviderGate.uninstall());
  const gate = ProviderGate.install([{
    provider: 'openai',
    baseUrl: 'https://api.openai.test/v1',
    maxConcurrentRequests: 1,
    afterburnSeconds: 0,
    queueWaitSeconds: 30,
    headerWaitSeconds: 120,
  }]);

  const result = await handleBackendRequest({} as any, {
    id: 'test-runtime-prefs-provider-concurrency',
    method: 'runtimePrefs.set',
    params: {
      providerToggles: {},
      extensionToggles: {},
      providerConcurrency: {
        openai: { maxConcurrentRequests: 3, afterburnSeconds: 7, queueWaitSeconds: 9, headerWaitSeconds: 11 },
      },
    },
  }) as { providerConcurrency?: unknown };

  assert.deepEqual(result.providerConcurrency, {
    openai: { maxConcurrentRequests: 3, afterburnSeconds: 7, queueWaitSeconds: 9, headerWaitSeconds: 11 },
  });
  assert.deepEqual(gate.getMetrics(), [{
    provider: 'openai',
    activeRequests: 0,
    queuedRequests: 0,
    maxConcurrentRequests: 3,
    afterburnSeconds: 7,
    paused: false,
    pausedUntilMs: 0,
    strikeCount: 0,
  }]);
});

test('runtimePrefs.set mirrors subagentBuckets into the backend environment', async (t) => {
  const previousBuckets = process.env[SUBAGENT_BUCKETS_ENV];
  t.after(() => {
    if (previousBuckets === undefined) {
      delete process.env[SUBAGENT_BUCKETS_ENV];
    } else {
      process.env[SUBAGENT_BUCKETS_ENV] = previousBuckets;
    }
  });

  delete process.env[SUBAGENT_BUCKETS_ENV];
  const buckets = {
    small: [{ model: 'anthropic/haiku', thinkingLevel: 'off' as const }],
    medium: [{ model: 'anthropic/sonnet', thinkingLevel: 'medium' as const }],
    frontier: [{ model: 'anthropic/opus', thinkingLevel: 'high' as const }],
  };
  const result = (await handleBackendRequest({} as any, {
    id: 'test-runtime-prefs-buckets',
    method: 'runtimePrefs.set',
    params: { providerToggles: {}, extensionToggles: {}, subagentBuckets: buckets },
  })) as { subagentBuckets?: typeof buckets };

  assert.deepEqual(result.subagentBuckets, buckets);
  assert.equal(process.env[SUBAGENT_BUCKETS_ENV], JSON.stringify(buckets));
});

test('runtimePrefs.set leaves the buckets env var untouched when omitted', async (t) => {
  const previousBuckets = process.env[SUBAGENT_BUCKETS_ENV];
  t.after(() => {
    if (previousBuckets === undefined) {
      delete process.env[SUBAGENT_BUCKETS_ENV];
    } else {
      process.env[SUBAGENT_BUCKETS_ENV] = previousBuckets;
    }
  });

  process.env[SUBAGENT_BUCKETS_ENV] = 'pre-existing';
  await handleBackendRequest({} as any, {
    id: 'test-runtime-prefs-buckets-omitted',
    method: 'runtimePrefs.set',
    params: { providerToggles: {}, extensionToggles: {} },
  });

  assert.equal(process.env[SUBAGENT_BUCKETS_ENV], 'pre-existing');
});

test('runtimePrefs.set mirrors subagentNestedAllowedBuckets into the backend environment', async (t) => {
  const previous = process.env[NESTED_ALLOWED_BUCKETS_ENV];
  t.after(() => {
    if (previous === undefined) {
      delete process.env[NESTED_ALLOWED_BUCKETS_ENV];
    } else {
      process.env[NESTED_ALLOWED_BUCKETS_ENV] = previous;
    }
  });

  delete process.env[NESTED_ALLOWED_BUCKETS_ENV];
  const allowlist = { small: true, medium: true, frontier: false };
  const result = (await handleBackendRequest({} as any, {
    id: 'test-runtime-prefs-nested',
    method: 'runtimePrefs.set',
    params: { providerToggles: {}, extensionToggles: {}, subagentNestedAllowedBuckets: allowlist },
  })) as { subagentNestedAllowedBuckets?: typeof allowlist };

  assert.deepEqual(result.subagentNestedAllowedBuckets, allowlist);
  assert.equal(process.env[NESTED_ALLOWED_BUCKETS_ENV], JSON.stringify(allowlist));
});

test('runtimePrefs.set leaves the nested-allowlist env var untouched when omitted', async (t) => {
  const previous = process.env[NESTED_ALLOWED_BUCKETS_ENV];
  t.after(() => {
    if (previous === undefined) {
      delete process.env[NESTED_ALLOWED_BUCKETS_ENV];
    } else {
      process.env[NESTED_ALLOWED_BUCKETS_ENV] = previous;
    }
  });

  process.env[NESTED_ALLOWED_BUCKETS_ENV] = 'pre-existing';
  await handleBackendRequest({} as any, {
    id: 'test-runtime-prefs-nested-omitted',
    method: 'runtimePrefs.set',
    params: { providerToggles: {}, extensionToggles: {} },
  });

  assert.equal(process.env[NESTED_ALLOWED_BUCKETS_ENV], 'pre-existing');
});

test('runtimePrefs.set writes the warm-bash env vars when provided', async (t) => {
  const prevPool = process.env['PIE_BASH_WARM_POOL'];
  const prevFast = process.env['PIE_BASH_FAST_PATH'];
  const prevShell = process.env['PIE_SHELL'];
  const prevWarmup = process.env['PIE_BASH_WARMUP_TIMEOUT_MS'];
  const prevDefaultTimeout = process.env['PIE_BASH_DEFAULT_TIMEOUT'];
  t.after(() => {
    for (const [k, v] of [['PIE_BASH_WARM_POOL', prevPool], ['PIE_BASH_FAST_PATH', prevFast], ['PIE_SHELL', prevShell], ['PIE_BASH_WARMUP_TIMEOUT_MS', prevWarmup], ['PIE_BASH_DEFAULT_TIMEOUT', prevDefaultTimeout]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const result = await handleBackendRequest({} as any, {
    id: 'test-runtime-prefs-bash',
    method: 'runtimePrefs.set',
    params: { providerToggles: {}, extensionToggles: {}, bashWarmPoolSize: 4, bashFastPath: false, bashShellPath: '/bin/bash', bashWarmupTimeoutMs: 8000, bashDefaultTimeout: 120 },
  }) as { bashWarmPoolSize?: number; bashFastPath?: boolean; bashShellPath?: string; bashWarmupTimeoutMs?: number; bashDefaultTimeout?: number };

  assert.equal(result.bashWarmPoolSize, 4);
  assert.equal(result.bashFastPath, false);
  assert.equal(result.bashShellPath, '/bin/bash');
  assert.equal(result.bashWarmupTimeoutMs, 8000);
  assert.equal(result.bashDefaultTimeout, 120);
  assert.equal(process.env['PIE_BASH_WARM_POOL'], '4');
  assert.equal(process.env['PIE_BASH_FAST_PATH'], '0');
  assert.equal(process.env['PIE_SHELL'], '/bin/bash');
  assert.equal(process.env['PIE_BASH_WARMUP_TIMEOUT_MS'], '8000');
  assert.equal(process.env['PIE_BASH_DEFAULT_TIMEOUT'], '120');
});

test('runtimePrefs.set leaves the warm-bash env vars untouched when omitted', async () => {
  process.env['PIE_BASH_WARM_POOL'] = 'pre-existing';
  process.env['PIE_BASH_FAST_PATH'] = 'pre-existing';
  process.env['PIE_SHELL'] = 'pre-existing';
  process.env['PIE_BASH_WARMUP_TIMEOUT_MS'] = 'pre-existing';
  process.env['PIE_BASH_DEFAULT_TIMEOUT'] = 'pre-existing';
  await handleBackendRequest({} as any, {
    id: 'test-runtime-prefs-bash-omitted',
    method: 'runtimePrefs.set',
    params: { providerToggles: {}, extensionToggles: {} },
  });

  assert.equal(process.env['PIE_BASH_WARM_POOL'], 'pre-existing');
  assert.equal(process.env['PIE_BASH_FAST_PATH'], 'pre-existing');
  assert.equal(process.env['PIE_SHELL'], 'pre-existing');
  assert.equal(process.env['PIE_BASH_WARMUP_TIMEOUT_MS'], 'pre-existing');
  assert.equal(process.env['PIE_BASH_DEFAULT_TIMEOUT'], 'pre-existing');
});

test('runtimePrefs.set mirrors subagentDropTools into the backend environment', async (t) => {
  const DROP_ENV = 'PIE_SUBAGENT_DROP_TOOLS_JSON';
  const previous = process.env[DROP_ENV];
  t.after(() => {
    if (previous === undefined) delete process.env[DROP_ENV];
    else process.env[DROP_ENV] = previous;
  });

  const dropTools = ['ask_user', 'web_search'];
  const result = await handleBackendRequest({} as any, {
    id: 'test-runtime-prefs-drop-tools',
    method: 'runtimePrefs.set',
    params: { providerToggles: {}, extensionToggles: {}, subagentDropTools: dropTools },
  }) as { subagentDropTools?: string[] };

  assert.deepEqual(result.subagentDropTools, dropTools);
  assert.equal(process.env[DROP_ENV], JSON.stringify(dropTools));
});

test('runtimePrefs.set leaves the drop-tools env var untouched when omitted', async (t) => {
  const DROP_ENV = 'PIE_SUBAGENT_DROP_TOOLS_JSON';
  const previous = process.env[DROP_ENV];
  t.after(() => {
    if (previous === undefined) delete process.env[DROP_ENV];
    else process.env[DROP_ENV] = previous;
  });
  process.env[DROP_ENV] = 'pre-existing';
  await handleBackendRequest({} as any, {
    id: 'test-runtime-prefs-drop-tools-omitted',
    method: 'runtimePrefs.set',
    params: { providerToggles: {}, extensionToggles: {} },
  });
  assert.equal(process.env[DROP_ENV], 'pre-existing');
});
