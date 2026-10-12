import { createHash } from 'node:crypto';
import { captureProviderRuntimeProjection, type NativeRuntimeModel } from '../runtime';
const fingerprint = (value: unknown): string => {
  const stable = (v: any): any => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
};
import { readProviderConfig, providerProtocolOptions, type ProviderConfig } from '../catalog/provider-config';
import { editProviderConfig } from '../catalog/provider-config-writer';
import { resolveProviderModelList, type ProviderCatalogSnapshot } from '../catalog/provider-model-resolution';
import { createProviderSetupDraft, prepareProviderSetupSave } from './drafts';
import { discoverModels, invalidateDiscoveryCache, loadDiscoveryCache, saveDiscoveryCache } from './discovery';
import type { ProviderManagementAuthPort, StagedProviderCredential } from './auth-port';
import type { ProviderManagementRequest, ProviderManagementResponse, ProviderManagementSnapshot, ProviderAuthPrompt } from './contracts';

export function createProviderManagementService(options: { configFile: string; modelCacheDir: string; auth: ProviderManagementAuthPort;
  fetch?: typeof globalThis.fetch; readEnvironment?: (name: string) => string | undefined; now?: () => number;
  invalidateCache?: typeof invalidateDiscoveryCache;
  onSnapshot?: (snapshot: ProviderManagementSnapshot) => void }) {
  const definitions = options.auth.definitions();
  const refreshControllers = new Map<string, Map<AbortController, Promise<void>>>();
  let config: ProviderConfig = { version: 1, providers: {} }, configRevision: string | null = null;
  let loaded = false, revision = 0, error: string | undefined, auth: ProviderAuthPrompt | undefined, disposed = false;
  let mutation: ProviderManagementSnapshot['mutation'];
  const discovered: Record<string, ProviderCatalogSnapshot> = Object.create(null);
  const discoveryProvenance: Record<string, string> = Object.create(null);
  const discoveryEpoch: Record<string, number> = Object.create(null);
  const states: Record<string, 'idle' | 'refreshing' | 'fresh' | 'cached' | 'error' | 'unsupported'> = Object.create(null);
  const operations = new Map<string, { intent: string; promise: Promise<ProviderManagementResponse>; controller: AbortController }>();
  const prompts = new Map<string, { operationId: string; resolve: (value: string) => void; reject: () => void }>();
  let promptCounter = 0, activeLogin: string | undefined;
  const list = () => resolveProviderModelList({ config, discovered });
  const own = <T>(record: Record<string, T>, id: string): T | undefined => Object.hasOwn(record, id) ? record[id] : undefined;
  let daoTail: Promise<unknown> = Promise.resolve();
  const dao = <T>(work: () => Promise<T>): Promise<T> => {
    const next = daoTail.then(work, work); daoTail = next.catch(() => {}); return next;
  };
  const snapshot = (): ProviderManagementSnapshot => { const catalog = list(); return ({ revision, configRevision, loaded, definitions: structuredClone(definitions), protocols: providerProtocolOptions,
    providers: Object.keys(config.providers).map(id => {
      const entry = Object.hasOwn(config.providers, id) ? config.providers[id] : undefined;
      const definition = definitions.find(d => d.id === id);
      let name = definition?.name ?? id;
      if (entry?.baseUrl && (!definition || id === 'other')) { try { name = new URL(entry.baseUrl).host; } catch { /* schema owns URL validation */ } }
      return { id, name, configured: !!entry, enabled: entry?.enabled === true, modelCount: Object.keys(own(catalog.providers, id)?.models ?? {}).length,
        credentials: entry?.credentialRef?.source === 'none' ? 'none' : entry?.credentialRef?.source === 'environment' ? 'environment' : options.auth.hasSavedCredential(id) ? 'saved' : entry?.credentialRef?.source === 'saved' ? 'missing' : 'default',
        discovery: own(states, id) ?? (supported(id) === 'unsupported' ? 'unsupported' : 'idle') };
    }), ...(auth ? { auth: structuredClone(auth) } : {}), ...(mutation ? { mutation: { ...mutation } } : {}), ...(error ? { error } : {}) }); };
  const publish = () => { revision++; try { options.onSnapshot?.(snapshot()); } catch { /* observer cannot fail an operation */ } };
  const result = (operationId: string, status: ProviderManagementResponse['status'], draft?: ProviderManagementResponse['draft']): ProviderManagementResponse => ({ operationId, status, snapshot: snapshot(), ...(draft ? { draft } : {}) });
  const supported = (id: string) => {
    const definition = definitions.find(d => d.id === id);
    const api = own(config.providers, id)?.api;
    if (definition?.id === 'other') return api === 'openai-completions' || api === 'openai-responses' ? 'openai' : 'unsupported';
    return definition?.discovery ?? (api === 'openai-completions' || api === 'openai-responses' ? 'openai' : 'unsupported');
  };
  const provenance = (id: string) => {
    const entry = own(config.providers, id);
    const definition = definitions.find(d => d.id === id);
    return JSON.stringify({ api: entry?.api, baseUrl: entry?.baseUrl, credentialRef: entry?.credentialRef,
      integration: definition ? { id: definition.id, discovery: definition.discovery } : supported(id) });
  };
  let running = 0;
  const queue: (() => void)[] = [];
  const acquire = async () => { if (running >= 3) await new Promise<void>(r => queue.push(r)); else running++; };
  const refresh = async (id: string, controller: AbortController) => {
    if (!own(config.providers, id)?.enabled || supported(id) === 'unsupported') { states[id] = 'unsupported'; publish(); return; }
    const epoch = own(discoveryEpoch, id) ?? 0;
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const controllers = refreshControllers.get(id) ?? new Map<AbortController, Promise<void>>();
    controllers.set(controller, finished); refreshControllers.set(id, controllers);
    await acquire();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stamp = provenance(id);
    try {
      if (disposed || controller.signal.aborted) return;
      states[id] = 'refreshing'; publish();
      timer = setTimeout(() => controller.abort(), 10_000);
      const effect = async () => {
        const entry = config.providers[id], definition = definitions.find(d => d.id === id);
        const key = entry.credentialRef?.source === 'environment' ? options.readEnvironment?.(entry.credentialRef.name)
          : entry.credentialRef?.source === 'saved' ? await options.auth.getApiKey(id) : undefined;
        const configuredBaseUrl = entry.baseUrl ?? definition?.baseUrl ?? '';
        const baseUrl = entry.credentialRef?.source === 'saved'
          ? await options.auth.discoveryBaseUrl(id, configuredBaseUrl) : configuredBaseUrl;
        return discoverModels({ kind: supported(id) as 'openai' | 'copilot', baseUrl, key, fetch: options.fetch ?? globalThis.fetch, signal: controller.signal });
      };
      const observed = await Promise.race([effect(), new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }))]);
      if (disposed || controller.signal.aborted || epoch !== (own(discoveryEpoch, id) ?? 0) || stamp !== provenance(id)) return;
      discovered[id] = observed; discoveryProvenance[id] = stamp; states[id] = 'fresh'; publish();
      try { await saveDiscoveryCache(options.modelCacheDir, id, stamp, observed, (options.now ?? Date.now)()); } catch { /* usable in-memory observation remains fresh */ }
    } catch { if (!disposed && epoch === (own(discoveryEpoch, id) ?? 0) && stamp === provenance(id)) { states[id] = 'error'; publish(); } }
    finally {
      finish(); controllers.delete(controller); if (controllers.size === 0) refreshControllers.delete(id);
      if (timer) clearTimeout(timer); const next = queue.shift(); if (next) next(); else running--;
    }
  };
  const automatic = () => { for (const id of Object.keys(config.providers)) if (config.providers[id].enabled && supported(id) !== 'unsupported') void refresh(id, new AbortController()); };
  const load = () => dao(async () => {
    const read = await readProviderConfig(options.configFile);
    if (read.status !== 'valid' && read.status !== 'missing') { loaded = false; error = 'Provider configuration could not be loaded. Check file access and version 1 YAML syntax.'; publish(); return false; }
    config = read.config; configRevision = read.revision; loaded = true; error = undefined;
    for (const id of Object.keys(discovered)) if (discoveryProvenance[id] !== provenance(id)) { delete discovered[id]; delete states[id]; delete discoveryProvenance[id]; }
    for (const id of Object.keys(config.providers)) {
      try {
        const stamp = provenance(id);
        const cached = await loadDiscoveryCache(options.modelCacheDir, id, stamp);
        if (cached && !own(discovered, id) && own(states, id) !== 'error' && stamp === provenance(id)) { discovered[id] = cached; discoveryProvenance[id] = stamp; states[id] = 'cached'; }
      } catch { states[id] = 'error'; error = 'Model cache could not be loaded. Refresh the provider to try again.'; }
    }
    publish(); return true;
  });
  const cancel = (id: string) => {
    operations.get(id)?.controller.abort();
    for (const [key, prompt] of prompts) if (prompt.operationId === id) { prompts.delete(key); prompt.reject(); }
    if (activeLogin === id) { activeLogin = undefined; auth = undefined; publish(); }
  };
  const execute = async (request: ProviderManagementRequest, controller: AbortController): Promise<ProviderManagementResponse> => {
    const id = request.operationId;
    if (disposed) return result(id, 'cancelled');
    if (request.type === 'cancel') {
      if (mutation?.operationId === request.targetOperationId) return result(id, 'conflict');
      cancel(request.targetOperationId); return result(id, 'ok');
    }
    if (request.type === 'auth-response') {
      const pending = prompts.get(request.promptId);
      if (!pending || pending.operationId !== request.targetOperationId) return result(id, 'error');
      prompts.delete(request.promptId); pending.resolve(request.value); return result(id, 'ok');
    }
    if (!(await load())) return result(id, 'error');
    if (disposed || controller.signal.aborted) return result(id, 'cancelled');
    if (request.type === 'read') { automatic(); return result(id, 'ok'); }
    if (request.type === 'read-provider') {
      const draft = createProviderSetupDraft(config, list(), request.id);
      const definition = definitions.find(d => d.id === request.id);
      if (draft.originalId === null && definition) { draft.api = definition.api; draft.baseUrl = definition.baseUrl; }
      return result(id, 'ok', draft);
    }
    if (request.type === 'refresh') { await refresh(request.id, controller); return result(id, controller.signal.aborted ? 'cancelled' : own(states, request.id) === 'error' ? 'error' : 'ok', createProviderSetupDraft(config, list(), request.id)); }
    let credential: StagedProviderCredential | undefined;
    if (request.type === 'connect') {
      const definition = definitions.find(d => d.id === request.draft.id);
        const compatibleCustom = !definition && (request.method === 'api-key' || request.method === 'local')
        && providerProtocolOptions.includes(request.draft.api) && (() => {
          try { const endpoint = new URL(request.draft.baseUrl); return ['http:', 'https:'].includes(endpoint.protocol) && !!endpoint.hostname; }
          catch { return false; }
        })();
      if (!(definition?.authMethods.includes(request.method) || compatibleCustom)) { error = 'This connection method is not supported by the provider.'; publish(); return result(id, 'error'); }
      if (activeLogin) return result(id, 'conflict');
      if (request.method === 'api-key') {
        if (!request.apiKey?.trim()) { error = 'Enter an API key.'; publish(); return result(id, 'error'); }
        credential = { type: 'api_key', key: request.apiKey };
      } else if (request.method === 'oauth') {
        activeLogin = id;
        const current = () => !disposed && !controller.signal.aborted && activeLogin === id;
        const emit = (value: ProviderAuthPrompt) => { if (current()) { auth = value; publish(); } };
        const prompt = (value: { kind: 'input'; message: string; placeholder?: string; allowEmpty?: boolean } | { kind: 'select'; message: string; options: { id: string; label: string }[] }) => new Promise<string>((resolve, reject) => {
          if (!current()) { reject(new Error('Cancelled')); return; }
          const promptId = `${id}:${++promptCounter}`;
          prompts.set(promptId, { operationId: id, resolve, reject: () => reject(new Error('Cancelled')) });
          emit({ ...value, operationId: id, promptId });
        });
        try {
          const staged = options.auth.stageOAuthLogin(request.draft.id, { signal: controller.signal,
            onAuth: value => emit({ kind: 'browser', operationId: id, url: value.url, ...(value.instructions !== undefined ? { instructions: value.instructions } : {}) }),
            onDeviceCode: value => emit({ kind: 'device', operationId: id, url: value.verificationUri, code: value.userCode }),
            onPrompt: value => prompt({ kind: 'input', message: value.message,
              ...(value.placeholder !== undefined ? { placeholder: value.placeholder } : {}), ...(value.allowEmpty !== undefined ? { allowEmpty: value.allowEmpty } : {}) }),
            onSelect: value => prompt({ kind: 'select', message: value.message, options: value.options.map(option => ({ id: option.id, label: option.label })) }),
            onManualCodeInput: () => prompt({ kind: 'input', message: 'Enter the authorization code.' }),
            onProgress: () => emit({ kind: 'progress', operationId: id, message: 'Connecting to provider…' }) });
          credential = await Promise.race([staged, new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }))]);
          if (!current()) return result(id, 'cancelled');
        } catch { if (controller.signal.aborted) return result(id, 'cancelled'); error = 'Provider sign-in failed. Try again.'; publish(); return result(id, 'error'); }
        finally { if (activeLogin === id) { activeLogin = undefined; auth = undefined; publish(); } }
      }
    }
    if (controller.signal.aborted || disposed) return result(id, 'cancelled');
    const response = await dao(async () => {
    if (controller.signal.aborted || disposed) return result(id, 'cancelled');
    if (request.expectedRevision !== configRevision) return result(id, 'conflict');
    const draft = request.type === 'connect' && request.method === 'local'
      ? { ...request.draft, credentialSource: 'none' as const, environmentName: '' }
      : credential ? { ...request.draft, credentialSource: 'saved' as const, environmentName: '' } : request.draft;
    const prepared = prepareProviderSetupSave(config, draft);
    if (prepared.status !== 'valid') { error = 'Provider settings are invalid. Check identity, endpoint and model settings.'; publish(); return result(id, 'error'); }
    mutation = { operationId: id, phase: 'saving' }; publish();
    try {
    const written = await editProviderConfig(options.configFile, request.expectedRevision, prepared.edits);
    if (written.status === 'conflict' || written.status === 'busy') return result(id, 'conflict');
    if (written.status !== 'saved' && written.status !== 'unchanged') { error = 'Provider configuration could not be saved. Check file access and settings.'; publish(); return result(id, 'error'); }
    config = written.config; configRevision = written.revision; error = undefined;
    if (credential) {
      if (controller.signal.aborted || disposed) { error = 'Configuration was saved, but credentials were not saved because the operation was cancelled.'; publish(); return result(id, 'cancelled'); }
      discoveryEpoch[draft.id] = (own(discoveryEpoch, draft.id) ?? 0) + 1;
      const priorRefreshes = [...(refreshControllers.get(draft.id)?.entries() ?? [])];
      for (const [controller] of priorRefreshes) controller.abort();
      await Promise.all(priorRefreshes.map(([, finished]) => finished));
      try { await (options.invalidateCache ?? invalidateDiscoveryCache)(options.modelCacheDir, draft.id); }
      catch { states[draft.id] = 'error'; error = 'Configuration saved, but new credentials were not saved because the previous model cache could not be cleared. Check cache access and reconnect.'; publish(); return result(id, 'error'); }
      delete discovered[draft.id]; delete discoveryProvenance[draft.id]; delete states[draft.id];
      if (controller.signal.aborted || disposed) { error = 'Configuration was saved, but credentials were not saved because the operation was cancelled.'; publish(); return result(id, 'cancelled'); }
      try { await options.auth.saveCredential(draft.id, credential); }
      catch { error = 'Configuration was saved, but credentials could not be saved. Reconnect the provider.'; publish(); return result(id, 'error'); }
    }
    if (controller.signal.aborted || disposed) { error = 'Configuration was saved, but the operation was cancelled. Review the provider settings.'; publish(); return result(id, 'cancelled'); }
    publish(); if (request.type === 'connect') automatic(); return result(id, 'ok');
    } finally { mutation = undefined; publish(); }
    });
    return { ...response, snapshot: snapshot() };
  };
  return {
    /** Private offline capture: never publishes, logs in, refreshes or loads management state. */
    captureRuntimeProjection(legacyModels: readonly NativeRuntimeModel[], builtinModels: readonly NativeRuntimeModel[] | (() => readonly NativeRuntimeModel[]) = []) {
      return dao(async () => {
        if (disposed) throw new Error('Provider management is unavailable');
        const read = await readProviderConfig(options.configFile);
        if (read.status === 'missing') return undefined;
        if (read.status !== 'valid') throw new Error('Provider configuration could not be captured');
        const cached: Record<string, ProviderCatalogSnapshot> = Object.create(null);
        const credentialScopes: Record<string, string> = Object.create(null);
        const runtimeConfig = structuredClone(read.config);
        let runtimeModels = legacyModels.map(model => structuredClone(model));
        for (const [id, entry] of Object.entries(read.config.providers)) {
          const definition = definitions.find(d => d.id === id);
          const integration = definition ? { id: definition.id, discovery: definition.discovery }
            : entry.api === 'openai-completions' || entry.api === 'openai-responses' ? 'openai' : 'unsupported';
          const stamp = JSON.stringify({ api: entry.api, baseUrl: entry.baseUrl, credentialRef: entry.credentialRef, integration });
          const observed = await loadDiscoveryCache(options.modelCacheDir, id, stamp);
          if (observed) cached[id] = observed;
          const nativeModels = runtimeModels.filter(model => model.provider === id);
          if (nativeModels.length && definition && definition.kind !== 'custom') {
            // Saved native template defaults are not per-model overrides. Native models
            // can use different protocols, and OAuth can select an account-specific endpoint.
            if (entry.api === definition.api) delete runtimeConfig.providers[id].api;
            if (entry.baseUrl === definition.baseUrl) delete runtimeConfig.providers[id].baseUrl;
          }
          if (entry.enabled && entry.credentialRef?.source === 'saved') {
            const scope = await options.auth.getRuntimeCredentialScope?.(id);
            if (scope !== undefined) credentialScopes[id] = scope;
            if (scope && options.auth.runtimeModels) {
              const adjusted = await options.auth.runtimeModels(id, nativeModels);
              if (adjusted.some(model => model.provider !== id)
                || await options.auth.getRuntimeCredentialScope?.(id) !== scope) {
                throw new Error('Provider credentials changed during capture');
              }
              runtimeModels = runtimeModels.filter(model => model.provider !== id).concat(adjusted);
            }
          }
        }
        return captureProviderRuntimeProjection({ config: runtimeConfig, configRevision: read.revision!, legacyModels: runtimeModels,
          builtinModels: typeof builtinModels === 'function' ? builtinModels() : builtinModels,
          discovered: cached, credentialScopes });
      });
    },
    request(request: ProviderManagementRequest): Promise<ProviderManagementResponse> {
      const intent = fingerprint(request);
      const existing = operations.get(request.operationId);
      if (existing) return existing.intent === intent ? existing.promise : Promise.resolve(result(request.operationId, 'conflict'));
      const controller = new AbortController();
      const input = structuredClone(request);
      const promise = Promise.resolve().then(() => execute(input, controller)).catch(() => { error = 'Provider operation failed. Check settings and try again.'; publish(); return result(request.operationId, 'error'); });
      operations.set(request.operationId, { intent, promise, controller }); return promise;
    },
    dispose() { disposed = true; for (const controllers of refreshControllers.values()) for (const controller of controllers.keys()) controller.abort(); for (const id of operations.keys()) cancel(id); operations.clear(); while (queue.length) queue.shift()?.(); },
  };
}
