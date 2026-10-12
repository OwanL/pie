import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOwnerRequire } from '../../../../scripts/lib/package-resolution.mjs';
import { parseProviderConfig, readProviderConfig, validateProviderConfig } from '../provider-config.js';

const examples = [
  `version: 1
providers:
  anthropic:
    enabled: true
    api: anthropic-messages
    credentialRef: {source: saved}
    modelOverrides:
      claude-example:
        pricing: unknown
    modelPreferences:
      claude-example: {visible: true, subagentEligible: false}
`,
  `version: 1
providers:
  local:
    enabled: true
    baseUrl: http://localhost:1234/v1
    api: openai-completions
    credentialRef: {source: environment, name: LOCAL_API_KEY}
    manualModels: [local-model, incomplete-model]
    modelOverrides:
      local-model:
        name: Local Model
        input: [text, image]
        reasoning: false
        contextWindow: 32768
        maxTokens: 4096
        pricing: {input: 0, output: 0}
    modelPreferences:
      local-model: {visible: true, subagentEligible: true}
`,
];

test('the exact approved YAML examples validate without inserting built-in API defaults', () => {
  const builtIn = parseProviderConfig(`version: 1
providers:
  github-copilot:
    enabled: true
    credentialRef:
      source: saved
    modelPreferences:
      example-model:
        visible: true
        subagentEligible: false
`);
  assert.deepEqual(builtIn, { status: 'valid', config: { version: 1, providers: {
    'github-copilot': { enabled: true, credentialRef: { source: 'saved' }, modelPreferences: {
      'example-model': { visible: true, subagentEligible: false },
    } },
  } } });
  const custom = parseProviderConfig(`version: 1
providers:
  example-service:
    enabled: true
    api: openai-completions
    baseUrl: https://api.example.test/v1
    credentialRef:
      source: environment
      name: EXAMPLE_API_KEY
    manualModels:
      - example-chat
    modelOverrides:
      example-chat:
        name: Example Chat
        input: [text]
        reasoning: false
        contextWindow: 64000
        maxTokens: 8000
        pricing: unknown
    modelPreferences:
      example-chat:
        visible: true
        subagentEligible: false
`);
  assert.deepEqual(custom, { status: 'valid', config: { version: 1, providers: {
    'example-service': {
      enabled: true, api: 'openai-completions', baseUrl: 'https://api.example.test/v1',
      credentialRef: { source: 'environment', name: 'EXAMPLE_API_KEY' },
      manualModels: ['example-chat'], modelOverrides: { 'example-chat': {
        name: 'Example Chat', input: ['text'], reasoning: false,
        contextWindow: 64000, maxTokens: 8000, pricing: 'unknown',
      } }, modelPreferences: { 'example-chat': { visible: true, subagentEligible: false } },
    },
  } } });
});

test('saved and environment reference examples preserve metadata/preferences without completion', () => {
  for (const text of examples) {
    const result = parseProviderConfig(text);
    assert.equal(result.status, 'valid');
    if (result.status !== 'valid') throw new Error('Expected valid config');
    assert.equal(result.config.version, 1);
  }
  const saved = parseProviderConfig(examples[0]);
  const local = parseProviderConfig(examples[1]);
  if (saved.status !== 'valid' || local.status !== 'valid') throw new Error('Expected valid config');
  assert.equal(saved.config.providers.anthropic.modelOverrides?.['claude-example'].pricing, 'unknown');
  assert.deepEqual(local.config.providers.local.modelOverrides?.['local-model'].pricing, { input: 0, output: 0 });
  assert.equal(local.config.providers.local.modelOverrides?.['incomplete-model'], undefined);
  assert.equal(local.config.providers.local.modelOverrides?.['local-model'].reasoning, false);
  assert.equal('visible' in local.config.providers.local.modelOverrides!['local-model'], false);
});

test('validation preserves input identity and existing tier shape without defaults', () => {
  const value = { version: 1, providers: { local: { enabled: false, api: 'openai-completions', manualModels: ['incomplete'], modelOverrides: { incomplete: { pricing: { input: 0, output: 1, tiers: [{ inputTokensAbove: 200000, input: 2, output: 3, cacheRead: 0, cacheWrite: 0 }] } } } } } };
  const before = structuredClone(value);
  const result = validateProviderConfig(value);
  assert.equal(result.status, 'valid');
  if (result.status === 'valid') assert.equal(result.config, value);
  assert.deepEqual(value, before);
  assert.deepEqual(parseProviderConfig('version: 1\nproviders: {}'), { status: 'valid', config: { version: 1, providers: {} } });
});

test('schema diagnostics identify invalid fields and rules without displaying supplied values', () => {
  const result = validateProviderConfig({ version: 1, providers: { service: {
    enabled: 'DO_NOT_LEAK', apiKey: 'DO_NOT_LEAK',
  } } });
  assert.equal(result.status, 'invalid');
  if (result.status !== 'invalid') throw new Error('Expected invalid config');
  assert.ok(result.diagnostic.issues?.some(issue => issue.path === '/providers/service/enabled'));
  assert.ok(result.diagnostic.issues?.some(issue => issue.message === 'Unknown field: apiKey'));
  assert.equal(JSON.stringify(result).includes('DO_NOT_LEAK'), false);
  assert.equal(validateProviderConfig({ version: 1, providers: { CustomProvider: { enabled: false } } }).status, 'valid');
});

test('YAML duplicates and malformed documents differ from schema failures without leaking content', () => {
  for (const text of ['version: 1\nversion: 1\nproviders: {}', 'providers: [', 'version: 1\nproviders:\n  local: {}\n  local: {}']) {
    const result = parseProviderConfig(text);
    assert.equal(result.status, 'invalid');
    if (result.status === 'invalid') assert.equal(result.diagnostic.code, 'yaml-invalid');
  }
  const invalid = [
    { version: 2, providers: {} },
    { version: 1, providers: {}, apiKey: 'DO_NOT_LEAK' },
    ...[
      { apiKey: 'DO_NOT_LEAK' }, { oauth: { token: 'DO_NOT_LEAK' } },
      { manualModels: ['same', 'same'] }, { manualModels: [''] },
      { api: 'unsupported' }, { baseUrl: 'file:///tmp/config' },
      { credentialRef: { source: 'saved', token: 'DO_NOT_LEAK' } },
      { credentialRef: { source: 'none', name: 'SHOULD_NOT_BE_ALLOWED' } },
      { modelOverrides: { m: { visible: false } } },
      { modelPreferences: { m: { pricing: 'unknown' } } },
      { modelOverrides: { m: { pricing: { input: -1, output: 0 } } } },
    ].map(fields => ({ version: 1, providers: { local: { enabled: true, api: 'openai-completions', ...fields } } })),
  ];
  for (const value of invalid) {
    const result = validateProviderConfig(value);
    assert.equal(result.status, 'invalid');
    if (result.status === 'invalid') assert.equal(result.diagnostic.code, 'schema-invalid');
    assert.equal(JSON.stringify(result).includes('DO_NOT_LEAK'), false);
  }
});

test('YAML mapping keys cannot silently collapse distinct preferences during object projection', () => {
  const ambiguous = `version: 1
providers:
  local:
    enabled: true
    modelPreferences:
      123: {visible: false}
      "123": {subagentEligible: true}
`;
  const aliasCollision = `version: 1
providers:
  local:
    enabled: true
    modelPreferences:
      &model example: {visible: false}
      *model : {subagentEligible: true}
`;
  const complexKey = 'version: 1\nproviders:\n  ? [one, two]\n  : {enabled: true}\n';
  for (const text of [ambiguous, aliasCollision, complexKey]) {
    const result = parseProviderConfig(text);
    assert.equal(result.status, 'invalid');
    if (result.status === 'invalid') {
      assert.equal(result.diagnostic.code, 'yaml-invalid');
      assert.equal(result.diagnostic.message, 'Provider configuration YAML requires unique string mapping keys.');
    }
  }
  assert.deepEqual(parseProviderConfig(`version: 1
providers:
  local:
    enabled: true
    modelPreferences:
      "123": {visible: false, subagentEligible: true}
`), { status: 'valid', config: { version: 1, providers: { local: {
    enabled: true, modelPreferences: { '123': { visible: false, subagentEligible: true } },
  } } } });
});

test('YAML-specific Date and Set values cannot masquerade as empty provider records', () => {
  for (const text of [
    '%YAML 1.1\n---\nversion: 1\nproviders: 2026-01-01\n',
    '%YAML 1.1\n---\nversion: 1\nproviders: !!set {}\n',
  ]) {
    const result = parseProviderConfig(text);
    assert.equal(result.status, 'invalid');
    if (result.status === 'invalid') assert.equal(result.diagnostic.message,
      'Provider configuration YAML requires JSON-compatible values.');
  }
});

test('caller-selected file read is non-mutating; missing, invalid and unreadable stay distinct', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pie-provider-config-'));
  try {
    const file = path.join(directory, 'providers.yaml');
    const missing = await readProviderConfig(file);
    assert.deepEqual(missing, { status: 'missing', config: { version: 1, providers: {} }, revision: null });
    assert.deepEqual(await readdir(directory), []);
    for (const text of [...examples, 'providers: [', 'version: 9\nproviders: {}']) {
      await writeFile(file, text);
      const result = await readProviderConfig(file);
      assert.equal(result.status, examples.includes(text) ? 'valid' : 'invalid');
      assert.equal(await readFile(file, 'utf8'), text);
      assert.deepEqual(await readdir(directory), ['providers.yaml']);
    }
    let calls = 0;
    const unreadable = await readProviderConfig(file, { readFile: async selected => {
      calls++;
      assert.equal(selected, file);
      throw Object.assign(new Error('DO_NOT_LEAK'), { code: 'EACCES' });
    } });
    assert.equal(calls, 1);
    assert.equal(unreadable.status, 'unreadable');
    assert.equal(JSON.stringify(unreadable).includes('DO_NOT_LEAK'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runtime acceptance matches the checked-in JSON schema authority', async () => {
  const schema = JSON.parse(await readFile(new URL('../provider-config.schema.json', import.meta.url), 'utf8'));
  const Ajv = createOwnerRequire()('ajv');
  const validate = new Ajv({ strict: true }).compile(schema);
  const candidates = [
    { version: 1, providers: {} }, { version: 2, providers: {} },
    { version: 1, providers: { local: { enabled: true, api: 'openai-completions', manualModels: ['id'] } } },
    { version: 1, providers: { local: { enabled: true, api: 'openai-completions', apiKey: 'not-allowed' } } },
    { version: 1, providers: { local: { enabled: true, credentialRef: { source: 'none' } } } },
  ];
  for (const candidate of candidates) assert.equal(validateProviderConfig(candidate).status === 'valid', validate(candidate));
});
