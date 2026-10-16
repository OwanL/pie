import { createHash } from 'node:crypto';
import { captureProviderRuntimeProjection, type NativeRuntimeModel } from '../runtime';
const fingerprint = (value: unknown): string => {
  const stable = (v: any): any => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
};
import { readProviderConfig, providerProtocolOptions, type ProviderConfig } from '../catalog/provider-config';
import { editProviderConfig } from '../catalog/provider-config-writer';
import { resolveProviderModelList, type ProviderCatalogSnapshot, type ShippedProviderDefinition } from '../catalog/provider-model-resolution';
import { createExistingProviderSetupDraft, createProviderSetupDraft, prepareProviderSetupSave } from './drafts';
import { discoverModels, normalizeOllamaBaseUrl, invalidateDiscoveryCache, loadDiscoveryCache, saveDiscoveryCache } from './discovery';
import type { ProviderManagementAuthPort, StagedProviderCredential } from './auth-port';
import type { ProviderManagementRequest, ProviderManagementResponse, ProviderManagementSnapshot, ProviderAuthPrompt } from './contracts';

export function createProviderManagementService(options: { configFile: string; modelCacheDir: string; auth: ProviderManagementAuthPort;
  existingConnections?: () => readonly { id: string; modelCount: number; credentials: 'saved' | 'environment' | 'default' | 'none';
    models?: ShippedProviderDefinition['models']; canForgetCredential?: boolean }[];
  /** Caller must prove this is Pie-owned native storage; never revoke remotely or mutate environment. */
  forgetExistingCredential?: (id: string) => Promise<void>;
  fetch?: typeof globalThis.fetch; readEnvironment?: (name: string) => string | undefined; now?: () => number;
  shipped?: (provider: string) => ShippedProviderDefinition | undefined;
  captureShippedCatalog?: () => Readonly<Record<string, ShippedProviderDefinition>>;
  invalidateCache?: typeof invalidateDiscoveryCache;
  onSnapshot?: (snapshot: ProviderManagementSnapshot) => void }) {
  const definitions = options.auth.definitions();
  let existing: NonNullable<ReturnType<NonNullable<typeof options.existingConnections>>> = [];
  const existingRow = (id: string) => existing.find(row => row.id === id);
  const inherited = (id: string) => !Object.hasOwn(config.providers, id) && !!existingRow(id);
  const legacyPolicy = (id: string) => inherited(id) || own(config.providers, id)?.credentialRef?.source === 'legacy';
  const settingsSupported = (id: string) => !!existingRow(id)?.models;
  const capabilities = (id: string) => ({ settings: !legacyPolicy(id) || settingsSupported(id),
    editConnection: !legacyPolicy(id), remove: loaded,
    forgetCredential: !!(options.auth.removeCredential && options.auth.hasSavedCredential(id))
      || !!(existingRow(id)?.canForgetCredential && options.forgetExistingCredential) });
  const refreshControllers = new Map<string, Map<AbortController, Promise<void>>>();
  let config: ProviderConfig = { version: 1, providers: {} }, configRevision: string | null = null;
  let loaded = false, revision = 0, error: string | undefined, auth: ProviderAuthPrompt | undefined, disposed = false;
  let mutation: ProviderManagementSnapshot['mutation'];
  let authBrowser: ProviderManagementSnapshot['authBrowser'];
  const discovered: Record<string, ProviderCatalogSnapshot> = Object.create(null);
  const discoveryProvenance: Record<string, string> = Object.create(null);
  const discoveryEpoch: Record<string, number> = Object.create(null);
  const states: Record<string, 'idle' | 'refreshing' | 'fresh' | 'cached' | 'error' | 'unsupported'> = Object.create(null);
  const operations = new Map<string, { intent: string; promise: Promise<ProviderManagementResponse>; controller: AbortController; providerId?: string }>();
  const prompts = new Map<string, { operationId: string; resolve: (value: string) => void; reject: () => void }>();
  let promptCounter = 0, activeLogin: string | undefined;
  const list = () => {
    const shipped: Record<string, ShippedProviderDefinition> = Object.create(null);
    for (const id of new Set([...Object.keys(config.providers), ...existing.map(row => row.id)])) {
      const definition = options.shipped?.(id);
      const native = existingRow(id)?.models;
      if (legacyPolicy(id) && native) shipped[id] = { models: native };
      else if (definition) shipped[id] = definition;
    }
    return resolveProviderModelList({ config, discovered, shipped });
  };
  const own = <T>(record: Record<string, T>, id: string): T | undefined => Object.hasOwn(record, id) ? record[id] : undefined;
  let daoTail: Promise<unknown> = Promise.resolve();
  const dao = <T>(work: () => Promise<T>): Promise<T> => {
    const next = daoTail.then(work, work); daoTail = next.catch(() => {}); return next;
  };
  const snapshot = (): ProviderManagementSnapshot => { const catalog = list(); return ({ revision, configRevision, loaded, definitions: structuredClone(definitions), protocols: providerProtocolOptions,
    providers: [...existing.filter(row => !Object.hasOwn(config.providers, row.id)).map(row => ({ id: row.id, modelCount: row.modelCount, credentials: row.credentials,
      name: definitions.find(d => d.id === row.id)?.name ?? row.id, origin: 'existing' as const, readOnly: !settingsSupported(row.id), capabilities: capabilities(row.id),
      configured: true, enabled: true, discovery: 'unsupported' as const })), ...Object.keys(config.providers).filter(id => !config.providers[id].removed).map((id): ProviderManagementSnapshot['providers'][number] => {
      const entry = Object.hasOwn(config.providers, id) ? config.providers[id] : undefined;
      const definition = definitions.find(d => d.id === id);
      let name = definition?.name ?? id;
      if (entry?.baseUrl && (!definition || id === 'other')) { try { name = new URL(entry.baseUrl).host; } catch { /* schema owns URL validation */ } }
      return { id, name, origin: legacyPolicy(id) ? 'existing' as const : 'managed' as const, readOnly: !capabilities(id).settings, capabilities: capabilities(id), configured: !!entry, enabled: entry?.enabled === true, modelCount: Object.keys(own(catalog.providers, id)?.models ?? {}).length,
        credentials: entry?.credentialRef?.source === 'legacy' ? existingRow(id)?.credentials ?? 'missing' : entry?.credentialRef?.source === 'none' ? 'none' : entry?.credentialRef?.source === 'environment' ? 'environment' : options.auth.hasSavedCredential(id) ? 'saved' : entry?.credentialRef?.source === 'saved' ? 'missing' : 'default',
        discovery: own(states, id) ?? (supported(id) === 'unsupported' ? 'unsupported' : 'idle') };
    })], ...(auth ? { auth: structuredClone(auth) } : {}), ...(authBrowser ? { authBrowser: { ...authBrowser } } : {}), ...(mutation ? { mutation: { ...mutation } } : {}), ...(error ? { error } : {}) }); };
  const publish = () => { revision++; try { options.onSnapshot?.(snapshot()); } catch { /* observer cannot fail an operation */ } };
  const result = (operationId: string, status: ProviderManagementResponse['status'], draft?: ProviderManagementResponse['draft']): ProviderManagementResponse => ({ operationId, status, snapshot: snapshot(), ...(draft ? { draft } : {}) });
  const supported = (id: string) => {
    if (legacyPolicy(id) || own(config.providers, id)?.removed) return 'unsupported';
    const definition = definitions.find(d => d.id === id);
    const api = own(config.providers, id)?.api;
    if (definition?.id === 'other') return api === 'openai-completions' || api === 'openai-responses' ? 'openai' : 'unsupported';
    return definition?.discovery ?? (api === 'openai-completions' || api === 'openai-responses' ? 'openai' : 'unsupported');
  };
  const provenance = (id: string) => {
    const entry = own(config.providers, id);
    const definition = definitions.find(d => d.id === id);
    return JSON.stringify({ api: entry?.api, baseUrl: definition?.discovery === 'ollama' && entry?.baseUrl ? normalizeOllamaBaseUrl(entry.baseUrl) : entry?.baseUrl, credentialRef: entry?.credentialRef,
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
      if (disposed || controller.signal.aborted || !own(config.providers, id)?.enabled || supported(id) === 'unsupported') return;
      states[id] = 'refreshing'; publish();
      timer = setTimeout(() => controller.abort(), 10_000);
      const effect = async () => {
        const entry = config.providers[id], definition = definitions.find(d => d.id === id);
        const key = definition?.discovery === 'ollama' ? undefined : entry.credentialRef?.source === 'environment' ? options.readEnvironment?.(entry.credentialRef.name)
          : entry.credentialRef?.source === 'saved' ? await options.auth.getApiKey(id) : undefined;
        const configuredBaseUrl = entry.baseUrl ?? definition?.baseUrl ?? '';
        const baseUrl = definition?.discovery !== 'ollama' && entry.credentialRef?.source === 'saved'
          ? await options.auth.discoveryBaseUrl(id, configuredBaseUrl) : configuredBaseUrl;
        return discoverModels({ kind: supported(id) as 'openai' | 'copilot' | 'ollama', baseUrl, key, fetch: options.fetch ?? globalThis.fetch, signal: controller.signal });
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
    try { existing = options.existingConnections?.() ?? []; }
    catch { loaded = false; error = 'Existing provider connections could not be loaded. Check authentication and model configuration.'; publish(); return false; }
    for (const id of Object.keys(discovered)) if (discoveryProvenance[id] !== provenance(id)) { delete discovered[id]; delete states[id]; delete discoveryProvenance[id]; }
    for (const id of Object.keys(config.providers)) {
      if (legacyPolicy(id) || config.providers[id].removed) continue;
      try {
        const stamp = provenance(id);
        const cached = await loadDiscoveryCache(options.modelCacheDir, id, stamp);
        if (cached && !own(discovered, id) && own(states, id) !== 'error' && stamp === provenance(id)) { discovered[id] = cached; discoveryProvenance[id] = stamp; states[id] = 'cached'; }
      } catch { states[id] = 'error'; error = 'Model cache could not be loaded. Refresh the provider to try again.'; }
    }
    publish(); return true;
  });
  const clearPrompts = (id: string) => {
    for (const [key, prompt] of prompts) if (prompt.operationId === id) { prompts.delete(key); prompt.reject(); }
  };
  const cancel = (id: string) => {
    operations.get(id)?.controller.abort();
    clearPrompts(id);
    if (activeLogin === id) { activeLogin = undefined; auth = undefined; authBrowser = undefined; publish(); }
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
    if (request.type === 'remove') {
      const response = await dao(async () => {
      if (disposed || controller.signal.aborted) return result(id, 'cancelled');
      if (request.expectedRevision !== configRevision) return result(id, 'conflict');
      const prior = own(config.providers, request.id);
      if (!prior && !existingRow(request.id) && ![...operations.entries()].some(([operationId, op]) => operationId !== id && op.providerId === request.id)) return result(id, 'conflict');
      mutation = { operationId: id, phase: 'saving' }; publish();
      try {
        const written = await editProviderConfig(options.configFile, request.expectedRevision,
          [{ op: 'set', path: ['providers', request.id], value: { enabled: false, removed: true } }]);
        if (written.status === 'conflict' || written.status === 'busy') return result(id, 'conflict');
        if (written.status !== 'saved' && written.status !== 'unchanged') {
          error = 'Provider removal could not be saved. Check configuration access and try again.'; publish(); return result(id, 'error');
        }
        // The policy commit is durable, not an atomic configuration/authentication transaction.
        config = written.config; configRevision = written.revision; error = undefined;
        discoveryEpoch[request.id] = (own(discoveryEpoch, request.id) ?? 0) + 1;
        for (const [operationId, operation] of operations) if (operationId !== id && operation.providerId === request.id) cancel(operationId);
        const refreshes = [...(refreshControllers.get(request.id)?.entries() ?? [])];
        for (const [refreshController] of refreshes) refreshController.abort();
        delete discovered[request.id]; delete discoveryProvenance[request.id]; delete states[request.id];
        publish();
        await Promise.all(refreshes.map(([, finished]) => finished));
        let partial = false;
        // The managed adapter revokes runtime scopes before deleting its canonical credential.
        // Never forget the native credential unless that first step succeeded.
        try {
          if (options.auth.removeCredential) await options.auth.removeCredential(request.id);
          else if (prior?.credentialRef?.source === 'saved' || options.auth.hasSavedCredential(request.id)) throw new Error('Removal unavailable');
          if (existingRow(request.id)?.canForgetCredential) {
            if (!options.forgetExistingCredential) throw new Error('Removal unavailable');
            await options.forgetExistingCredential(request.id);
          }
        } catch { partial = true; }
        try { await (options.invalidateCache ?? invalidateDiscoveryCache)(options.modelCacheDir, request.id); } catch { partial = true; }
        if (partial) error = 'Provider was removed from new chats, but credential or cache deletion is incomplete. Retry removal to finish. Existing chats may lose access to revoked credentials.';
        publish(); return result(id, partial ? 'error' : 'ok');
      } finally { mutation = undefined; publish(); }
      });
      return { ...response, snapshot: snapshot() };
    }
    if (request.type === 'read-provider' || request.type === 'refresh') {
      if (own(config.providers, request.id)?.removed) {
        if (request.type === 'refresh') return result(id, 'conflict');
        const available = { ...config, providers: { ...config.providers } }; delete available.providers[request.id];
        const draft = createProviderSetupDraft(available, resolveProviderModelList({ config: available }), request.id);
        const definition = definitions.find(d => d.id === request.id);
        if (definition) { draft.api = definition.api; draft.baseUrl = definition.baseUrl; }
        return result(id, 'ok', draft);
      }
      if (legacyPolicy(request.id)) {
        if (request.type === 'refresh' || !settingsSupported(request.id)) {
          error = request.type === 'refresh' ? 'Existing connections use native model metadata and do not support managed discovery.'
            : 'Existing model metadata is unavailable for a safe settings round trip. This connection can still be removed.';
          publish(); return result(id, 'conflict');
        }
        return result(id, 'ok', createExistingProviderSetupDraft(config, list(), request.id));
      }
    }
    if ((request.type === 'save' || request.type === 'connect') && legacyPolicy(request.draft.id)) {
      if (request.type === 'connect' || !settingsSupported(request.draft.id) || request.draft.originalId !== request.draft.id
        || request.draft.api !== '' || request.draft.baseUrl !== '' || request.draft.credentialSource !== 'legacy' || request.draft.environmentName !== ''
        || JSON.stringify(request.draft.manualModelIds) !== JSON.stringify(own(config.providers, request.draft.id)?.manualModels)) {
        error = 'Existing connections support model settings only; authentication, protocol and endpoints remain native. Remove and explicitly add the provider to replace the connection.';
        publish(); return result(id, 'conflict');
      }
    }
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
        activeLogin = id; auth = undefined; authBrowser = undefined;
        const current = () => !disposed && !controller.signal.aborted && activeLogin === id;
        const emit = (value: ProviderAuthPrompt) => { if (current()) {
          auth = value;
          if (value.kind === 'browser') authBrowser = { operationId: id, url: value.url, ...(value.instructions !== undefined ? { instructions: value.instructions } : {}) };
          if (value.kind === 'device') authBrowser = { operationId: id, url: value.url, code: value.code };
          publish();
        } };
        const prompt = (value: { kind: 'input'; message: string; placeholder?: string; allowEmpty?: boolean } | { kind: 'select'; message: string; options: { id: string; label: string }[] }) => {
          const pending = new Promise<string>((resolve, reject) => {
            if (!current()) { reject(new Error('Cancelled')); return; }
            const promptId = `${id}:${++promptCounter}`;
            prompts.set(promptId, { operationId: id, resolve, reject: () => reject(new Error('Cancelled')) });
            emit({ ...value, operationId: id, promptId });
          });
          // The SDK may complete a login without awaiting every optional prompt callback.
          void pending.catch(() => {});
          return pending;
        };
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
        } catch { if (activeLogin === id) { activeLogin = undefined; auth = undefined; authBrowser = undefined; publish(); } if (controller.signal.aborted) return result(id, 'cancelled'); error = 'Provider sign-in failed. Try again.'; publish(); return result(id, 'error'); }
        finally {
          clearPrompts(id);
          if (activeLogin === id) { activeLogin = undefined; auth = undefined; authBrowser = undefined; publish(); }
        }
      }
    }
    if (controller.signal.aborted || disposed) return result(id, 'cancelled');
    const response = await dao(async () => {
    if (controller.signal.aborted || disposed) return result(id, 'cancelled');
    if (request.expectedRevision !== configRevision) return result(id, 'conflict');
    const draft = request.type === 'connect' && request.method === 'local'
      ? { ...request.draft, credentialSource: 'none' as const, environmentName: '' }
      : credential ? { ...request.draft, credentialSource: 'saved' as const, environmentName: '' } : request.draft;
    if (draft.id === 'ollama' && !legacyPolicy(draft.id)) {
      if (draft.api !== 'openai-completions' || !['none', 'default'].includes(draft.credentialSource)) {
        error = 'Ollama uses the daemon connection and its existing sign-in, not API credentials.'; publish(); return result(id, 'error');
      }
      draft.baseUrl = normalizeOllamaBaseUrl(draft.baseUrl);
      draft.credentialSource = 'none';
    }
    const removed = own(config.providers, draft.id)?.removed;
    const explicitAdd = request.type === 'connect' && draft.originalId === null;
    if (removed && !explicitAdd) return result(id, 'conflict');
    if (!legacyPolicy(draft.id) && draft.credentialSource === 'legacy') return result(id, 'conflict');
    // Only explicit Add can replace a tombstone, at the successful writer commit below.
    const saveConfig = removed ? { ...config, providers: { ...config.providers } } : config;
    if (removed) delete saveConfig.providers[draft.id];
    const prepared = prepareProviderSetupSave(saveConfig, draft, { existingConnection: legacyPolicy(draft.id) });
    if (removed && prepared.status === 'valid') prepared.edits.unshift({ op: 'delete', path: ['providers', draft.id] });
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
          if (entry.removed || entry.credentialRef?.source === 'legacy') continue;
          const definition = definitions.find(d => d.id === id);
          const integration = definition ? { id: definition.id, discovery: definition.discovery }
            : entry.api === 'openai-completions' || entry.api === 'openai-responses' ? 'openai' : 'unsupported';
          const stamp = JSON.stringify({ api: entry.api, baseUrl: definition?.discovery === 'ollama' && entry.baseUrl ? normalizeOllamaBaseUrl(entry.baseUrl) : entry.baseUrl, credentialRef: entry.credentialRef, integration });
          const observed = await loadDiscoveryCache(options.modelCacheDir, id, stamp);
          if (observed) cached[id] = observed;
          if (definition?.discovery === 'ollama' && entry.baseUrl) {
            runtimeConfig.providers[id].baseUrl = normalizeOllamaBaseUrl(entry.baseUrl);
          }
          const nativeModels = runtimeModels.filter(model => model.provider === id);
          if (nativeModels.length && definition && definition.kind !== 'custom' && definition.kind !== 'ollama') {
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
          shippedCatalog: options.captureShippedCatalog?.(), discovered: cached, credentialScopes });
      });
    },
    request(request: ProviderManagementRequest): Promise<ProviderManagementResponse> {
      const intent = fingerprint(request);
      const existing = operations.get(request.operationId);
      if (existing) return existing.intent === intent ? existing.promise : Promise.resolve(result(request.operationId, 'conflict'));
      const controller = new AbortController();
      const input = structuredClone(request);
      const promise = Promise.resolve().then(() => execute(input, controller)).catch(() => { error = 'Provider operation failed. Check settings and try again.'; publish(); return result(request.operationId, 'error'); });
      const providerId = 'draft' in input ? input.draft.id : 'id' in input ? input.id : undefined;
      operations.set(request.operationId, { intent, promise, controller, providerId }); return promise;
    },
    dispose() { disposed = true; for (const controllers of refreshControllers.values()) for (const controller of controllers.keys()) controller.abort(); for (const id of operations.keys()) cancel(id); operations.clear(); while (queue.length) queue.shift()?.(); },
  };
}
