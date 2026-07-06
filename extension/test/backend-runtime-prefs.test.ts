import test from 'node:test';
import assert from 'node:assert/strict';

import { handleBackendRequest } from '../src/backend/request-handler';
import { EXTENSION_TOGGLES_ENV, NESTED_ALLOWED_BUCKETS_ENV, PROVIDER_TOGGLES_ENV, SUBAGENT_BUCKETS_ENV } from '../src/shared/protocol';
import { validateRuntimePrefsSet } from '../src/backend/rpc';

const SUBAGENT_ALWAYS_PARENT_MODEL_ENV = 'PIE_SUBAGENT_ALWAYS_PARENT_MODEL';
const SUBAGENT_MAX_DEPTH_ENV = 'PIE_SUBAGENT_MAX_DEPTH';
const SUBAGENT_MAX_TREE_SESSIONS_ENV = 'PIE_SUBAGENT_MAX_TREE_SESSIONS';
const SUBAGENT_MAX_INFLIGHT_ENV = 'PIE_SUBAGENT_MAX_INFLIGHT';
const SUBAGENT_MAX_CONCURRENCY_ENV = 'PIE_SUBAGENT_MAX_CONCURRENCY';
const SUBAGENT_MAX_PARALLEL_TASKS_ENV = 'PIE_SUBAGENT_MAX_PARALLEL_TASKS';

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

  assert.deepEqual(result, { providerToggles, extensionToggles, subagentAlwaysParentModel: undefined, subagentMaxDepth: undefined, subagentMaxTreeSessions: undefined, subagentMaxInflight: undefined, subagentMaxConcurrency: undefined, subagentMaxParallelTasks: undefined, bashWarmPoolSize: undefined, bashFastPath: undefined, bashShellPath: undefined, bashWarmupTimeoutMs: undefined, bashAcquireTimeoutMs: undefined, bashDefaultTimeout: undefined, subagentBuckets: undefined, subagentNestedAllowedBuckets: undefined, subagentDropTools: undefined });
  assert.equal(process.env[PROVIDER_TOGGLES_ENV], JSON.stringify(providerToggles));
  assert.equal(process.env[EXTENSION_TOGGLES_ENV], JSON.stringify(extensionToggles));
  // When the field is omitted, the env var must not be touched.
  assert.equal(process.env[SUBAGENT_ALWAYS_PARENT_MODEL_ENV], previousAlwaysParent);
  assert.equal(process.env[SUBAGENT_BUCKETS_ENV], previousBuckets);
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

  assert.deepEqual(result, { providerToggles: {}, extensionToggles: {}, subagentAlwaysParentModel: true, subagentMaxDepth: undefined, subagentMaxTreeSessions: undefined, subagentMaxInflight: undefined, subagentMaxConcurrency: undefined, subagentMaxParallelTasks: undefined, bashWarmPoolSize: undefined, bashFastPath: undefined, bashShellPath: undefined, bashWarmupTimeoutMs: undefined, bashAcquireTimeoutMs: undefined, bashDefaultTimeout: undefined, subagentBuckets: undefined, subagentNestedAllowedBuckets: undefined, subagentDropTools: undefined });
  assert.equal(process.env[SUBAGENT_ALWAYS_PARENT_MODEL_ENV], '1');
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
    params: { providerToggles: {}, extensionToggles: {}, subagentMaxDepth: 6, subagentMaxTreeSessions: 80, subagentMaxInflight: 3, subagentMaxConcurrency: 2, subagentMaxParallelTasks: 5 },
  }) as { subagentMaxDepth?: number; subagentMaxTreeSessions?: number; subagentMaxInflight?: number; subagentMaxConcurrency?: number; subagentMaxParallelTasks?: number };

  assert.equal(result.subagentMaxDepth, 6);
  assert.equal(result.subagentMaxTreeSessions, 80);
  assert.equal(result.subagentMaxInflight, 3);
  assert.equal(result.subagentMaxConcurrency, 2);
  assert.equal(result.subagentMaxParallelTasks, 5);
  assert.equal(process.env[SUBAGENT_MAX_DEPTH_ENV], '6');
  assert.equal(process.env[SUBAGENT_MAX_TREE_SESSIONS_ENV], '80');
  assert.equal(process.env[SUBAGENT_MAX_INFLIGHT_ENV], '3');
  assert.equal(process.env[SUBAGENT_MAX_CONCURRENCY_ENV], '2');
  assert.equal(process.env[SUBAGENT_MAX_PARALLEL_TASKS_ENV], '5');
});

test('runtimePrefs.set leaves nesting env vars untouched when omitted', async (t) => {
  const prevDepth = process.env[SUBAGENT_MAX_DEPTH_ENV];
  const prevTree = process.env[SUBAGENT_MAX_TREE_SESSIONS_ENV];
  const prevInflight = process.env[SUBAGENT_MAX_INFLIGHT_ENV];
  const prevConcurrency = process.env[SUBAGENT_MAX_CONCURRENCY_ENV];
  const prevParallel = process.env[SUBAGENT_MAX_PARALLEL_TASKS_ENV];
  t.after(() => {
    if (prevDepth === undefined) delete process.env[SUBAGENT_MAX_DEPTH_ENV];
    else process.env[SUBAGENT_MAX_DEPTH_ENV] = prevDepth;
    if (prevTree === undefined) delete process.env[SUBAGENT_MAX_TREE_SESSIONS_ENV];
    else process.env[SUBAGENT_MAX_TREE_SESSIONS_ENV] = prevTree;
    if (prevInflight === undefined) delete process.env[SUBAGENT_MAX_INFLIGHT_ENV];
    else process.env[SUBAGENT_MAX_INFLIGHT_ENV] = prevInflight;
    if (prevConcurrency === undefined) delete process.env[SUBAGENT_MAX_CONCURRENCY_ENV];
    else process.env[SUBAGENT_MAX_CONCURRENCY_ENV] = prevConcurrency;
    if (prevParallel === undefined) delete process.env[SUBAGENT_MAX_PARALLEL_TASKS_ENV];
    else process.env[SUBAGENT_MAX_PARALLEL_TASKS_ENV] = prevParallel;
  });

  delete process.env[SUBAGENT_MAX_DEPTH_ENV];
  delete process.env[SUBAGENT_MAX_TREE_SESSIONS_ENV];
  delete process.env[SUBAGENT_MAX_INFLIGHT_ENV];
  delete process.env[SUBAGENT_MAX_CONCURRENCY_ENV];
  delete process.env[SUBAGENT_MAX_PARALLEL_TASKS_ENV];
  await handleBackendRequest({} as any, {
    id: 'test-runtime-prefs-nesting-omitted',
    method: 'runtimePrefs.set',
    params: { providerToggles: {}, extensionToggles: {} },
  });

  assert.equal(process.env[SUBAGENT_MAX_DEPTH_ENV], undefined);
  assert.equal(process.env[SUBAGENT_MAX_TREE_SESSIONS_ENV], undefined);
  assert.equal(process.env[SUBAGENT_MAX_INFLIGHT_ENV], undefined);
  assert.equal(process.env[SUBAGENT_MAX_CONCURRENCY_ENV], undefined);
  assert.equal(process.env[SUBAGENT_MAX_PARALLEL_TASKS_ENV], undefined);
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
  const buckets = { small: ['haiku'], medium: ['sonnet'], frontier: ['opus'] };
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
  const prevAcquire = process.env['PIE_BASH_ACQUIRE_TIMEOUT_MS'];
  const prevDefaultTimeout = process.env['PIE_BASH_DEFAULT_TIMEOUT'];
  t.after(() => {
    for (const [k, v] of [['PIE_BASH_WARM_POOL', prevPool], ['PIE_BASH_FAST_PATH', prevFast], ['PIE_SHELL', prevShell], ['PIE_BASH_WARMUP_TIMEOUT_MS', prevWarmup], ['PIE_BASH_ACQUIRE_TIMEOUT_MS', prevAcquire], ['PIE_BASH_DEFAULT_TIMEOUT', prevDefaultTimeout]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const result = await handleBackendRequest({} as any, {
    id: 'test-runtime-prefs-bash',
    method: 'runtimePrefs.set',
    params: { providerToggles: {}, extensionToggles: {}, bashWarmPoolSize: 4, bashFastPath: false, bashShellPath: '/bin/bash', bashWarmupTimeoutMs: 8000, bashAcquireTimeoutMs: 20000, bashDefaultTimeout: 120 },
  }) as { bashWarmPoolSize?: number; bashFastPath?: boolean; bashShellPath?: string; bashWarmupTimeoutMs?: number; bashAcquireTimeoutMs?: number; bashDefaultTimeout?: number };

  assert.equal(result.bashWarmPoolSize, 4);
  assert.equal(result.bashFastPath, false);
  assert.equal(result.bashShellPath, '/bin/bash');
  assert.equal(result.bashWarmupTimeoutMs, 8000);
  assert.equal(result.bashAcquireTimeoutMs, 20000);
  assert.equal(result.bashDefaultTimeout, 120);
  assert.equal(process.env['PIE_BASH_WARM_POOL'], '4');
  assert.equal(process.env['PIE_BASH_FAST_PATH'], '0');
  assert.equal(process.env['PIE_SHELL'], '/bin/bash');
  assert.equal(process.env['PIE_BASH_WARMUP_TIMEOUT_MS'], '8000');
  assert.equal(process.env['PIE_BASH_ACQUIRE_TIMEOUT_MS'], '20000');
  assert.equal(process.env['PIE_BASH_DEFAULT_TIMEOUT'], '120');
});

test('runtimePrefs.set leaves the warm-bash env vars untouched when omitted', async () => {
  process.env['PIE_BASH_WARM_POOL'] = 'pre-existing';
  process.env['PIE_BASH_FAST_PATH'] = 'pre-existing';
  process.env['PIE_SHELL'] = 'pre-existing';
  process.env['PIE_BASH_WARMUP_TIMEOUT_MS'] = 'pre-existing';
  process.env['PIE_BASH_ACQUIRE_TIMEOUT_MS'] = 'pre-existing';
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
  assert.equal(process.env['PIE_BASH_ACQUIRE_TIMEOUT_MS'], 'pre-existing');
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
