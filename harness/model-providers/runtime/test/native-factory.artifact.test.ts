import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { verifyPiRuntimeArtifact, type GenerationPiRuntimeDescriptor, type PiRuntimeTarget } from '../../../../lib/pi-runtime/artifact.mjs';
import { loadSdk, type SdkModule } from '../../../agent-processes/lib/sdk-integration/sdk';
import { createRuntimeFactory, ServiceLoadingGate } from '../../../agent-processes/workers/runtime-factory';
import { editProviderConfig } from '../../catalog/provider-config-writer';
import { captureProviderRuntimeProjection } from '../projection';
import { createProviderRuntimeServices } from '../services';
import { appendProviderRuntimeReference, readProviderRuntimeReference, readProviderRuntimeProjection, saveProviderRuntimeProjection } from '../store';

const artifactRoot = process.env.PIE_PROVIDER_RUNTIME_ARTIFACT;
const target: PiRuntimeTarget = { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules };

test('native factory selects the captured private model and preserves durable thinking on idle reopen', {
  skip: !artifactRoot && 'requires PIE_PROVIDER_RUNTIME_ARTIFACT=<absolute verified runtime root>',
}, async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('unexpected network request in idle factory fixture'); }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  assert.ok(artifactRoot && path.isAbsolute(artifactRoot));
  const verified = await verifyPiRuntimeArtifact(artifactRoot, { target });
  const descriptor: GenerationPiRuntimeDescriptor = {
    schemaVersion: 1, artifactDir: verified.artifactDir, sdkPath: verified.sdkPath,
    cliPath: path.join(verified.sdkPath, 'dist/cli.js'), identity: verified.identity, manifest: verified.manifest,
  };
  // Keep the source policy facade intact: do not unwrap native classes/factories
  // or substitute a fake session to avoid ownership checks.
  const sdk = await loadSdk(verified.sdkPath, { mode: 'source-artifact', descriptor, backendTarget: target, surface: 'full' });
  const native = sdk as unknown as SdkModule;
  const root = await mkdtemp(path.join(os.tmpdir(), 'pie-native-factory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'workspace');
  const agentDir = path.join(root, 'agent');
  const sessionDir = path.join(root, 'sessions');
  await Promise.all([cwd, agentDir, sessionDir].map(dir => mkdir(dir, { recursive: true })));
  await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultThinkingLevel: 'high' }));
  const legacyAuth = sdk.AuthStorage.inMemory!({});
  const baseline = sdk.ModelRegistry!.inMemory!(legacyAuth).getAll().find(model =>
    model.provider === 'openai' && model.reasoning && Object.values(model.cost).some(rate => rate > 0));
  assert.ok(baseline, 'compiled SDK contains a priced reasoning OpenAI model');
  const builtin = sdk.getProviderRuntimeBuiltinModel!('openai', baseline.id);
  assert.ok(builtin, 'pricing proof comes from the verified compiled catalog');
  const configPath = path.join(root, 'config', 'providers.yaml');
  const saved = await editProviderConfig(configPath, null, [{ op: 'set', path: ['providers', 'openai'], value: {
    enabled: true, credentialRef: { source: 'none' }, baseUrl: 'https://captured.invalid/v1',
    modelOverrides: { [baseline.id]: { name: 'Captured private fixture', pricing: { input: 7, output: 11, cacheRead: 3, cacheWrite: 5 } } },
  } }]);
  assert.equal(saved.status, 'saved');
  if (saved.status !== 'saved') throw new Error('fixture config was not saved');
  const snapshot = captureProviderRuntimeProjection({ config: saved.config, configRevision: saved.revision,
    legacyModels: [baseline], builtinModels: [builtin] });
  assert.ok(snapshot);
  const artifacts = path.join(root, 'runtime-artifacts');
  const reference = await saveProviderRuntimeProjection(artifacts, snapshot);
  assert.equal(reference.sha256, createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'));
  const loaded = await readProviderRuntimeProjection(artifacts, reference);
  assert.deepEqual(loaded, snapshot);
  const expected = loaded.models.find(row => row.providerId === 'openai' && row.id === baseline.id)!.model!;
  assert.ok(expected);
  assert.equal(expected.baseUrl, 'https://captured.invalid/v1');
  assert.deepEqual(expected.cost, { input: 7, output: 11, cacheRead: 3, cacheWrite: 5 });

  const manager = native.SessionManager.create(cwd, sessionDir);
  appendProviderRuntimeReference(manager, reference);
  manager.appendModelChange('openai', baseline.id);
  manager.appendThinkingLevelChange('low');
  const sessionPath = manager.getSessionFile!();
  assert.ok(sessionPath);
  let calls = 0;
  let injected: ReturnType<typeof createProviderRuntimeServices> | undefined;
  const gate = new ServiceLoadingGate();
  t.after(() => gate.dispose());
  const factory = createRuntimeFactory(sdk, legacyAuth, cwd, gate, {
    providerServices: async ({ sessionManager }) => {
      calls++;
      assert.deepEqual(readProviderRuntimeReference(sessionManager), reference);
      injected = createProviderRuntimeServices(sdk, loaded, legacyAuth, { credentialFile: path.join(root, 'unused-auth.json') });
      assert.deepEqual(Object.keys(injected.authStorage.getAll()), []);
      assert.deepEqual(await injected.modelRegistry.getApiKeyAndHeaders(expected), { ok: true, apiKey: 'unused', env: undefined, headers: undefined });
      return injected;
    },
  });
  async function openIdle(sessionManager: typeof manager) {
    const runtime = await factory({ cwd, agentDir, sessionManager, sessionStartEvent: { type: 'session_start', reason: 'startup' } });
    const session = runtime.session as { model: typeof expected; thinkingLevel: string; messages: unknown[]; isStreaming: boolean; dispose(): void };
    try {
      assert.equal(runtime.services.modelRegistry, injected!.modelRegistry);
      assert.equal(runtime.services.authStorage, injected!.authStorage);
      assert.equal(session.model, injected!.modelRegistry.find('openai', baseline!.id));
      assert.deepEqual(session.model, expected);
      assert.equal(session.thinkingLevel, 'low');
      assert.equal(session.isStreaming, false);
      assert.deepEqual(session.messages, []);
      assert.equal(sessionManager.buildSessionContext!().thinkingLevel, 'low');
      assert.deepEqual(readProviderRuntimeReference(sessionManager), reference);
      assert.equal((runtime.services.settingsManager as { getDefaultThinkingLevel(): string }).getDefaultThinkingLevel(), 'high');
      return injected!.modelRegistry.getAll();
    } finally { session.dispose(); }
  }
  const catalog = await openIdle(manager);
  const changed = await editProviderConfig(configPath, saved.revision, [
    { op: 'set', path: ['providers', 'openai', 'enabled'], value: false },
    { op: 'set', path: ['providers', 'openai', 'baseUrl'], value: 'https://live-changed.invalid/v1' },
  ]);
  assert.equal(changed.status, 'saved');
  const reopened = native.SessionManager.open(sessionPath);
  assert.deepEqual(readProviderRuntimeReference(reopened), reference);
  assert.deepEqual(await openIdle(reopened), catalog, 'live saved edits cannot replace the original captured catalog');
  assert.equal(calls, 2);
  assert.deepEqual(await readProviderRuntimeProjection(artifacts, reference), loaded);
});
