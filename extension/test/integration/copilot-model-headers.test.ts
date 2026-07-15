import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const REQUIRED_COPILOT_HEADERS = [
  'User-Agent',
  'Editor-Version',
  'Editor-Plugin-Version',
  'Copilot-Integration-Id',
] as const;

test('custom Copilot provider keeps required IDE auth headers at provider boundary', async () => {
  const raw = await readFile(new URL('../../../models.json', import.meta.url), 'utf8');
  const parsed = JSON.parse(raw) as {
    providers?: Record<string, {
      api?: string;
      compat?: unknown;
      headers?: Record<string, string>;
      modelOverrides?: Record<string, unknown>;
      models?: Array<{ id?: string }>;
    }>;
  };

  const provider = parsed.providers?.['github-copilot'];
  assert.ok(provider, 'github-copilot provider must be configured');

  assert.equal(provider.api, undefined, 'github-copilot must preserve per-model generated API routing');
  assert.equal(provider.compat, undefined, 'github-copilot must preserve per-model generated compat settings');
  assert.ok(provider.models?.some((model) => model.id === 'gpt-5.6-sol'), 'account-visible Copilot models must be full catalog entries');

  const headers = provider.headers;
  assert.ok(headers, 'github-copilot provider must define provider-level headers');

  for (const header of REQUIRED_COPILOT_HEADERS) {
    assert.equal(typeof headers[header], 'string', `${header} must be configured`);
    assert.notEqual(headers[header].trim(), '', `${header} must not be empty`);
  }

  assert.ok(headers['Editor-Version'].startsWith('vscode/'));

  for (const model of provider.models ?? []) {
    assert.ok(model && typeof model === 'object', 'custom Copilot models must be objects');
  }
});
