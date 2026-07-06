import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildProxyProviderEntry,
  deriveApiKeyEnv,
  DEFAULT_PROXY_PROVIDER_MAX_CONCURRENT,
} from '../src/shared/protocol';
import {
  readProxyEnv,
  loadProxyEnvIntoProcess,
  writeProxyEnvKey,
  resolveProxyEnvPath,
} from '../src/host/session-service/proxy-env';

// ─── deriveApiKeyEnv (pure) ────────────────────────────────────────────────

test('deriveApiKeyEnv uppercases + suffixes _API_KEY', () => {
  assert.equal(deriveApiKeyEnv('openrouter'), 'OPENROUTER_API_KEY');
  assert.equal(deriveApiKeyEnv('my-provider'), 'MY_PROVIDER_API_KEY');
  assert.equal(deriveApiKeyEnv('azure_east_us'), 'AZURE_EAST_US_API_KEY');
});

test('deriveApiKeyEnv is invariant to case/whitespace', () => {
  assert.equal(deriveApiKeyEnv('OpenRouter'), 'OPENROUTER_API_KEY');
  assert.equal(deriveApiKeyEnv('  openrouter  '), 'OPENROUTER_API_KEY');
});

test('deriveApiKeyEnv returns null for empty / no-alphanumeric names', () => {
  assert.equal(deriveApiKeyEnv(''), null);
  assert.equal(deriveApiKeyEnv('---'), null);
  assert.equal(deriveApiKeyEnv('   '), null);
});

// ─── buildProxyProviderEntry (pure, deterministic for reducer == service) ───

test('buildProxyProviderEntry builds a pending entry with empty modelListOrder + <name>-shared id', () => {
  const entry = buildProxyProviderEntry({
    name: 'OpenRouter',
    apiBase: 'https://openrouter.ai/api/v1',
    apiKey: 'sk-secret',
    litellmProvider: 'openai',
  });
  assert.deepEqual(entry, {
    apiBase: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    litellmProvider: 'openai',
    maxConcurrentRequests: DEFAULT_PROXY_PROVIDER_MAX_CONCURRENT,
    litellmModelInfoId: 'openrouter-shared',
    modelListOrder: [],
    alias: {},
  });
});

test('buildProxyProviderEntry honours a custom maxConcurrentRequests (>=1)', () => {
  const entry = buildProxyProviderEntry({
    name: 'groq',
    apiBase: 'https://api.groq.com/openai/v1',
    apiKey: 'sk-x',
    litellmProvider: 'openai',
    maxConcurrentRequests: 8,
  });
  assert.equal(entry?.maxConcurrentRequests, 8);
});

test('buildProxyProviderEntry falls back to the default concurrency for invalid values', () => {
  const entry = buildProxyProviderEntry({
    name: 'groq',
    apiBase: 'https://api.groq.com/openai/v1',
    apiKey: 'sk-x',
    litellmProvider: 'openai',
    maxConcurrentRequests: 0,
  });
  assert.equal(entry?.maxConcurrentRequests, DEFAULT_PROXY_PROVIDER_MAX_CONCURRENT);
});

test('buildProxyProviderEntry returns null for an empty/invalid name', () => {
  assert.equal(
    buildProxyProviderEntry({ name: '', apiBase: 'x', apiKey: 'k', litellmProvider: 'openai' }),
    null,
  );
});

// ─── proxy/.env I/O ─────────────────────────────────────────────────────────

async function withTempAgentDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), 'pie-proxy-env-'));
  const proxyDir = path.join(dir, 'proxy');
  mkdirSync(proxyDir, { recursive: true });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('writeProxyEnvKey creates proxy/.env, stores the key, and sets process.env', async () => {
  await withTempAgentDir(async () => {
    delete process.env.MY_TEST_PROVIDER_API_KEY;
    await writeProxyEnvKey('MY_TEST_PROVIDER_API_KEY', 'sk-abc-123');
    assert.equal(process.env.MY_TEST_PROVIDER_API_KEY, 'sk-abc-123');
    const text = readFileSync(resolveProxyEnvPath()!, 'utf8');
    assert.match(text, /^MY_TEST_PROVIDER_API_KEY=sk-abc-123$/m);
  });
  delete process.env.MY_TEST_PROVIDER_API_KEY;
});

test('writeProxyEnvKey updates an existing key in place and preserves other lines', async () => {
  await withTempAgentDir(async () => {
    writeFileSync(
      path.join(process.env.PI_CODING_AGENT_DIR!, 'proxy', '.env'),
      '# comment\nUMANS_API_KEY=sk-old\nOTHER=keep\n',
      'utf8',
    );
    await writeProxyEnvKey('UMANS_API_KEY', 'sk-new');
    const text = readFileSync(resolveProxyEnvPath()!, 'utf8');
    assert.match(text, /^# comment$/m);
    assert.match(text, /^UMANS_API_KEY=sk-new$/m);
    assert.match(text, /^OTHER=keep$/m);
    assert.doesNotMatch(text, /sk-old/);
    assert.equal(process.env.UMANS_API_KEY, 'sk-new');
  });
  delete process.env.UMANS_API_KEY;
});

test('loadProxyEnvIntoProcess loads .env into process.env WITHOUT overriding already-set vars', async () => {
  await withTempAgentDir(async () => {
    writeFileSync(
      path.join(process.env.PI_CODING_AGENT_DIR!, 'proxy', '.env'),
      'FROM_FILE=from-file-value\nOS_WINS=os-value\n',
      'utf8',
    );
    // Pre-set OS_WINS in process.env — it must NOT be overridden by .env.
    process.env.OS_WINS = 'os-value';
    delete process.env.FROM_FILE;
    const applied = await loadProxyEnvIntoProcess();
    assert.equal(process.env.FROM_FILE, 'from-file-value');
    assert.equal(process.env.OS_WINS, 'os-value');
    // OS_WINS was already set, so it is NOT in the applied map.
    assert.equal(applied.FROM_FILE, 'from-file-value');
    assert.equal(applied.OS_WINS, undefined);
  });
  delete process.env.FROM_FILE;
  delete process.env.OS_WINS;
});

test('readProxyEnv returns {} when PI_CODING_AGENT_DIR is unset', async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  try {
    assert.deepEqual(await readProxyEnv(), {});
  } finally {
    process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test('writeProxyEnvKey rejects a non UPPER_SNAKE_CASE key', async () => {
  await withTempAgentDir(async () => {
    await assert.rejects(() => writeProxyEnvKey('bad-key', 'x'), /Invalid proxy env key/);
  });
});
