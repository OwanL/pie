import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProviderConfig, parseProviderConfig } from '../../../../harness/model-providers/catalog/provider-config';
import { editProviderConfig } from '../../../../harness/model-providers/catalog/provider-config-writer';
import { resolveProviderModelList } from '../../../../harness/model-providers/catalog/provider-model-resolution';
import { createProviderSetupDraft, prepareProviderSetupSave, projectProviderSetupPreview } from '../../settings/provider-setup-preview';

const fixture = `# preserve document comment
version: 1
providers:
  __proto__:
    enabled: true # preserve flag comment
    credentialRef: {source: saved}
    manualModels: [constructor]
    modelOverrides:
      constructor: {pricing: unknown}
    modelPreferences:
      ghost: {visible: false}
      constructor: {subagentEligible: true}
  constructor:
    enabled: false
`;

test('synthetic read/draft/write/reread preserves untouched properties, comments and no-op bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pie-provider-preview-'));
  const path = join(dir, 'fixture.yaml');
  try {
    await writeFile(path, fixture);
    const read = await readProviderConfig(path);
    assert.equal(read.status, 'valid');
    if (read.status !== 'valid') return;
    const list = resolveProviderModelList({ config: read.config });
    const draft = createProviderSetupDraft(read.config, list, '__proto__');
    assert.equal(draft.originalId, '__proto__');
    assert.equal(draft.credentialSource, 'saved');
    assert.equal(draft.environmentName, '');
    assert.deepEqual(draft.models.find(m => m.id === 'constructor')?.pricing, { kind: 'unknown', tiered: false });
    assert.equal(draft.models.find(m => m.id === 'ghost')?.subagentEligible, 'unset');
    const noop = prepareProviderSetupSave(read.config, draft);
    assert.equal(noop.status, 'valid');
    if (noop.status !== 'valid') return;
    assert.deepEqual(noop.edits, []);
    assert.equal((await editProviderConfig(path, read.revision, noop.edits)).status, 'unchanged');
    assert.equal(await readFile(path, 'utf8'), fixture);
    draft.baseUrl = 'https://example.test/v1';
    draft.models.find(m => m.id === 'constructor')!.subagentEligible = 'unset';
    const prepared = prepareProviderSetupSave(read.config, draft);
    assert.equal(prepared.status, 'valid');
    if (prepared.status !== 'valid') return;
    assert.deepEqual(prepared.edits.map(e => e.path), [
      ['providers', '__proto__', 'baseUrl'], ['providers', '__proto__', 'modelPreferences', 'constructor', 'subagentEligible'],
    ]);
    assert.equal((await editProviderConfig(path, read.revision, prepared.edits)).status, 'saved');
    const bytes = await readFile(path, 'utf8');
    assert.match(bytes, /preserve document comment/);
    assert.match(bytes, /preserve flag comment/);
    const reread = await readProviderConfig(path);
    assert.equal(reread.status, 'valid');
    if (reread.status !== 'valid') return;
    const entry = reread.config.providers.__proto__;
    assert.deepEqual(entry.manualModels, ['constructor']);
    assert.equal(entry.modelOverrides?.[String('constructor')]?.pricing, 'unknown');
    assert.deepEqual(entry.modelPreferences?.ghost, { visible: false });
    assert.deepEqual(entry.modelPreferences?.constructor, {});
    assert.equal((await editProviderConfig(path, read.revision, prepared.edits)).status, 'conflict');
    assert.equal(await readFile(path, 'utf8'), bytes);
    draft.api = 'not-a-protocol';
    const invalid = prepareProviderSetupSave(reread.config, draft);
    assert.equal(invalid.status, 'invalid');
    if (invalid.status === 'invalid') assert.ok(invalid.diagnostic.issues?.some(i => i.path.endsWith('/api')));
    assert.equal(await readFile(path, 'utf8'), bytes);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('identity guards, schema-derived protocols and scalar-only partial pricing', () => {
  const parsed = parseProviderConfig(fixture);
  assert.equal(parsed.status, 'valid');
  if (parsed.status !== 'valid') return;
  const list = resolveProviderModelList({ config: parsed.config, shipped: {
    custom: { models: {
      partial: { pricing: { input: 0 } }, unknown: {}, known: { pricing: { input: 1, output: 2 } },
      fullyKnown: { pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    } },
  } });
  const draft = createProviderSetupDraft(parsed.config, list, 'custom');
  assert.equal(draft.originalId, null);
  assert.equal(draft.models.find(m => m.id === 'partial')?.pricing.kind, 'partial');
  assert.equal(draft.models.find(m => m.id === 'partial')?.pricing.output, undefined);
  assert.equal(draft.models.find(m => m.id === 'known')?.pricing.kind, 'partial');
  assert.equal(draft.models.find(m => m.id === 'known')?.pricing.cacheRead, undefined);
  assert.equal(draft.models.find(m => m.id === 'unknown')?.pricing.kind, 'unknown');
  assert.deepEqual(draft.models.find(m => m.id === 'fullyKnown')?.pricing, {
    kind: 'known', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tiered: false,
  });
  const view = projectProviderSetupPreview(parsed.config, list, draft);
  assert.ok(view.protocols.includes('anthropic-messages'));
  assert.equal(view.providers.find(p => p.id === 'custom')?.configured, false);
  draft.id = 'constructor';
  assert.equal(prepareProviderSetupSave(parsed.config, draft).status, 'invalid');
  const existing = createProviderSetupDraft(parsed.config, list, '__proto__');
  existing.id = 'renamed';
  assert.equal(prepareProviderSetupSave(parsed.config, existing).status, 'invalid');
  const empty = createProviderSetupDraft(parsed.config, list);
  assert.equal(prepareProviderSetupSave(parsed.config, empty).status, 'invalid');
  empty.id = 'new';
  empty.credentialSource = 'environment';
  empty.environmentName = 'TOKEN_NAME';
  const prepared = prepareProviderSetupSave(parsed.config, empty);
  assert.equal(prepared.status, 'valid');
  if (prepared.status === 'valid') assert.deepEqual(prepared.config.providers.new.credentialRef, { source: 'environment', name: 'TOKEN_NAME' });
});
