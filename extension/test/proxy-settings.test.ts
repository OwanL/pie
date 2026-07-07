/**
 * Behavior test for the proxy settings resolution + persistence layer that
 * feeds the proxy settings UI shown to users:
 *
 *   - extension/src/host/session-service/proxy-settings.ts
 *     (readProxySettings / writeProxySettings / proxySettingsFileExists)
 *   - extension/src/host/session-service/proxy-settings-persistence.ts
 *     (loadPersistedProxySettings / saveProxySettings)
 *
 * These read/write the on-disk `settings.json` `proxy` block (resolved from
 * `PI_CODING_AGENT_DIR`). The values returned here are exactly what the proxy
 * settings UI renders, so the tests assert exact field values, defaults,
 * invalid-JSON handling, provider coercion, and write round-trips against a
 * temp settings.json — no network, no real subprocess.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_PROXY_SETTINGS,
  mergeProxySettings,
  type ProxyProviderUpstream,
  type ProxySettings,
  type ProxySettingsUpdate,
} from '../src/shared/protocol';
import {
  readProxySettings,
  writeProxySettings,
  proxySettingsFileExists,
} from '../src/host/session-service/proxy-settings';
import {
  loadPersistedProxySettings,
  saveProxySettings,
  type ProxySettingsStorage,
} from '../src/host/session-service/proxy-settings-persistence';

const AGENT_DIR_ENV = 'PI_CODING_AGENT_DIR';
let originalAgentDir: string | undefined;
let tmpRoot: string;

test.before(async () => {
  originalAgentDir = process.env[AGENT_DIR_ENV];
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-proxy-settings-test-'));
  process.env[AGENT_DIR_ENV] = tmpRoot;
});

test.after(async () => {
  if (originalAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
  else process.env[AGENT_DIR_ENV] = originalAgentDir;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

test.beforeEach(async () => {
  // Start each test from a clean (no settings.json) directory.
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.mkdir(tmpRoot, { recursive: true });
});

function settingsPath(): string {
  return path.join(tmpRoot, 'settings.json');
}

async function writeSettingsJson(content: unknown): Promise<void> {
  await fs.writeFile(settingsPath(), typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
}

function cloneDefaults(): ProxySettings {
  return mergeProxySettings(DEFAULT_PROXY_SETTINGS, {});
}

// ─── proxySettingsFileExists ──────────────────────────────────────────────────

test('proxySettingsFileExists returns false when PI_CODING_AGENT_DIR is unset', async () => {
  const saved = process.env[AGENT_DIR_ENV];
  delete process.env[AGENT_DIR_ENV];
  try {
    assert.equal(proxySettingsFileExists(), false);
  } finally {
    process.env[AGENT_DIR_ENV] = saved;
  }
});

test('proxySettingsFileExists returns false when the settings.json file is absent', () => {
  assert.equal(proxySettingsFileExists(), false);
});

test('proxySettingsFileExists returns true once settings.json exists', async () => {
  await writeSettingsJson({});
  assert.equal(proxySettingsFileExists(), true);
});

// ─── readProxySettings: defaults ──────────────────────────────────────────────

test('readProxySettings returns defaults when PI_CODING_AGENT_DIR is unset', async () => {
  const saved = process.env[AGENT_DIR_ENV];
  delete process.env[AGENT_DIR_ENV];
  try {
    const settings = await readProxySettings();
    assert.deepEqual(settings, cloneDefaults());
  } finally {
    process.env[AGENT_DIR_ENV] = saved;
  }
});

test('readProxySettings returns defaults when settings.json is missing', async () => {
  const settings = await readProxySettings();
  assert.deepEqual(settings, cloneDefaults());
});

test('readProxySettings returns defaults when the proxy key is absent (other keys preserved on disk)', async () => {
  await writeSettingsJson({ pruning: { mode: 'auto' }, otherKey: 42 });
  const settings = await readProxySettings();
  assert.deepEqual(settings, cloneDefaults());
});

test('readProxySettings returns defaults when settings.json is invalid JSON', async () => {
  await writeSettingsJson('{ not valid json ');
  const settings = await readProxySettings();
  assert.deepEqual(settings, cloneDefaults());
});

test('readProxySettings returns defaults when proxy is not a plain object', async () => {
  await writeSettingsJson({ proxy: 'not-an-object' });
  const settings = await readProxySettings();
  assert.deepEqual(settings, cloneDefaults());
});

// ─── readProxySettings: full block + exact user-facing values ──────────────────

const FULL_GATEWAY = {
  routerSettings: {
    numRetries: 5,
    retryAfter: false,
    timeout: 900,
    retryPolicy: { RateLimitErrorRetries: 0, APIConnectionErrorRetries: 3 },
  },
  litellmSettings: { dropParams: false },
  generalSettings: { masterKeyEnv: 'MY_CUSTOM_MASTER_KEY' },
};

const FULL_PROVIDER: ProxyProviderUpstream = {
  apiBase: 'https://api.example.com/v1',
  apiKeyEnv: 'EXAMPLE_API_KEY',
  litellmProvider: 'openai',
  maxConcurrentRequests: 8,
  litellmModelInfoId: 'example-shared',
  modelListOrder: ['model-a', 'model-b'],
  alias: { 'model-a': 'example/model-a' },
};

test('readProxySettings surfaces the exact on-disk proxy block to the UI', async () => {
  await writeSettingsJson({
    otherKey: 'preserved',
    proxy: {
      gateway: FULL_GATEWAY,
      providers: { example: FULL_PROVIDER },
    },
  });

  const settings = await readProxySettings();
  assert.deepEqual(settings, {
    gateway: FULL_GATEWAY,
    providers: { example: FULL_PROVIDER },
  });
});

// ─── readProxySettings: gateway sub-object defaults ───────────────────────────

test('readProxySettings falls back to default gateway when gateway is absent', async () => {
  await writeSettingsJson({ proxy: { providers: {} } });
  const settings = await readProxySettings();
  assert.deepEqual(settings.gateway, DEFAULT_PROXY_SETTINGS.gateway);
  assert.deepEqual(settings.providers, {});
});

test('readProxySettings fills missing gateway sub-objects with defaults', async () => {
  await writeSettingsJson({
    proxy: { gateway: { routerSettings: { numRetries: 7, retryAfter: true, timeout: 300 } } },
  });
  const settings = await readProxySettings();
  assert.deepEqual(settings.gateway.routerSettings, { numRetries: 7, retryAfter: true, timeout: 300, retryPolicy: DEFAULT_PROXY_SETTINGS.gateway.routerSettings.retryPolicy });
  assert.deepEqual(settings.gateway.litellmSettings, DEFAULT_PROXY_SETTINGS.gateway.litellmSettings);
  assert.deepEqual(settings.gateway.generalSettings, DEFAULT_PROXY_SETTINGS.gateway.generalSettings);
});

test('readProxySettings fills missing routerSettings fields with defaults', async () => {
  await writeSettingsJson({
    proxy: {
      gateway: {
        routerSettings: { retryAfter: false }, // numRetries + timeout missing
        litellmSettings: { dropParams: true },
        generalSettings: { masterKeyEnv: 'MK' },
      },
    },
  });
  const settings = await readProxySettings();
  assert.equal(settings.gateway.routerSettings.numRetries, DEFAULT_PROXY_SETTINGS.gateway.routerSettings.numRetries);
  assert.equal(settings.gateway.routerSettings.timeout, DEFAULT_PROXY_SETTINGS.gateway.routerSettings.timeout);
  assert.equal(settings.gateway.routerSettings.retryAfter, false);
  assert.deepEqual(settings.gateway.routerSettings.retryPolicy, DEFAULT_PROXY_SETTINGS.gateway.routerSettings.retryPolicy);
});

test('readProxySettings drops an invalid retryPolicy to the default', async () => {
  await writeSettingsJson({
    proxy: {
      gateway: {
        routerSettings: {
          numRetries: 3, retryAfter: true, timeout: 100,
          // Mixed invalid entries: non-number, negative, non-integer -> whole
          // retryPolicy is rejected and replaced with the default.
          retryPolicy: { Good: 2, BadString: 'x', Negative: -1, Float: 1.5 },
        },
        litellmSettings: { dropParams: true },
        generalSettings: { masterKeyEnv: 'MK' },
      },
    },
  });
  const settings = await readProxySettings();
  assert.deepEqual(settings.gateway.routerSettings.retryPolicy, DEFAULT_PROXY_SETTINGS.gateway.routerSettings.retryPolicy);
});

test('readProxySettings accepts a valid retryPolicy verbatim (PascalCase keys preserved)', async () => {
  await writeSettingsJson({
    proxy: {
      gateway: {
        routerSettings: { numRetries: 1, retryAfter: true, timeout: 100, retryPolicy: { RateLimitErrorRetries: 0, TimeoutErrorRetries: 4 } },
        litellmSettings: { dropParams: true },
        generalSettings: { masterKeyEnv: 'MK' },
      },
    },
  });
  const settings = await readProxySettings();
  assert.deepEqual(settings.gateway.routerSettings.retryPolicy, { RateLimitErrorRetries: 0, TimeoutErrorRetries: 4 });
});

test('readProxySettings falls back to default masterKeyEnv when empty', async () => {
  await writeSettingsJson({
    proxy: {
      gateway: {
        routerSettings: { numRetries: 1, retryAfter: true, timeout: 100 },
        litellmSettings: { dropParams: true },
        generalSettings: { masterKeyEnv: '' },
      },
    },
  });
  const settings = await readProxySettings();
  assert.equal(settings.gateway.generalSettings.masterKeyEnv, DEFAULT_PROXY_SETTINGS.gateway.generalSettings.masterKeyEnv);
});

test('readProxySettings fills missing litellmSettings.dropParams with the default', async () => {
  await writeSettingsJson({
    proxy: {
      gateway: {
        routerSettings: { numRetries: 1, retryAfter: true, timeout: 100 },
        litellmSettings: {},
        generalSettings: { masterKeyEnv: 'MK' },
      },
    },
  });
  const settings = await readProxySettings();
  assert.equal(settings.gateway.litellmSettings.dropParams, DEFAULT_PROXY_SETTINGS.gateway.litellmSettings.dropParams);
});

// ─── readProxySettings: provider coercion ─────────────────────────────────────

test('readProxySettings skips non-object provider entries', async () => {
  await writeSettingsJson({
    proxy: { gateway: FULL_GATEWAY, providers: { bad: 'not-an-object', also: 42, ok: FULL_PROVIDER } },
  });
  const settings = await readProxySettings();
  assert.deepEqual(Object.keys(settings.providers), ['ok']);
  assert.deepEqual(settings.providers.ok, FULL_PROVIDER);
});

test('readProxySettings coerces missing provider fields to safe defaults', async () => {
  await writeSettingsJson({
    proxy: { gateway: FULL_GATEWAY, providers: { bare: {} } },
  });
  const settings = await readProxySettings();
  assert.deepEqual(settings.providers.bare, {
    apiBase: '',
    apiKeyEnv: '',
    litellmProvider: '',
    maxConcurrentRequests: 1,
    litellmModelInfoId: '',
    modelListOrder: [],
    alias: {},
  });
});

test('readProxySettings clamps maxConcurrentRequests < 1 to 1', async () => {
  await writeSettingsJson({
    proxy: {
      gateway: FULL_GATEWAY,
      providers: { low: { ...FULL_PROVIDER, maxConcurrentRequests: 0 } },
    },
  });
  const settings = await readProxySettings();
  assert.equal(settings.providers.low.maxConcurrentRequests, 1);
});

test('readProxySettings coerces a non-number maxConcurrentRequests to 1', async () => {
  await writeSettingsJson({
    proxy: {
      gateway: FULL_GATEWAY,
      providers: { weird: { ...FULL_PROVIDER, maxConcurrentRequests: 'many' as unknown as number } },
    },
  });
  const settings = await readProxySettings();
  assert.equal(settings.providers.weird.maxConcurrentRequests, 1);
});

test('readProxySettings drops the whole modelListOrder when any entry is non-string', async () => {
  // asStringArray is all-or-nothing: a single non-string entry rejects the
  // entire array (returns undefined), which then falls back to []. This pins
  // the actual coercion contract the UI relies on.
  await writeSettingsJson({
    proxy: {
      gateway: FULL_GATEWAY,
      providers: { mix: { ...FULL_PROVIDER, modelListOrder: ['a', 1, 'b'] as unknown as string[] } },
    },
  });
  const settings = await readProxySettings();
  assert.deepEqual(settings.providers.mix.modelListOrder, []);
});

test('readProxySettings keeps an all-string modelListOrder verbatim', async () => {
  await writeSettingsJson({
    proxy: { gateway: FULL_GATEWAY, providers: { ok: { ...FULL_PROVIDER, modelListOrder: ['a', 'b', 'c'] } } },
  });
  const settings = await readProxySettings();
  assert.deepEqual(settings.providers.ok.modelListOrder, ['a', 'b', 'c']);
});

test('readProxySettings drops an alias with non-string values to {}', async () => {
  await writeSettingsJson({
    proxy: {
      gateway: FULL_GATEWAY,
      providers: { alias: { ...FULL_PROVIDER, alias: { keep: 'v', drop: 7, also: null } as unknown as Record<string, string> } },
    },
  });
  const settings = await readProxySettings();
  assert.deepEqual(settings.providers.alias.alias, {});
});

test('readProxySettings keeps a fully valid alias verbatim', async () => {
  await writeSettingsJson({
    proxy: {
      gateway: FULL_GATEWAY,
      providers: { ok: { ...FULL_PROVIDER, alias: { 'model-a': 'example/model-a', 'model-b': 'example/model-b' } } },
    },
  });
  const settings = await readProxySettings();
  assert.deepEqual(settings.providers.ok.alias, { 'model-a': 'example/model-a', 'model-b': 'example/model-b' });
});

test('readProxySettings returns an empty providers map when providers is absent', async () => {
  await writeSettingsJson({ proxy: { gateway: FULL_GATEWAY } });
  const settings = await readProxySettings();
  assert.deepEqual(settings.providers, {});
});

// ─── writeProxySettings ───────────────────────────────────────────────────────

test('writeProxySettings round-trips a full proxy block exactly', async () => {
  const result = await writeProxySettings({
    gateway: FULL_GATEWAY,
    providers: { example: FULL_PROVIDER },
  });
  assert.deepEqual(result, { gateway: FULL_GATEWAY, providers: { example: FULL_PROVIDER } });

  // The on-disk file must contain exactly the proxy block and proxySettingsFileExists is true.
  assert.equal(proxySettingsFileExists(), true);
  const onDisk = JSON.parse(await fs.readFile(settingsPath(), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(onDisk.proxy, { gateway: FULL_GATEWAY, providers: { example: FULL_PROVIDER } });

  // A fresh read returns the same values the UI would show.
  const reread = await readProxySettings();
  assert.deepEqual(reread, { gateway: FULL_GATEWAY, providers: { example: FULL_PROVIDER } });
});

test('writeProxySettings preserves unrelated settings.json keys', async () => {
  await writeSettingsJson({ otherKey: 42, pruning: { mode: 'auto' }, proxy: { gateway: FULL_GATEWAY, providers: {} } });

  await writeProxySettings({ gateway: { litellmSettings: { dropParams: false } } });

  const onDisk = JSON.parse(await fs.readFile(settingsPath(), 'utf8')) as Record<string, unknown>;
  assert.equal(onDisk.otherKey, 42, 'unrelated top-level key must survive the write');
  assert.deepEqual(onDisk.pruning, { mode: 'auto' }, 'unrelated pruning key must survive the write');
  assert.ok(onDisk.proxy, 'proxy key must be present');
});

test('writeProxySettings deep-merges a partial gateway update into the existing block', async () => {
  // Seed the disk with a full block.
  await writeSettingsJson({ proxy: { gateway: FULL_GATEWAY, providers: { example: FULL_PROVIDER } } });

  // Patch only routerSettings.numRetries; litellmSettings/generalSettings must persist.
  const result = await writeProxySettings({
    gateway: { routerSettings: { numRetries: 99, retryAfter: false, timeout: 1, retryPolicy: { RateLimitErrorRetries: 0 } } },
  });
  assert.equal(result.gateway.routerSettings.numRetries, 99);
  assert.deepEqual(result.gateway.litellmSettings, FULL_GATEWAY.litellmSettings);
  assert.deepEqual(result.gateway.generalSettings, FULL_GATEWAY.generalSettings);
  assert.deepEqual(result.providers, { example: FULL_PROVIDER }, 'providers must be preserved untouched');
});

test('writeProxySettings rejects an invalid provider (empty apiBase) with a thrown error', async () => {
  await assert.rejects(
    writeProxySettings({ providers: { bad: { apiBase: '', apiKeyEnv: 'X_API_KEY', litellmProvider: 'openai', litellmModelInfoId: 'bad-shared' } } }),
    /Invalid proxy settings: provider "bad"/,
  );
  // A failed write must NOT create/destroy the settings.json file.
  assert.equal(existsSync(settingsPath()), false);
});

test('writeProxySettings rejects an invalid gateway (empty masterKeyEnv) with a thrown error', async () => {
  await assert.rejects(
    writeProxySettings({ gateway: { generalSettings: { masterKeyEnv: '' } } }),
    /Invalid proxy settings: gateway fields missing or wrong type/,
  );
});

test('writeProxySettings throws when PI_CODING_AGENT_DIR is unset', async () => {
  const saved = process.env[AGENT_DIR_ENV];
  delete process.env[AGENT_DIR_ENV];
  try {
    await assert.rejects(
      writeProxySettings({ gateway: { litellmSettings: { dropParams: true } } }),
      /PI_CODING_AGENT_DIR is not set/,
    );
  } finally {
    process.env[AGENT_DIR_ENV] = saved;
  }
});

// ─── loadPersistedProxySettings (persistence layer) ───────────────────────────

class MemoryStorage implements ProxySettingsStorage {
  value: ProxySettings | undefined;
  updates: ProxySettings[] = [];
  get(): ProxySettings | undefined { return this.value; }
  update(value: ProxySettings): void { this.updates.push(value); this.value = value; }
}

test('loadPersistedProxySettings reads the file, dispatches it, and mirrors it to storage', async () => {
  await writeSettingsJson({ proxy: { gateway: FULL_GATEWAY, providers: { example: FULL_PROVIDER } } });

  const storage = new MemoryStorage();
  let dispatched: ProxySettings | undefined;
  await loadPersistedProxySettings(storage, (s) => { dispatched = s; });

  assert.deepEqual(dispatched, { gateway: FULL_GATEWAY, providers: { example: FULL_PROVIDER } });
  assert.equal(storage.updates.length, 1);
  assert.deepEqual(storage.updates[0], { gateway: FULL_GATEWAY, providers: { example: FULL_PROVIDER } });
});

test('loadPersistedProxySettings falls back to stored state when the file is missing', async () => {
  const stored = cloneDefaults();
  const storage = new MemoryStorage();
  storage.value = stored;
  let dispatched: ProxySettings | undefined;
  await loadPersistedProxySettings(storage, (s) => { dispatched = s; });

  assert.deepEqual(dispatched, stored);
  assert.equal(storage.updates.length, 0, 'storage must not be re-written on the fallback path');
});

test('loadPersistedProxySettings falls back to stored state when PI_CODING_AGENT_DIR is unset', async () => {
  const saved = process.env[AGENT_DIR_ENV];
  delete process.env[AGENT_DIR_ENV];
  try {
    const stored = cloneDefaults();
    const storage = new MemoryStorage();
    storage.value = stored;
    let dispatched: ProxySettings | undefined;
    await loadPersistedProxySettings(storage, (s) => { dispatched = s; });
    assert.deepEqual(dispatched, stored);
  } finally {
    process.env[AGENT_DIR_ENV] = saved;
  }
});

test('loadPersistedProxySettings falls back to stored state when settings.json is invalid JSON', async () => {
  await writeSettingsJson('{ broken');
  const stored = cloneDefaults();
  const storage = new MemoryStorage();
  storage.value = stored;
  let dispatched: ProxySettings | undefined;
  await loadPersistedProxySettings(storage, (s) => { dispatched = s; });

  // readProxySettings swallows the parse error and returns defaults, so the
  // file-exists branch dispatches the DEFAULT settings (not the stored ones)
  // and mirrors them to storage. This pins the actual contract: a corrupt
  // settings.json is treated as "present but defaulted", not "missing".
  assert.deepEqual(dispatched, cloneDefaults());
  assert.equal(storage.updates.length, 1);
});

// ─── saveProxySettings (persistence layer) ────────────────────────────────────

test('saveProxySettings writes, dispatches, and mirrors the merged result to storage', async () => {
  const storage = new MemoryStorage();
  let dispatched: ProxySettings | undefined;
  const result = await saveProxySettings(
    storage,
    (s) => { dispatched = s; },
    () => cloneDefaults(),
    { gateway: FULL_GATEWAY, providers: { example: FULL_PROVIDER } },
  );

  assert.deepEqual(result, { gateway: FULL_GATEWAY, providers: { example: FULL_PROVIDER } });
  assert.deepEqual(dispatched, result);
  assert.equal(storage.updates.length, 1);
  assert.deepEqual(storage.updates[0], result);
  // Persisted to disk too.
  assert.deepEqual(await readProxySettings(), result);
});

test('saveProxySettings with undefined dispatch still persists to storage and returns the result', async () => {
  const storage = new MemoryStorage();
  const result = await saveProxySettings(
    storage,
    undefined,
    () => cloneDefaults(),
    { gateway: { litellmSettings: { dropParams: false } } },
  );
  assert.equal(result.gateway.litellmSettings.dropParams, false);
  assert.equal(storage.updates.length, 1);
  assert.deepEqual(storage.updates[0], result);
});

test('saveProxySettings falls back to in-memory merge + onError when the write fails', async () => {
  // Make writeProxySettings throw by unsetting the agent dir.
  const saved = process.env[AGENT_DIR_ENV];
  delete process.env[AGENT_DIR_ENV];
  try {
    const storage = new MemoryStorage();
    let dispatched: ProxySettings | undefined;
    const current = cloneDefaults();
    const updates: ProxySettingsUpdate = { gateway: { litellmSettings: { dropParams: false } } };

    let errMsg: string | undefined;
    const result = await saveProxySettings(
      storage,
      (s) => { dispatched = s; },
      () => current,
      updates,
      (m) => { errMsg = m; },
    );

    const expected = mergeProxySettings(current, updates);
    assert.deepEqual(result, expected, 'fallback must be the in-memory merge of current + updates');
    assert.deepEqual(dispatched, expected);
    assert.equal(storage.updates.length, 1, 'storage is still updated on the fallback path');
    assert.deepEqual(storage.updates[0], expected);
    assert.ok(errMsg && /Failed to update proxy settings/.test(errMsg), 'onError must be called with a failure message');
  } finally {
    process.env[AGENT_DIR_ENV] = saved;
  }
});

test('saveProxySettings surfaces a validation failure via onError and falls back to the merge', async () => {
  const storage = new MemoryStorage();
  let dispatched: ProxySettings | undefined;
  const current: ProxySettings = {
    gateway: FULL_GATEWAY,
    providers: { example: FULL_PROVIDER },
  };
  const updates: ProxySettingsUpdate = { providers: { bad: { apiBase: '' } } };

  let errMsg: string | undefined;
  const result = await saveProxySettings(
    storage,
    (s) => { dispatched = s; },
    () => current,
    updates,
    (m) => { errMsg = m; },
  );

  // writeProxySettings throws on the invalid provider; saveProxySettings
  // catches and returns the shallow merge (which contains the bad entry
  // in-memory) so the optimistic reducer state stays consistent.
  assert.deepEqual(result, mergeProxySettings(current, updates));
  assert.deepEqual(dispatched, result);
  assert.equal(storage.updates.length, 1);
  assert.ok(errMsg && /Failed to update proxy settings/.test(errMsg));
});