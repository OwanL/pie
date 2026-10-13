import type { SdkModule, SourceArtifactSdkModule } from '../../agent-processes/lib/sdk-integration/sdk';
import { createPiProviderAuth, isRuntimeCredentialScopeCurrent, type NativeAuthStorage } from '../management/pi-auth';
import type { StagedProviderCredential } from '../management/auth-port';
import type { CredentialSource, NativeRuntimeModel, RuntimeSnapshot } from './contracts';
import { builtinHeaderDigest, immutable, runtimeProtocols, validNativeModel } from './projection';

export interface RuntimeAuthStatus { configured: boolean; source?: string; label?: string }
/** Private structural facade consumed by the native registry/session. No credential DTO is published. */
export interface ProviderRuntimeAuthStorage {
  reload(): void;
  get(providerId: string): StagedProviderCredential | undefined;
  getAll(): Record<string, StagedProviderCredential>;
  getProviderEnv(providerId: string): Record<string, string> | undefined;
  getOAuthProviders(): { id: string; name: string }[];
  getApiKey(providerId: string, options?: { includeFallback?: boolean }): Promise<string | undefined>;
  hasAuth(providerId: string): boolean;
  getAuthStatus(providerId: string): RuntimeAuthStatus;
  drainErrors(): Error[];
}
export type RuntimeRequestAuth = { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }
  | { ok: false; error: string };
export interface ProviderRuntimeModelRegistry {
  readonly authStorage?: ProviderRuntimeAuthStorage;
  isModelEligibleForSubagent?(provider: string, id: string): boolean;
  find(provider: string, modelId: string): NativeRuntimeModel | undefined;
  getAll(): NativeRuntimeModel[];
  getAvailable(): NativeRuntimeModel[];
  refresh(): void;
  getError(): string | undefined;
  hasConfiguredAuth(model: Pick<NativeRuntimeModel, 'provider' | 'id'>): boolean;
  getApiKeyAndHeaders(model: Pick<NativeRuntimeModel, 'provider' | 'id'>): Promise<RuntimeRequestAuth>;
  getApiKeyForProvider(providerId: string): Promise<string | undefined>;
  isUsingOAuth(model: Pick<NativeRuntimeModel, 'provider' | 'id'>): boolean;
  getProviderAuthStatus(providerId: string): RuntimeAuthStatus;
  getProviderDisplayName?(providerId: string): string;
}
export interface ProviderRuntimeServices {
  authStorage: ProviderRuntimeAuthStorage;
  modelRegistry: ProviderRuntimeModelRegistry;
}
type NativeRuntimeAuth = ProviderRuntimeAuthStorage & NativeAuthStorage<NativeRuntimeModel>;
interface NativeRuntimeSdk {
  AuthStorage: { inMemory(): NativeRuntimeAuth; create(path: string): NativeRuntimeAuth };
  ModelRegistry?: {
    inMemory?(authStorage: ProviderRuntimeAuthStorage): ProviderRuntimeModelRegistry;
    create?(authStorage: unknown, modelsFile: string): ProviderRuntimeModelRegistry;
  };
}
const unavailable = () => new Error('Captured provider authentication is unavailable');
const modelUnavailable = () => new Error('Captured provider model is disabled, unsupported or unpriced');
const identity = (provider: string, id: string) => JSON.stringify([provider, id]);
function cloneRuntimeModel(model: NonNullable<RuntimeSnapshot['models'][number]['model']>): NativeRuntimeModel {
  return structuredClone({ ...model, input: [...model.input], cost: { ...model.cost },
    ...(model.headers ? { headers: { ...model.headers } } : {}),
    ...(model.compat ? { compat: { ...model.compat } } : {}),
    ...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}) });
}

/** Offline availability admission shared by cold catalogs and native runtime services.
 * Saved credentials are read only within the captured epoch; no key resolution or refresh occurs.
 */
export function availableProviderRuntimeModels(snapshot: RuntimeSnapshot, options: {
  credentialFile: string;
  savedCredential: (provider: string) => unknown;
  legacyHasAuth: (provider: string) => boolean;
  defaultHasAuth: (provider: string) => boolean;
}): NativeRuntimeModel[] {
  const hasAuth = (row: RuntimeSnapshot['models'][number]) => {
    const source = row.credential;
    if (source.source === 'legacy') return options.legacyHasAuth(row.providerId);
    if (source.source === 'environment') return !!process.env[source.name];
    if (source.source === 'default') return options.defaultHasAuth(row.providerId);
    if (source.source === 'none') {
      const models = snapshot.models.filter(candidate => candidate.providerId === row.providerId && candidate.model);
      return models.length > 0 && models.every(candidate => runtimeProtocols.includes(candidate.model!.api as typeof runtimeProtocols[number]));
    }
    if (source.source !== 'saved') return false;
    try {
      return isRuntimeCredentialScopeCurrent(options.credentialFile, row.providerId, source.scope)
        && !!options.savedCredential(row.providerId)
        && isRuntimeCredentialScopeCurrent(options.credentialFile, row.providerId, source.scope);
    } catch { return false; }
  };
  return snapshot.models.filter(row => row.enabled && row.visible && row.model && !row.rejection
    && validNativeModel(row.model) && hasAuth(row)).map(row => cloneRuntimeModel(row.model!));
}

/** Parent default/subagent capture admission. Visibility is a selector mask, not dispatch permission. */
export function assertProviderRuntimeModel(snapshot: RuntimeSnapshot, provider: string, id: string,
  options: { subagent?: boolean; visible?: boolean } = {}): NativeRuntimeModel {
  const row = snapshot.models.find(row => row.providerId === provider && row.id === id);
  if (!row?.enabled || !row.model || row.rejection || !validNativeModel(row.model)
    || (options.subagent && !row.subagentEligible) || (options.visible && !row.visible)) throw modelUnavailable();
  return cloneRuntimeModel(row.model);
}

/** Session-local facade around the verified native SDK engine. Never registers APIs globally,
 * reads legacy models.json, migrates credentials, or refreshes the captured model identities.
 * Undefined snapshots belong to the existing factory path; callers must not pass them here.
 */
export function createProviderRuntimeServices(
  sdk: SdkModule | SourceArtifactSdkModule,
  snapshot: RuntimeSnapshot,
  legacyAuthStorage: unknown,
  options: { credentialFile: string; legacyModelsFile?: string },
): ProviderRuntimeServices {
  const nativeSdk = sdk as unknown as NativeRuntimeSdk;
  if (!nativeSdk.AuthStorage?.inMemory || !nativeSdk.ModelRegistry?.inMemory) {
    throw new Error('Verified SDK lacks the native in-memory provider service API');
  }
  const broker = createPiProviderAuth(nativeSdk.AuthStorage, options.credentialFile);
  const environment = nativeSdk.AuthStorage.inMemory();
  const legacy = legacyAuthStorage as ProviderRuntimeAuthStorage;
  const captured = immutable(structuredClone(snapshot));
  const sources = new Map<string, CredentialSource>();
  for (const row of captured.models) {
    const source = row.credential as CredentialSource;
    const previous = sources.get(row.providerId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(source)) throw new Error('Conflicting captured credential policies');
    sources.set(row.providerId, source);
  }
  const policy = (id: string) => sources.get(id);
  const currentSaved = (id: string, source: Extract<CredentialSource, { source: 'saved' }>) => {
    try {
      if (!isRuntimeCredentialScopeCurrent(options.credentialFile, id, source.scope)) return undefined;
      const native = nativeSdk.AuthStorage.create(options.credentialFile) as NativeRuntimeAuth;
      const credential = native.get(id);
      if (native.drainErrors().length || !isRuntimeCredentialScopeCurrent(options.credentialFile, id, source.scope)) return undefined;
      return { native, credential };
    } catch { return undefined; }
  };
  const protocols = (id: string) => captured.models.filter(row => row.providerId === id && row.model).map(row => row.model!.api);
  const keyless = (id: string) => protocols(id).length > 0
    && protocols(id).every(api => runtimeProtocols.includes(api as typeof runtimeProtocols[number]));
  const authStorage: ProviderRuntimeAuthStorage = {
    reload() { if ([...sources.values()].some(source => source.source === 'legacy')) legacy?.reload?.(); },
    get(id) {
      const source = policy(id);
      if (source?.source === 'legacy') return legacy?.get?.(id);
      if (source?.source === 'saved') return currentSaved(id, source)?.credential;
      return undefined;
    },
    getAll() {
      const result: Record<string, StagedProviderCredential> = Object.create(null);
      for (const id of sources.keys()) { const value = authStorage.get(id); if (value) result[id] = value; }
      return result;
    },
    getProviderEnv(id) {
      const source = policy(id);
      if (source?.source === 'legacy') return legacy?.getProviderEnv?.(id);
      if (source?.source === 'saved') return currentSaved(id, source)?.native.getProviderEnv?.(id);
      if (source?.source === 'default') return environment.getProviderEnv?.(id);
      return undefined;
    },
    // Endpoints are already captured after native OAuth.modifyModels by the capture owner.
    // Suppress live modifyModels at native construction, but retain names/OAuth classification.
    getOAuthProviders() { return environment.getOAuthProviders().map(({ id, name }) => ({ id, name })); },
    async getApiKey(id, opts) {
      const source = policy(id);
      try {
        if (source?.source === 'legacy') return await legacy?.getApiKey?.(id, opts);
        if (source?.source === 'saved') {
          if (!source.scope) throw unavailable();
          const key = await broker.getRuntimeApiKey!(id, source.scope);
          if (!key) throw unavailable();
          return key;
        }
        if (source?.source === 'none') {
          if (!keyless(id)) throw unavailable();
          // Native OpenAI clients use "unused" for header/keyless-compatible requests.
          // Supplying it explicitly also prevents protocol engines looking up ambient keys.
          return 'unused';
        }
        if (source?.source === 'environment') {
          const key = process.env[source.name];
          if (!key) throw unavailable();
          return key;
        }
        if (source?.source === 'default') {
          // Empty native storage: only the SDK's native environment resolution, never saved/legacy.
          const key = await environment.getApiKey(id);
          if (!key) throw unavailable();
          return key;
        }
        throw unavailable();
      } catch { throw unavailable(); }
    },
    hasAuth(id) {
      const source = policy(id);
      if (source?.source === 'legacy') return legacy?.hasAuth?.(id) ?? false;
      if (source?.source === 'saved') return !!currentSaved(id, source)?.credential;
      if (source?.source === 'none') return keyless(id);
      if (source?.source === 'environment') return !!process.env[source.name];
      if (source?.source === 'default') return environment.hasAuth(id);
      return false;
    },
    getAuthStatus(id) {
      const source = policy(id);
      if (source?.source === 'legacy') return legacy?.getAuthStatus?.(id) ?? { configured: false };
      return { configured: authStorage.hasAuth(id), ...(source?.source === 'saved' ? { source: 'stored' }
        : source?.source === 'environment' || source?.source === 'default' ? { source: 'environment' } : {}) };
    },
    drainErrors() { return []; },
  };
  // Native construction keeps normal SDK API engine behavior without reading legacy models.json.
  const modelRegistry = nativeSdk.ModelRegistry.inMemory(authStorage);
  // SDK extensions may register providers on the exposed services registry. Keep
  // request composition on an unexposed native instance so those registrations
  // cannot replace the captured headers or introduce a different API-key source.
  const requestRegistry = nativeSdk.ModelRegistry.inMemory(authStorage);
  const nativeRequestAuth = requestRegistry.getApiKeyAndHeaders.bind(requestRegistry);
  // Unconfigured providers retain Pi's existing private models.json request
  // configuration. It is never copied into the managed snapshot or registered
  // on the exposed frozen registry.
  const legacyRequestRegistry = options.legacyModelsFile && [...sources.values()].some(source => source.source === 'legacy')
    ? nativeSdk.ModelRegistry.create?.(legacyAuthStorage, options.legacyModelsFile) : undefined;
  if (options.legacyModelsFile && [...sources.values()].some(source => source.source === 'legacy') && !legacyRequestRegistry) {
    throw new Error('Verified SDK lacks native legacy provider request resolution');
  }
  const rows = new Map(captured.models.map(row => [identity(row.providerId, row.id), row]));
  const admitted = (provider: string, id: string) => {
    const row = rows.get(identity(provider, id));
    return row?.enabled && row.model && !row.rejection && validNativeModel(row.model) ? row : undefined;
  };
  const privateModels = new Map<string, NativeRuntimeModel>();
  for (const row of captured.models) {
    if (!admitted(row.providerId, row.id)) continue;
    const proof = row.builtinHeaders;
    if (!proof) { privateModels.set(identity(row.providerId, row.id), row.model as NativeRuntimeModel); continue; }
    const builtin = sdk.getProviderRuntimeBuiltinModel?.(row.providerId, row.id);
    if (proof.provider !== row.providerId || proof.id !== row.id || !builtin
      || builtin.provider !== row.providerId || builtin.id !== row.id || builtinHeaderDigest(builtin) !== proof.sha256) {
      throw new Error('Captured builtin header definition is unavailable or changed');
    }
    privateModels.set(identity(row.providerId, row.id), immutable({ ...row.model!, headers: { ...builtin.headers! } }) as NativeRuntimeModel);
  }
  const model = (provider: string, id: string) => privateModels.get(identity(provider, id));
  modelRegistry.isModelEligibleForSubagent = (provider, id) => !!admitted(provider, id)?.subagentEligible;
  modelRegistry.find = model;
  modelRegistry.getAll = () => captured.models.filter(row => admitted(row.providerId, row.id)).map(row => model(row.providerId, row.id)!);
  modelRegistry.getAvailable = () => availableProviderRuntimeModels(captured, {
    credentialFile: options.credentialFile,
    savedCredential: id => currentSaved(id, policy(id) as Extract<CredentialSource, { source: 'saved' }>)?.credential,
    legacyHasAuth: id => legacy?.hasAuth?.(id) ?? false,
    defaultHasAuth: id => environment.hasAuth(id),
  }).map(value => model(value.provider, value.id)!);
  modelRegistry.refresh = () => { /* Frozen identities/policies; auth is resolved afresh per request. */ };
  modelRegistry.getError = () => undefined;
  modelRegistry.hasConfiguredAuth = value => !!model(value.provider, value.id) && authStorage.hasAuth(value.provider);
  modelRegistry.getApiKeyAndHeaders = async value => {
    const selected = model(value.provider, value.id);
    if (!selected) return { ok: false, error: modelUnavailable().message };
    try {
      // Use the captured definition, not caller-supplied endpoint/headers/cost, while retaining
      // native registry auth/header composition and OAuth engine token semantics.
      const legacyPolicy = policy(selected.provider)?.source === 'legacy';
      if (legacyPolicy && legacyRequestRegistry?.getError?.()) throw unavailable();
      const result = await (legacyPolicy && legacyRequestRegistry
        ? legacyRequestRegistry.getApiKeyAndHeaders(selected) : nativeRequestAuth(selected));
      if (legacyPolicy && result.ok) return result;
      return result.ok && result.apiKey ? result : { ok: false, error: unavailable().message };
    } catch { return { ok: false, error: unavailable().message }; }
  };
  modelRegistry.getApiKeyForProvider = id => authStorage.getApiKey(id);
  modelRegistry.getProviderAuthStatus = id => authStorage.getAuthStatus(id);
  modelRegistry.isUsingOAuth = value => !!model(value.provider, value.id) && authStorage.get(value.provider)?.type === 'oauth';
  return { authStorage, modelRegistry };
}
