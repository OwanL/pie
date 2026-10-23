import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackendServer } from '../server';
import { createBackendAnalyticsFixture } from '../../test/fixtures/backend-analytics-context.js';
import { loadSdk } from '../../lib/sdk-integration/sdk';
import { sourceDescriptor, sourceLoadMode } from '../../lib/sdk-integration/test/source-fixture.js';
import { readProviderRuntimeReference, saveProviderRuntimeProjection, type NativeRuntimeModel } from '../../../model-providers/runtime';
import { createProviderManagementService } from '../../../model-providers/management/service';
import { createCoordinatorProviderManagement } from '../provider-management';

for (const mode of ['empty', 'admitted', 'legacy'] as const) {
  test(`actual coordinator cold creation preserves ${mode} model authority`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'pie-cold-admission-'));
    const analytics = createBackendAnalyticsFixture(root);
    const prior = process.env.PIE_PROVIDER_CONFIG_DIR;
    process.env.PIE_PROVIDER_CONFIG_DIR = root;
    const sdkPath = sourceDescriptor.sdkPath;
    const server = new BackendServer({ analyticsContext: analytics.context, hostPid: analytics.hostPid, sdkPath, sourceArtifactDescriptor: sourceDescriptor, cwd: root, workerEntryPath: '/unused-worker.js' }) as any;
    try {
      await mkdir(join(root, 'sessions'));
      if (mode !== 'legacy') await writeFile(join(root, 'providers.yaml'), 'version: 1\nproviders:\n  openai:\n    enabled: true\n');
      server.sdk = await loadSdk(sdkPath, { ...sourceLoadMode, surface: 'cold' });
      // Retain the real durable manager while isolating atomic publication from
      // the installed artifact's Windows rename implementation.
      const SessionManager = server.sdk.SessionManager;
      server.sdk = { ...server.sdk, SessionManager: { open: SessionManager.open.bind(SessionManager), listAll: SessionManager.listAll.bind(SessionManager),
        create: (...args: any[]) => {
          const manager = SessionManager.create(...args) as any;
          manager.preparePieModelSettingsChange = (provider: string, id: string) => ({
            commit: () => { manager.appendModelChange(provider, id); return {}; }, dispose: () => undefined,
          });
          return manager;
        },
      } };
      server.agentDir = root;
      server.analyticsAuthority.openWriterAdmission();
      server.sessionDir = join(root, 'sessions');
      server.sessionDirResolved = true;
      server.readModelSettings = async () => ({ defaultModel: 'global', defaultProvider: 'outside', defaultThinkingLevel: 'medium' });
      let opened: any;
      server.emit = (event: string, payload: unknown) => { if (event === 'session.opened') opened = payload; };
      server.emitSessionListChanged = async () => undefined;
      server.deferSessionPromptInventory = () => undefined;
      const candidate: NativeRuntimeModel = { provider: 'openai', id: 'admitted', name: 'Admitted', api: 'openai-completions', baseUrl: 'https://synthetic.invalid', input: ['text'], reasoning: false, contextWindow: 8192, maxTokens: 1024, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } };
      server.modelRegistry = { getAll: () => [candidate], getAvailable: () => [] };
      server.authStorage = { hasAuth: () => mode === 'admitted' };
      server.sdk = { ...server.sdk,
        AuthStorage: { createAsync: async () => ({ get: () => undefined }), inMemory: () => ({ hasAuth: () => mode === 'admitted' }) },
        getProviderRuntimeBuiltinModel: () => candidate,
        createProviderManagementAuth: () => ({ definitions: () => [], listSavedCredentialIds: async () => [] }),
      };
      if (mode !== 'legacy') {
        // Keep production's shipped authority enabled; this synthetic fixture
        // supplies its own explicit catalog through the management service seam.
        const coordinator = await createCoordinatorProviderManagement(server.sdk, () => undefined);
        const service = createProviderManagementService({
          configFile: join(root, 'providers.yaml'), modelCacheDir: join(root, 'model-cache'),
          auth: server.sdk.createProviderManagementAuth(), captureShippedCatalog: () => ({}),
        });
        const previewRuntimeProjection = (models: readonly NativeRuntimeModel[]) => service.captureRuntimeProjection(models, () => [candidate]);
        server.providerManagementPromise = Promise.resolve({ ...coordinator, ...service, previewRuntimeProjection,
          captureRuntimeProjection: async (models: readonly NativeRuntimeModel[]) => {
            const snapshot = await previewRuntimeProjection(models);
            return snapshot ? saveProviderRuntimeProjection(join(root, 'provider-runtime'), snapshot) : undefined;
          },
          dispose: () => { service.dispose(); coordinator.dispose(); },
        });
      }
      await server.handleRequest({ v: 1, id: 'membership', method: 'session.liveMembership', params: { revision: 1, timestamp: Date.now(), sessions: [], closing: [] } });
      await server.titleNamespaceHydration;
      const created = await server.handleRequest({ v: 1, id: 'create', method: 'session.create', params: { cwd: root, selectionToken: 'selection' } });
      const manager = server.sdk.SessionManager.open(created.sessionPath);
      assert.equal(Boolean(readProviderRuntimeReference(manager)), mode !== 'legacy');
      const context = manager.buildSessionContext();
      assert.deepEqual(context.model, mode === 'admitted' ? { provider: candidate.provider, modelId: candidate.id } : null);
      await server.handleRequest({ v: 1, id: 'open', method: 'session.open', params: { sessionPath: created.sessionPath } });
      assert.equal(opened.modelSettings.defaultModel, mode === 'empty' ? '' : mode === 'admitted' ? candidate.id : 'global');
      assert.equal(opened.session.modelId, mode === 'admitted' ? candidate.id : undefined);
    } finally {
      await Promise.all([...server.pendingOpenedTitleAdmissions.values()]);
      await server.titleAdmission;
      await server.dispose();
      analytics.close();
      if (prior === undefined) delete process.env.PIE_PROVIDER_CONFIG_DIR; else process.env.PIE_PROVIDER_CONFIG_DIR = prior;
      await rm(root, { recursive: true, force: true });
    }
  });
}
