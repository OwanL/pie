import path from 'node:path';
import { approvedShippedRuntimeCatalog } from '../../model-providers/runtime/shipped-catalog';
import { availableProviderRuntimeModels } from '../../model-providers/runtime/services';
import { projectProviderRuntimeModels } from '../../model-providers/runtime/model-info';
import type { RuntimeSnapshot } from '../../model-providers/runtime/contracts';
import type { SdkAuthStorage } from '../lib/sdk-integration/sdk';
import { saveProviderRuntimeProjection, readProviderRuntimeProjection, type NativeRuntimeModel, type ProviderRuntimeReference } from '../../model-providers/runtime';
import { resolveProviderConfigPaths, assertProviderManagementPathsOutsideGit } from '../../model-providers/catalog/provider-config-paths';
import { providerProtocolOptions, readProviderConfig, type ProviderApi } from '../../model-providers/catalog/provider-config';
import { createProviderManagementService } from '../../model-providers/management/service';
import type { ProviderManagementSnapshot } from '../../model-providers/management/contracts';
import type { ColdCoordinatorSdkModule } from '../lib/sdk-integration/sdk';

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
) {
  const paths = resolveProviderConfigPaths({
    configDir: process.env.PIE_PROVIDER_CONFIG_DIR,
  });
  await assertProviderManagementPathsOutsideGit(paths);
  if (!sdk.createProviderManagementAuth) throw new Error('Provider management is unavailable.');
  const auth = sdk.createProviderManagementAuth(path.join(paths.configDir, 'credentials.json'));
  const service = createProviderManagementService({ ...paths, auth, onSnapshot,
    readEnvironment: name => process.env[name],
    captureShippedCatalog: approvedShippedRuntimeCatalog,
    shipped: provider => ({ models: Object.fromEntries((sdk.getProviderManagementModels?.(provider) ?? [])
      .filter(model => model.provider === provider)
      .map(model => [model.id, { name: model.name, ...(isProviderApi(model.api) ? { api: model.api } : {}), baseUrl: model.baseUrl,
        input: model.input, reasoning: model.reasoning, contextWindow: model.contextWindow,
        maxTokens: model.maxTokens, pricing: model.cost }])) }),
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
