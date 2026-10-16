import path from 'node:path';
import { parseModelPricing } from '../../model-providers/pricing/pricing-core';
import { approvedShippedRuntimeCatalog } from '../../model-providers/runtime/shipped-catalog';
import { availableProviderRuntimeModels } from '../../model-providers/runtime/services';
import { projectProviderRuntimeModels } from '../../model-providers/runtime/model-info';
import { currentProviderSelectorSnapshot } from '../../model-providers/runtime/selector-policy';
import type { RuntimeSnapshot } from '../../model-providers/runtime/contracts';
import type { SdkAuthStorage } from '../lib/sdk-integration/sdk';
import { saveProviderRuntimeProjection, readProviderRuntimeProjection, type NativeRuntimeModel, type ProviderRuntimeReference } from '../../model-providers/runtime';
import { resolveProviderConfigPaths, assertProviderManagementPathsOutsideGit } from '../../model-providers/catalog/provider-config-paths';
import { providerProtocolOptions, readProviderConfig, type ProviderApi } from '../../model-providers/catalog/provider-config';
import { createProviderManagementService } from '../../model-providers/management/service';
import type { ProviderManagementSnapshot } from '../../model-providers/management/contracts';
import type { ColdCoordinatorSdkModule } from '../lib/sdk-integration/sdk';

export interface ExistingProviderAuthority {
  auth: SdkAuthStorage;
  models: import('../lib/sdk-integration/sdk').SdkModelRegistry;
  /** Server-proved Pie-owned default private auth store, never an arbitrary supplied path. */
  canForgetCredential?: boolean;
}

export async function forgetExistingProviderCredential(authority: ExistingProviderAuthority, id: string): Promise<void> {
  if (!authority.canForgetCredential || !authority.auth.remove) throw new Error('Existing credential removal is unavailable');
  authority.auth.reload?.();
  if (authority.auth.drainErrors?.().length) throw new Error('Existing credential storage failed');
  // No environment, fallback keys or plugin stores are ever altered.
  if (!authority.auth.get?.(id)) return;
  authority.auth.remove(id);
  if (authority.auth.drainErrors?.().length) throw new Error('Existing credential storage failed');
}

export function captureExistingProviderConnections(authority: ExistingProviderAuthority) {
  authority.auth.reload?.();
  // Explicit allowlist: never pass native headers, auth, extensions or transport objects.
  const models = (authority.models.getAll?.() ?? []).map(model => ({ id: model.id, provider: model.provider,
    name: model.name ?? model.id, input: model.input, reasoning: model.reasoning,
    contextWindow: model.contextWindow, maxTokens: model.maxTokens, pricing: parseModelPricing(model.cost) }));
  const configured = new Set(authority.models.getConfiguredProviderIds?.() ?? []);
  const ids = new Set([...Object.keys(approvedShippedRuntimeCatalog()),
    ...(authority.auth.getOAuthProviders?.().map(provider => provider.id) ?? []),
    ...(authority.auth.list?.() ?? []), ...configured, ...models.map(model => model.provider)]);
  const rows: { id: string; modelCount: number; credentials: 'saved' | 'environment' | 'default' | 'none';
    models: import('../../model-providers/catalog/provider-model-resolution').ShippedProviderDefinition['models']; canForgetCredential: boolean }[] = [];
  for (const id of ids) {
    const status = authority.auth.getAuthStatus?.(id);
    const hasAuth = status?.configured || authority.auth.hasAuth?.(id)
      || models.some(model => model.provider === id && authority.models.hasConfiguredAuth?.(model));
    if (!(configured.has(id) || hasAuth)) continue;
    rows.push({ id, models: Object.fromEntries(models.filter(model => model.provider === id).map(({ provider: _provider, id: modelId, ...model }) => [modelId, model])),
      canForgetCredential: authority.canForgetCredential === true && !!authority.auth.remove && !!authority.auth.get?.(id), modelCount: new Set(models.filter(model => model.provider === id).map(model => model.id)).size,
      credentials: !hasAuth ? 'none' : status?.source === 'env' || status?.source === 'environment' ? 'environment' : status?.source === 'stored' || status?.source === 'oauth' || status?.source === 'api_key' ? 'saved' : 'default' });
  }
  if (authority.auth.drainErrors?.().length || authority.models.getError?.()) throw new Error('Existing metadata unavailable');
  return rows;
}

function isProviderApi(api: string): api is ProviderApi {
  return providerProtocolOptions.includes(api);
}

/** Missing settings retain legacy creation without constructing provider auth. */
export async function hasCoordinatorProviderConfiguration(): Promise<boolean> {
  const paths = resolveProviderConfigPaths({ configDir: process.env.PIE_PROVIDER_CONFIG_DIR });
  await assertProviderManagementPathsOutsideGit(paths);
  return (await readProviderConfig(paths.configFile)).status !== 'missing';
}

/** No config or credentials are touched until an explicitly validated private request. */
export async function createCoordinatorProviderManagement(
  sdk: ColdCoordinatorSdkModule,
  onSnapshot: (snapshot: ProviderManagementSnapshot) => void,
  legacy?: () => ExistingProviderAuthority,
) {
  const paths = resolveProviderConfigPaths({
    configDir: process.env.PIE_PROVIDER_CONFIG_DIR,
  });
  await assertProviderManagementPathsOutsideGit(paths);
  if (!sdk.createProviderManagementAuth) throw new Error('Provider management is unavailable.');
  const auth = sdk.createProviderManagementAuth(path.join(paths.configDir, 'credentials.json'));
  const existingCredentialAuthority = {
    forgetExistingCredential: legacy ? async (id: string) => forgetExistingProviderCredential(legacy(), id) : undefined,
  };
  const service = createProviderManagementService({ ...paths, auth, onSnapshot, ...existingCredentialAuthority,
    existingConnections: legacy ? () => captureExistingProviderConnections(legacy()) : undefined,
    readEnvironment: name => process.env[name],
    captureShippedCatalog: approvedShippedRuntimeCatalog,
    shipped: provider => ({ models: Object.fromEntries((sdk.getProviderManagementModels?.(provider) ?? [])
      .filter(model => model.provider === provider)
      .map(model => [model.id, { name: model.name, ...(isProviderApi(model.api) ? { api: model.api } : {}), baseUrl: model.baseUrl,
        input: model.input, reasoning: model.reasoning, contextWindow: model.contextWindow,
        maxTokens: model.maxTokens, pricing: parseModelPricing(model.cost) }])) }),
  });
  // Session captures are durable configuration, not disposable discovery cache.
  const artifactDir = path.join(paths.configDir, 'provider-runtime');
  const credentialFile = path.join(paths.configDir, 'credentials.json');
  const previewRuntimeProjection = (models: readonly NativeRuntimeModel[]) =>
    service.captureRuntimeProjection(models, () => models.flatMap(model => {
      const builtin = sdk.getProviderRuntimeBuiltinModel?.(model.provider, model.id);
      return builtin ? [builtin] : [];
    }));
  return { ...service,
    admittedRuntimeModels(snapshot: RuntimeSnapshot, legacyAuth?: SdkAuthStorage) {
      snapshot = currentProviderSelectorSnapshot(snapshot);
      const environment = sdk.AuthStorage.inMemory?.();
      const available = availableProviderRuntimeModels(snapshot, {
        credentialFile,
        savedCredential: id => {
          const native = sdk.AuthStorage.create(credentialFile);
          const credential = native.get?.(id);
          return native.drainErrors?.().length ? undefined : credential;
        },
        legacyHasAuth: id => legacyAuth?.hasAuth?.(id) ?? false,
        defaultHasAuth: id => environment?.hasAuth?.(id) ?? false,
      });
      return projectProviderRuntimeModels(snapshot, available);
    },
    previewRuntimeProjection,
    async captureRuntimeProjection(models: readonly NativeRuntimeModel[]) {
      const snapshot = await previewRuntimeProjection(models);
      return snapshot ? await saveProviderRuntimeProjection(artifactDir, snapshot) : undefined;
    },
    async readRuntimeProjection(reference: ProviderRuntimeReference) {
      return await readProviderRuntimeProjection(artifactDir, reference);
    },
    runtimeLocation(reference: ProviderRuntimeReference) { return { artifactDir, reference, credentialFile }; },
  };
}
